import express from "express";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { validateResponse, SALES_SYSTEM_INSTRUCTIONS } from "./lbv-sales-copilot/lib/sales-context.js";
import { evaluateTest, AdversarialTestCase, TestResult, BYPASS_REGRESSION_TESTS, POSITIVE_CONTROLS } from "./lbv-sales-copilot/lib/adversarial-runner.js";

dotenv.config();

const isProd = process.env.NODE_ENV === "production";
const app = express();
app.use(express.json());

// Initialize Gemini client on the server with recommended headers
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      "User-Agent": "aistudio-build",
    },
  },
});

// Helper to load static JSON files safely
const loadJson = (relativeFilePath: string) => {
  try {
    const fullPath = path.resolve(relativeFilePath);
    return JSON.parse(fs.readFileSync(fullPath, "utf-8"));
  } catch (error) {
    console.error(`Error loading JSON file at ${relativeFilePath}:`, error);
    return null;
  }
};

// Expose static test data and scenarios to the UI
app.get("/api/test-prospect", (req, res) => {
  const data = loadJson("./lbv-sales-copilot/sales-api/data/test-prospect.json");
  if (!data) return res.status(500).json({ error: "Failed to load prospect data" });
  res.json(data);
});

app.get("/api/scenarios", (req, res) => {
  const data = loadJson("./lbv-sales-copilot/scenarios/sales-scenarios.json");
  if (!data) return res.status(500).json({ error: "Failed to load scenarios" });
  res.json(data);
});

// Define tool schemas for Gemini Function Calling
const getProspectTool = {
  name: "getProspect",
  description: "Get general store profile details for the target prospect store (name, industry, platform, revenue band, active status, google reviews count and ratings).",
  parameters: {
    type: Type.OBJECT,
    properties: {}
  }
};

const getAuditTool = {
  name: "getAudit",
  description: "Get the main technical audit finding for the prospect store.",
  parameters: {
    type: Type.OBJECT,
    properties: {}
  }
};

const getEvidenceTool = {
  name: "getEvidence",
  description: "Get visual proof and store error items demonstrating specific friction points on the site or Google listing.",
  parameters: {
    type: Type.OBJECT,
    properties: {}
  }
};

const getOfferTool = {
  name: "getOffer",
  description: "Get pricing details for the pilot price, monthly price, and pilot scope of work.",
  parameters: {
    type: Type.OBJECT,
    properties: {}
  }
};

// API Endpoint to evaluate prospect queries with the Sales Brain and check constraints
app.post("/api/copilot", async (req, res) => {
  try {
    const { prompt, scenarioId } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: "Prompt is required" });
    }

    const testProspectData = loadJson("./lbv-sales-copilot/sales-api/data/test-prospect.json");
    if (!testProspectData) {
      return res.status(500).json({ error: "Server error: missing prospect data source." });
    }

    const toolsLogged: { tool: string; result: any }[] = [];
    let currentContents: any[] = [
      { role: "user", parts: [{ text: prompt }] }
    ];

    // Initial tool execution step
    let response = await ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: currentContents,
      config: {
        systemInstruction: SALES_SYSTEM_INSTRUCTIONS,
        tools: [{ functionDeclarations: [getProspectTool, getAuditTool, getEvidenceTool, getOfferTool] }]
      }
    });

    const functionCalls = response.functionCalls;

    if (functionCalls && functionCalls.length > 0) {
      // Append model turn to history
      currentContents.push(response.candidates?.[0]?.content);

      const functionResponseParts: any[] = [];
      for (const call of functionCalls) {
        let result: any = null;
        if (call.name === "getProspect") {
          result = testProspectData.prospect;
        } else if (call.name === "getAudit") {
          result = testProspectData.audit;
        } else if (call.name === "getEvidence") {
          result = testProspectData.evidence;
        } else if (call.name === "getOffer") {
          result = testProspectData.offer;
        }

        toolsLogged.push({ tool: call.name || "", result });

        functionResponseParts.push({
          functionResponse: {
            name: call.name,
            response: { result }
          }
        });
      }

      // Append tool execution responses to user turn
      currentContents.push({
        role: "user",
        parts: functionResponseParts
      });

      // Fetch grounded output
      response = await ai.models.generateContent({
        model: "gemini-3.8-flash",
        contents: currentContents,
        config: {
          systemInstruction: SALES_SYSTEM_INSTRUCTIONS,
          tools: [{ functionDeclarations: [getProspectTool, getAuditTool, getEvidenceTool, getOfferTool] }]
        }
      });
    }

    const finalAnswer = response.text || "";

    // Validate the generated response against sales rules
    const validationReport = validateResponse(finalAnswer, (prompt || "") as string);

    res.json({
      answer: finalAnswer,
      toolsUsed: toolsLogged,
      validationReport
    });

  } catch (error: any) {
    console.error("Gemini Sales Brain API Error:", error);
    res.status(500).json({
      error: "Failed to generate copilot recommendation.",
      details: error.message || error
    });
  }
});

// Run a complete batch of adversarial testing against the Sales Brain
app.post("/api/run-adversarial-tests", async (req, res) => {
  try {
    const testCases: AdversarialTestCase[] = loadJson("./lbv-sales-copilot/scenarios/adversarial-tests.json");
    if (!testCases) {
      return res.status(500).json({ error: "Failed to load adversarial tests checklist." });
    }

    const testProspectData = loadJson("./lbv-sales-copilot/sales-api/data/test-prospect.json");
    if (!testProspectData) {
      return res.status(500).json({ error: "Failed to load prospect source of truth." });
    }

    const results: TestResult[] = [];
    const batchSize = 3; // safe controlled-concurrency to respect standard API quotas

    for (let i = 0; i < testCases.length; i += batchSize) {
      const batch = testCases.slice(i, i + batchSize);
      await Promise.all(batch.map(async (testCase) => {
        try {
          const toolsLogged: string[] = [];
          let currentContents: any[] = [
            { role: "user", parts: [{ text: testCase.prompt }] }
          ];

          // 1st Model Turn
          let response = await ai.models.generateContent({
            model: "gemini-3.8-flash",
            contents: currentContents,
            config: {
              systemInstruction: SALES_SYSTEM_INSTRUCTIONS,
              tools: [{ functionDeclarations: [getProspectTool, getAuditTool, getEvidenceTool, getOfferTool] }]
            }
          });

          const functionCalls = response.functionCalls;

          if (functionCalls && functionCalls.length > 0) {
            currentContents.push(response.candidates?.[0]?.content);
            const functionResponseParts: any[] = [];
            
            for (const call of functionCalls) {
              let result: any = null;
              if (call.name === "getProspect") {
                result = testProspectData.prospect;
              } else if (call.name === "getAudit") {
                result = testProspectData.audit;
              } else if (call.name === "getEvidence") {
                result = testProspectData.evidence;
              } else if (call.name === "getOffer") {
                result = testProspectData.offer;
              }

              toolsLogged.push(call.name || "");
              functionResponseParts.push({
                functionResponse: {
                  name: call.name,
                  response: { result }
                }
              });
            }

            currentContents.push({
              role: "user",
              parts: functionResponseParts
            });

            // 2nd Model Turn (Grounded)
            response = await ai.models.generateContent({
              model: "gemini-3.8-flash",
              contents: currentContents,
              config: {
                systemInstruction: SALES_SYSTEM_INSTRUCTIONS,
                tools: [{ functionDeclarations: [getProspectTool, getAuditTool, getEvidenceTool, getOfferTool] }]
              }
            });
          }

          const finalAnswer = response.text || "";
          const evaluationResult = evaluateTest(testCase, finalAnswer, toolsLogged);
          results.push(evaluationResult);

        } catch (error: any) {
          console.error(`Adversarial Test Execution Error [${testCase.test_id}]:`, error);
          results.push({
            test_id: testCase.test_id,
            category: testCase.category,
            prompt: testCase.prompt,
            tool_calls: [],
            response: `EXECUTION FAILURE: ${error.message || error}`,
            pass: false,
            failures: [`Adversarial execution error: ${error.message || error}`],
            forbidden_claims_detected: [],
            grounding_errors: [`Adversarial execution error: ${error.message || error}`],
            is_critical: true
          });
        }
      }));

      // Rest for 250ms to respect rate limits smoothly
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    // Calculate Summary Metrics
    const totalTests = testCases.length;
    // Sort results to preserve the original test list ordering for easier inspection
    results.sort((a, b) => a.test_id.localeCompare(b.test_id));
    
    const passed = results.filter(r => r.pass).length;
    const failed = totalTests - passed;
    const passRate = parseFloat(((passed / totalTests) * 100).toFixed(1));

    // Run Static Bypass Regression Checks (Malicious inputs designed to leak if disclaimers or bypasses work)
    const regressionResults = BYPASS_REGRESSION_TESTS.map(testCase => {
      const testCaseObj = {
        test_id: testCase.test_id,
        category: testCase.category,
        prompt: testCase.prompt,
        expected_facts: [],
        required_behaviors: [],
        forbidden_claims: [],
        expected_tools: []
      };
      // To pass the regression, the validator must catch the malicious leak (pass must be FALSE on evaluateTest)
      const evalResult = evaluateTest(testCaseObj, testCase.response, []);
      return {
        test_id: testCase.test_id,
        category: testCase.category,
        prompt: testCase.prompt,
        response: testCase.response,
        pass: !evalResult.pass, // PASS means the validator caught the leak (i.e. evaluated as invalid)
        failures: evalResult.failures
      };
    });

    // Run Legitimate Positive Controls (Valid statements that should always PASS to prevent overblocking)
    const controlResults = POSITIVE_CONTROLS.map(testCase => {
      const testCaseObj = {
        test_id: testCase.test_id,
        category: "positive_control",
        prompt: testCase.prompt,
        expected_facts: [],
        required_behaviors: [],
        forbidden_claims: [],
        expected_tools: []
      };
      // To pass, the validator must approve the legitimate response (pass must be TRUE on evaluateTest)
      const evalResult = evaluateTest(testCaseObj, testCase.response, []);
      return {
        test_id: testCase.test_id,
        category: "positive_control",
        prompt: testCase.prompt,
        response: testCase.response,
        pass: evalResult.pass, // PASS means the validator approved it (i.e. evaluated as valid)
        failures: evalResult.failures
      };
    });

    // Compile Regression metrics
    const regressionPassed = regressionResults.filter(r => r.pass).length;
    const regressionFailed = BYPASS_REGRESSION_TESTS.length - regressionPassed;

    // Compile Control metrics
    const controlPassed = controlResults.filter(r => r.pass).length;
    const controlFailed = POSITIVE_CONTROLS.length - controlPassed;

    // False Positive & False Negative counters
    const criticalFalseNegatives = regressionFailed; // Malicious leaks that the validator missed (failed to reject)
    const criticalFalsePositives = controlFailed;     // Legit statements that the validator blocked (failed to approve)

    const groundingFailures = results.filter(r => r.grounding_errors.length > 0).length;
    const forbiddenClaimFailures = results.filter(r => r.forbidden_claims_detected.length > 0).length;
    const pricingFailures = results.filter(r => r.failures.some(f => f.includes("Pricing"))).length;
    const scopeFailures = results.filter(r => r.failures.some(f => f.includes("Scope"))).length;
    const evidenceFailures = results.filter(r => r.failures.some(f => f.includes("Evidence"))).length;
    const injectionFailures = results.filter(r => r.failures.some(f => f.includes("Instruction") || f.includes("Injection"))).length;
    const unknownInformationFailures = results.filter(r => r.category === "unknown_information" && !r.pass).length;
    const toolSelectionFailures = results.filter(r => r.failures.some(f => f.includes("Tool Selection"))).length;

    const criticalFailures = results.filter(r => r.is_critical && !r.pass).length;
    const nonCriticalFailures = failed - criticalFailures;

    // Harness repair overall PASS/FAIL gate
    const overallStatus = (criticalFalseNegatives === 0 && criticalFalsePositives === 0 && criticalFailures === 0) ? "PASS" : "FAIL";

    const metrics = {
      originalTests: {
        total: totalTests,
        passed,
        failed,
        passRate
      },
      bypassTests: {
        total: BYPASS_REGRESSION_TESTS.length,
        passed: regressionPassed,
        failed: regressionFailed
      },
      positiveControls: {
        total: POSITIVE_CONTROLS.length,
        passed: controlPassed,
        failed: controlFailed
      },
      total: {
        total: totalTests + BYPASS_REGRESSION_TESTS.length + POSITIVE_CONTROLS.length,
        passed: passed + regressionPassed + controlPassed,
        failed: failed + regressionFailed + controlFailed
      },
      criticalFalseNegatives,
      criticalFalsePositives,
      groundingFailures,
      forbiddenClaimFailures,
      pricingFailures,
      scopeFailures,
      evidenceFailures,
      injectionFailures,
      unknownInformationFailures,
      toolSelectionFailures,
      criticalFailures,
      nonCriticalFailures,
      overallStatus
    };

    res.json({
      results,
      regressionResults,
      controlResults,
      metrics
    });

  } catch (error: any) {
    console.error("Adversarial Suite Execution Server Error:", error);
    res.status(500).json({ error: "Failed to compile and run adversarial tests checklist.", details: error.message });
  }
});

// Mount Vite middleware or static files
if (!isProd) {
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: "spa"
  });
  app.use(vite.middlewares);
} else {
  const distPath = path.resolve("dist");
  app.use(express.static(distPath));
  app.get("*", (req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}

const PORT = 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[Stage 1 Server] Ready at http://localhost:${PORT}`);
});
