import React, { useState, useEffect } from "react";
import { 
  Building2, 
  Layers, 
  DollarSign, 
  ShieldAlert, 
  ChevronRight, 
  Play, 
  CheckCircle, 
  XCircle, 
  Clipboard, 
  HelpCircle, 
  FileText, 
  AlertTriangle,
  ExternalLink,
  MessageSquareCode,
  RotateCcw,
  Sparkles,
  Search,
  ListFilter,
  Activity,
  ArrowRightCircle,
  TrendingUp,
  Check,
  CheckSquare
} from "lucide-react";

interface ProspectInfo {
  name: string;
  industry: string;
  platform: string;
  revenueBand: string;
  googleReviews: number;
  googleRating: number;
  websiteStatus: string;
}

interface AuditInfo {
  finding: string;
}

interface EvidenceItem {
  id: string;
  type: string;
  description: string;
  impact: string;
}

interface OfferInfo {
  pilotPrice: number;
  monthlyPrice: number;
  pilotScope: string;
}

interface FullProspectData {
  prospect: ProspectInfo;
  audit: AuditInfo;
  evidence: EvidenceItem[];
  offer: OfferInfo;
  unsupportedMetrics: Record<string, string>;
}

interface Scenario {
  id: number;
  scenario: string;
  prompt: string;
  expectedBehavior: string;
}

interface ValidationReport {
  isGrounded: boolean;
  unsupportedClaims: string[];
  rulesPassed: { name: string; status: "PASSED" | "FAILED"; description: string }[];
}

interface ValidationResult {
  answer: string;
  toolsUsed: { tool: string; result: any }[];
  validationReport: ValidationReport;
}

// Adversarial suite types
interface AdversarialTestResult {
  test_id: string;
  category: string;
  prompt: string;
  tool_calls: string[];
  response: string;
  pass: boolean;
  failures: string[];
  forbidden_claims_detected: string[];
  grounding_errors: string[];
  is_critical: boolean;
}

interface MetricSubset {
  total: number;
  passed: number;
  failed: number;
  passRate?: number;
}

interface AdversarialMetrics {
  originalTests: MetricSubset;
  bypassTests: MetricSubset;
  positiveControls: MetricSubset;
  total: MetricSubset;
  criticalFalseNegatives: number;
  criticalFalsePositives: number;
  groundingFailures: number;
  forbiddenClaimFailures: number;
  pricingFailures: number;
  scopeFailures: number;
  evidenceFailures: number;
  injectionFailures: number;
  unknownInformationFailures: number;
  toolSelectionFailures: number;
  criticalFailures: number;
  nonCriticalFailures: number;
  overallStatus: "PASS" | "FAIL";
}

export default function Page() {
  const [activeTab, setActiveTab] = useState<"playground" | "adversarial">("playground");
  const [prospectData, setProspectData] = useState<FullProspectData | null>(null);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [selectedScenarioId, setSelectedScenarioId] = useState<number>(1);
  const [customPrompt, setCustomPrompt] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [result, setResult] = useState<ValidationResult | null>(null);
  const [copied, setCopied] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Adversarial testing state
  const [runningAdvSuite, setRunningAdvSuite] = useState<boolean>(false);
  const [advResults, setAdvResults] = useState<AdversarialTestResult[]>([]);
  const [regressionResults, setRegressionResults] = useState<any[]>([]);
  const [controlResults, setControlResults] = useState<any[]>([]);
  const [advMetrics, setAdvMetrics] = useState<AdversarialMetrics | null>(null);
  const [expandedTestId, setExpandedTestId] = useState<string | null>(null);
  const [advFilter, setAdvFilter] = useState<"all" | "passed" | "failed">("all");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [subSuiteTab, setSubSuiteTab] = useState<"original" | "regressions" | "controls">("original");

  // Fetch initial static data
  useEffect(() => {
    async function fetchData() {
      try {
        const [prospectRes, scenariosRes] = await Promise.all([
          fetch("/api/test-prospect"),
          fetch("/api/scenarios")
        ]);
        
        if (!prospectRes.ok || !scenariosRes.ok) {
          throw new Error("Failed to load initial data from full-stack server API");
        }
        
        const pData = await prospectRes.json();
        const sData = await scenariosRes.json();
        
        setProspectData(pData);
        setScenarios(sData);
        
        // Default prompt to first scenario's prompt
        if (sData.length > 0) {
          setCustomPrompt(sData[0].prompt);
        }
      } catch (err: any) {
        setError(err.message || "Unknown error loading data");
      }
    }
    fetchData();
  }, []);

  // Update prompt input when scenario changes
  const handleScenarioChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const id = parseInt(e.target.value);
    setSelectedScenarioId(id);
    const selected = scenarios.find(s => s.id === id);
    if (selected) {
      setCustomPrompt(selected.prompt);
    }
  };

  const handleRunValidation = async () => {
    if (!customPrompt.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/copilot", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          prompt: customPrompt,
          scenarioId: selectedScenarioId
        })
      });
      
      if (!res.ok) {
        const errJson = await res.json();
        throw new Error(errJson.details || errJson.error || "Generation error");
      }
      
      const data: ValidationResult = await res.json();
      setResult(data);
    } catch (err: any) {
      setError(err.message || "Failed to contact Gemini Sales Brain server");
    } finally {
      setLoading(false);
    }
  };

  const handleRunAdversarialSuite = async () => {
    setRunningAdvSuite(true);
    setError(null);
    setAdvResults([]);
    setRegressionResults([]);
    setControlResults([]);
    setAdvMetrics(null);
    try {
      const res = await fetch("/api/run-adversarial-tests", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        }
      });
      
      if (!res.ok) {
        const errJson = await res.json();
        throw new Error(errJson.details || errJson.error || "Adversarial test execution failed");
      }
      
      const data = await res.json();
      setAdvResults(data.results);
      setRegressionResults(data.regressionResults);
      setControlResults(data.controlResults);
      setAdvMetrics(data.metrics);
    } catch (err: any) {
      setError(err.message || "Failed to complete Adversarial validation suite.");
    } finally {
      setRunningAdvSuite(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const activeScenario = scenarios.find(s => s.id === selectedScenarioId);

  // Filter adversarial tests
  const filteredAdvResults = advResults.filter(test => {
    const matchesFilter = 
      advFilter === "all" || 
      (advFilter === "passed" && test.pass) || 
      (advFilter === "failed" && !test.pass);
    
    const matchesSearch = 
      test.test_id.toLowerCase().includes(searchQuery.toLowerCase()) ||
      test.category.toLowerCase().includes(searchQuery.toLowerCase()) ||
      test.prompt.toLowerCase().includes(searchQuery.toLowerCase()) ||
      test.response.toLowerCase().includes(searchQuery.toLowerCase());
    
    return matchesFilter && matchesSearch;
  });

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4 md:p-8 font-sans selection:bg-indigo-500 selection:text-white">
      {/* Header */}
      <header className="max-w-7xl mx-auto mb-8 border-b border-slate-800/80 pb-6 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-indigo-500/15 text-indigo-400 border border-indigo-500/30">
              Stage 1.5 Rigor Grounding
            </span>
            <span className="text-xs text-slate-400 font-mono">Harness Repaired (Sentence Parsing)</span>
          </div>
          <h1 className="text-3xl font-extrabold tracking-tight bg-gradient-to-r from-indigo-400 via-purple-400 to-cyan-400 bg-clip-text text-transparent">
            lbv-sales-copilot
          </h1>
          <p className="text-slate-400 text-sm mt-1 max-w-2xl">
            Repaired adversarial validation harness. Eliminates disclaimer bypass, guarantees financial promises, and protects pricing/scope integrity against multi-turn injections.
          </p>
        </div>

        {/* Tab Controls */}
        <div className="flex bg-slate-900 border border-slate-800 p-1.5 rounded-xl">
          <button
            onClick={() => setActiveTab("playground")}
            className={`px-4 py-2 text-xs font-bold rounded-lg transition-all flex items-center gap-1.5 cursor-pointer ${
              activeTab === "playground" 
                ? "bg-indigo-600 text-white shadow-lg" 
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <Activity className="w-3.5 h-3.5" />
            Objections Playground
          </button>
          <button
            onClick={() => setActiveTab("adversarial")}
            className={`px-4 py-2 text-xs font-bold rounded-lg transition-all flex items-center gap-1.5 cursor-pointer ${
              activeTab === "adversarial" 
                ? "bg-indigo-600 text-white shadow-lg" 
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <ShieldAlert className="w-3.5 h-3.5" />
            Adversarial Test Suite
          </button>
        </div>
      </header>

      {error && (
        <div className="max-w-7xl mx-auto mb-6 bg-rose-500/10 border border-rose-500/25 rounded-xl p-4 text-rose-300 text-sm flex gap-3 items-center animate-fadeIn">
          <XCircle className="w-5 h-5 shrink-0" />
          <span><strong>Error:</strong> {error}</span>
        </div>
      )}

      {/* Main Tab Views */}
      {activeTab === "playground" ? (
        <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-8 animate-fadeIn">
          {/* Left column: Prospect Factual Data (Sources of Truth) */}
          <div className="lg:col-span-5 space-y-6">
            {prospectData ? (
              <>
                {/* Prospect Card */}
                <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-5 shadow-xl backdrop-blur-sm">
                  <div className="flex items-center justify-between mb-4 border-b border-slate-800 pb-3">
                    <div className="flex items-center gap-2.5">
                      <Building2 className="w-5 h-5 text-indigo-400" />
                      <h2 className="font-bold text-slate-200">Active Test Prospect</h2>
                    </div>
                    <span className="text-[10px] font-mono uppercase tracking-wider bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 px-2 py-0.5 rounded">
                      Shopify Source
                    </span>
                  </div>

                  <div className="space-y-3.5">
                    <div className="flex justify-between items-center text-sm">
                      <span className="text-slate-400">Store Name</span>
                      <span className="font-semibold text-slate-200">{prospectData.prospect.name}</span>
                    </div>
                    <div className="flex justify-between items-center text-sm">
                      <span className="text-slate-400">Industry Sector</span>
                      <span className="text-slate-300 bg-slate-850 px-2 py-0.5 rounded text-xs">{prospectData.prospect.industry}</span>
                    </div>
                    <div className="flex justify-between items-center text-sm">
                      <span className="text-slate-400">Platform Provider</span>
                      <span className="font-semibold text-emerald-400">{prospectData.prospect.platform}</span>
                    </div>
                    <div className="flex justify-between items-center text-sm">
                      <span className="text-slate-400">Estimated Revenue</span>
                      <span className="font-semibold text-slate-200">{prospectData.prospect.revenueBand}</span>
                    </div>
                    <div className="flex justify-between items-center text-sm">
                      <span className="text-slate-400">Google Listing Ratings</span>
                      <span className="text-amber-400 font-semibold text-xs flex items-center gap-1">
                        ★ {prospectData.prospect.googleRating} <span className="text-slate-500">({prospectData.prospect.googleReviews} reviews)</span>
                      </span>
                    </div>
                    <div className="flex justify-between items-center text-sm">
                      <span className="text-slate-400">Website Status</span>
                      <span className="px-2 py-0.5 bg-emerald-500/15 text-emerald-400 border border-emerald-500/25 rounded-full text-[11px] font-semibold">
                        {prospectData.prospect.websiteStatus}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Audit Findings */}
                <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-5 shadow-xl backdrop-blur-sm">
                  <div className="flex items-center gap-2.5 mb-3 border-b border-slate-800 pb-3">
                    <Layers className="w-5 h-5 text-indigo-400" />
                    <h2 className="font-bold text-slate-200">Technical Audit findings</h2>
                  </div>
                  <div className="bg-slate-950 border border-slate-800/60 p-3.5 rounded-xl">
                    <div className="text-xs text-indigo-400 font-mono mb-1">MAIN AUDIT FINDING:</div>
                    <p className="text-sm font-semibold text-slate-200 italic">
                      "{prospectData.audit.finding}"
                    </p>
                  </div>
                </div>

                {/* Visual Evidence Collect */}
                <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-5 shadow-xl backdrop-blur-sm">
                  <div className="flex items-center gap-2.5 mb-3 border-b border-slate-800 pb-3">
                    <FileText className="w-5 h-5 text-indigo-400" />
                    <h2 className="font-bold text-slate-200">Visual Evidence Collects</h2>
                  </div>
                  <div className="space-y-3">
                    {prospectData.evidence.map((item, index) => (
                      <div key={item.id} className="bg-slate-950 border border-slate-800/50 p-3 rounded-xl space-y-1">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] font-mono text-indigo-400">EVIDENCE #{index + 1}</span>
                          <span className="text-[10px] bg-slate-800 px-1.5 py-0.2 rounded text-slate-300 uppercase font-mono">{item.id}</span>
                        </div>
                        <p className="text-xs text-slate-200 font-medium">{item.description}</p>
                        <div className="text-[11px] text-rose-300 italic">Impact: {item.impact}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Pilot Offer Details */}
                <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-5 shadow-xl backdrop-blur-sm">
                  <div className="flex items-center gap-2.5 mb-3 border-b border-slate-800 pb-3">
                    <DollarSign className="w-5 h-5 text-indigo-400" />
                    <h2 className="font-bold text-slate-200">Defined Pilot Proposal</h2>
                  </div>
                  <div className="grid grid-cols-2 gap-4 mb-4">
                    <div className="bg-slate-950 p-3 rounded-xl border border-slate-800">
                      <span className="text-slate-500 text-[10px] block uppercase font-semibold">Pilot Pricing</span>
                      <span className="text-lg font-bold text-slate-100">${prospectData.offer.pilotPrice}</span>
                    </div>
                    <div className="bg-slate-950 p-3 rounded-xl border border-slate-800">
                      <span className="text-slate-500 text-[10px] block uppercase font-semibold">Recurring Monthly</span>
                      <span className="text-lg font-bold text-slate-100">${prospectData.offer.monthlyPrice}</span>
                    </div>
                  </div>
                  <div className="bg-slate-950/80 border border-slate-800 p-3 rounded-xl">
                    <span className="text-[10px] font-mono text-indigo-400 block mb-1">DETERMINISTIC PILOT SCOPE:</span>
                    <div className="text-xs text-slate-200 font-semibold">{prospectData.offer.pilotScope}</div>
                  </div>
                </div>
              </>
            ) : (
              <div className="bg-slate-900 h-96 rounded-2xl flex items-center justify-center text-slate-400 animate-pulse">
                Initializing prospect source...
              </div>
            )}
          </div>

          {/* Right column: Playground */}
          <div className="lg:col-span-7 space-y-6">
            <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-6 shadow-xl backdrop-blur-sm">
              <h2 className="text-lg font-bold text-slate-200 mb-4 flex items-center gap-2">
                <MessageSquareCode className="w-5 h-5 text-indigo-400" />
                Scenario Validation Playground
              </h2>

              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1.5">
                    Select Evaluation Scenario ({scenarios.length} Total)
                  </label>
                  <select 
                    value={selectedScenarioId}
                    onChange={handleScenarioChange}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                  >
                    {scenarios.map(sc => (
                      <option key={sc.id} value={sc.id}>
                        {sc.id}. {sc.scenario}
                      </option>
                    ))}
                  </select>
                </div>

                {activeScenario && (
                  <div className="bg-slate-950 border border-slate-800 p-4 rounded-xl text-xs space-y-2">
                    <div className="font-bold text-indigo-400 uppercase tracking-wide flex items-center gap-1.5">
                      <span>Scenario Expected Constraints</span>
                    </div>
                    <p className="text-slate-300 leading-relaxed font-medium">
                      {activeScenario.expectedBehavior}
                    </p>
                  </div>
                )}

                <div>
                  <div className="flex justify-between items-center mb-1.5">
                    <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400">
                      Prospect Statement (Input Prompt)
                    </label>
                    <span className="text-[10px] text-slate-500 italic">Fully Editable</span>
                  </div>
                  <textarea
                    value={customPrompt}
                    onChange={(e) => setCustomPrompt(e.target.value)}
                    className="w-full h-24 bg-slate-950 border border-slate-800 rounded-xl p-4 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 resize-y"
                    placeholder="Enter prospect objection, query, or statement..."
                  />
                </div>

                <div className="flex justify-end gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      if (activeScenario) {
                        setCustomPrompt(activeScenario.prompt);
                      }
                    }}
                    className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-colors border border-slate-700/60 cursor-pointer"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    Reset to Scenario Default
                  </button>
                  <button
                    type="button"
                    onClick={handleRunValidation}
                    disabled={loading}
                    className="px-6 py-2 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 disabled:opacity-50 text-white rounded-xl text-xs font-bold flex items-center gap-2 tracking-wide transition-all shadow-md cursor-pointer disabled:cursor-not-allowed active:scale-[0.98]"
                  >
                    {loading ? (
                      <>
                        <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                        Executing Sales Brain...
                      </>
                    ) : (
                      <>
                        <Play className="w-3.5 h-3.5 fill-current" />
                        Run Sales Brain Validation
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>

            {result && (
              <div className="space-y-6 animate-fadeIn">
                <div className="bg-gradient-to-b from-indigo-950/20 to-slate-900 border border-indigo-500/25 rounded-2xl p-6 shadow-2xl relative overflow-hidden">
                  <div className="flex justify-between items-center mb-4 border-b border-slate-800 pb-3">
                    <div>
                      <span className="text-[10px] uppercase tracking-widest text-indigo-400 font-extrabold block">Recommended Script Output</span>
                      <h3 className="text-lg font-bold text-slate-100">"SAY THIS NEXT"</h3>
                    </div>
                    <button
                      onClick={() => copyToClipboard(result.answer)}
                      className="p-2 bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/20 text-indigo-300 hover:text-white rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer"
                    >
                      <Clipboard className="w-3.5 h-3.5" />
                      {copied ? "Copied Script!" : "Copy Script"}
                    </button>
                  </div>

                  <div className="bg-slate-950 border border-indigo-950/80 p-5 rounded-xl font-sans text-slate-100 leading-relaxed text-base min-h-[90px] shadow-inner selection:bg-indigo-500">
                    {result.answer}
                  </div>
                </div>

                {/* Rules audit */}
                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-3 mb-4">
                    <h3 className="font-bold text-slate-200 text-sm flex items-center gap-2">
                      <ShieldAlert className="w-4 h-4 text-indigo-400" />
                      Automated Grounding Evaluation
                    </h3>
                    {result.validationReport.isGrounded ? (
                      <span className="px-3 py-1 bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 rounded-full text-xs font-bold flex items-center gap-1.5 animate-pulse">
                        <CheckCircle className="w-3.5 h-3.5" />
                        COMPLIANT & GROUNDED
                      </span>
                    ) : (
                      <span className="px-3 py-1 bg-rose-500/15 border border-rose-500/30 text-rose-400 rounded-full text-xs font-bold flex items-center gap-1.5">
                        <AlertTriangle className="w-3.5 h-3.5 animate-bounce" />
                        UNSUPPORTED CLAIMS DETECTED
                      </span>
                    )}
                  </div>

                  <div className="space-y-3">
                    {result.validationReport.rulesPassed.map((rule, idx) => (
                      <div 
                        key={idx} 
                        className={`p-3 rounded-xl border flex justify-between items-center ${
                          rule.status === "PASSED" 
                            ? "bg-emerald-950/10 border-emerald-500/10 text-emerald-300" 
                            : "bg-rose-950/10 border-rose-500/10 text-rose-300"
                        }`}
                      >
                        <div className="space-y-0.5">
                          <div className="text-xs font-bold flex items-center gap-1.5">
                            {rule.status === "PASSED" ? (
                              <CheckCircle className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                            ) : (
                              <XCircle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                            )}
                            {rule.name}
                          </div>
                          <p className="text-[11px] text-slate-400">{rule.description}</p>
                        </div>
                        <span className={`text-[10px] font-mono px-2 py-0.5 rounded ${
                          rule.status === "PASSED" 
                            ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/20" 
                            : "bg-rose-500/15 text-rose-400 border border-rose-500/20"
                        }`}>
                          {rule.status}
                        </span>
                      </div>
                    ))}
                  </div>

                  {result.validationReport.unsupportedClaims.length > 0 && (
                    <div className="mt-4 p-4 bg-rose-500/10 border border-rose-500/20 rounded-xl space-y-2">
                      <div className="text-xs font-bold text-rose-400 uppercase tracking-wider flex items-center gap-1.5">
                        <AlertTriangle className="w-4 h-4" />
                        Warning: Compliance Infractions Detected
                      </div>
                      <ul className="list-disc pl-5 text-xs text-rose-200/95 space-y-1">
                        {result.validationReport.unsupportedClaims.map((claim, i) => (
                          <li key={i}>{claim}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        /* Upgraded Adversarial Tab */
        <div className="max-w-7xl mx-auto space-y-6 animate-fadeIn">
          {/* Top Panel Actions & Counters */}
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
            {/* Launcher Card */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl flex flex-col justify-between">
              <div>
                <h3 className="font-bold text-slate-200 text-sm flex items-center gap-1.5 mb-1">
                  <ShieldAlert className="w-4 h-4 text-indigo-400" />
                  Audit Sweeper Launcher
                </h3>
                <p className="text-xs text-slate-400 leading-relaxed mb-4">
                  Runs the 31 live model tests, 22 regression bypass tests, and 3 positive controls. Evaluates against sentence-level disclaimers and injections.
                </p>
              </div>
              <button
                onClick={handleRunAdversarialSuite}
                disabled={runningAdvSuite}
                className="w-full py-3 bg-gradient-to-r from-indigo-600 via-purple-600 to-indigo-700 hover:from-indigo-500 hover:to-purple-500 disabled:opacity-50 text-white font-bold rounded-xl text-xs flex items-center justify-center gap-2 tracking-wide transition-all shadow-md cursor-pointer disabled:cursor-not-allowed active:scale-[0.98]"
              >
                {runningAdvSuite ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                    Sweeping 56 Tests...
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4 fill-current" />
                    Launch Harness Sweeper
                  </>
                )}
              </button>
            </div>

            {/* Test Status Counters */}
            {advMetrics ? (
              <>
                {/* Total Stats Group */}
                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl flex flex-col justify-between">
                  <div>
                    <span className="text-[10px] text-slate-400 uppercase tracking-wider font-bold block mb-1">Consolidated Suite Results</span>
                    <div className="text-2xl font-extrabold text-slate-100 font-mono">
                      {advMetrics.total.passed} / {advMetrics.total.total} Passed
                    </div>
                    <div className="text-[11px] text-slate-400 space-y-1 mt-2.5">
                      <div className="flex justify-between">
                        <span>31 Original Model Tests:</span>
                        <span className="font-mono text-indigo-400 font-semibold">{advMetrics.originalTests.passed}/{advMetrics.originalTests.total}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>22 Bypass Regressions:</span>
                        <span className="font-mono text-indigo-400 font-semibold">{advMetrics.bypassTests.passed}/{advMetrics.bypassTests.total}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>3 Positive Controls:</span>
                        <span className="font-mono text-indigo-400 font-semibold">{advMetrics.positiveControls.passed}/{advMetrics.positiveControls.total}</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Hard Gate Integrity Leakages */}
                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl flex flex-col justify-between">
                  <div>
                    <span className="text-[10px] text-slate-400 uppercase tracking-wider font-bold block mb-1">Integrity Leakages</span>
                    <div className="grid grid-cols-2 gap-3 mt-2">
                      <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-850">
                        <span className="text-[9px] uppercase font-bold text-slate-500">False Negatives</span>
                        <div className={`text-xl font-bold font-mono mt-0.5 ${advMetrics.criticalFalseNegatives > 0 ? "text-rose-400" : "text-emerald-400"}`}>
                          {advMetrics.criticalFalseNegatives}
                        </div>
                      </div>
                      <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-850">
                        <span className="text-[9px] uppercase font-bold text-slate-500">False Positives</span>
                        <div className={`text-xl font-bold font-mono mt-0.5 ${advMetrics.criticalFalsePositives > 0 ? "text-rose-400" : "text-emerald-400"}`}>
                          {advMetrics.criticalFalsePositives}
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="text-[10px] text-slate-500 leading-tight italic mt-2">
                    False Negatives represent malicious prompts leaking claims. False Positives represent legit claims getting blocked.
                  </div>
                </div>

                {/* Hard Gate overall status card */}
                <div className={`border rounded-2xl p-6 shadow-xl flex flex-col justify-between ${
                  advMetrics.overallStatus === "PASS" 
                    ? "bg-emerald-950/10 border-emerald-500/30 text-emerald-300" 
                    : "bg-rose-950/10 border-rose-500/30 text-rose-300"
                }`}>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[10px] uppercase tracking-wider font-extrabold font-mono">Harness Repair Audit</span>
                    <span className={`px-2 py-0.5 rounded text-[9px] font-bold ${
                      advMetrics.overallStatus === "PASS" ? "bg-emerald-500/20 text-emerald-400" : "bg-rose-500/20 text-rose-400"
                    }`}>
                      {advMetrics.overallStatus}
                    </span>
                  </div>
                  <div className="text-2xl font-extrabold tracking-wide mb-1 font-mono">
                    {advMetrics.overallStatus === "PASS" ? "HARNESS REPAIR: PASS" : "HARNESS REPAIR: FAIL"}
                  </div>
                  <p className="text-[11px] text-slate-400 leading-normal">
                    {advMetrics.overallStatus === "PASS" 
                      ? "STAGE 1.5 PASS — Validator fully repaired against sentence disclaimers and metric abbreviations. Ready for Stage 2." 
                      : "STAGE 1.5 STILL FAIL — Validator repair required. Unconditional check bypasses detected."}
                  </p>
                </div>
              </>
            ) : (
              <div className="bg-slate-900 border border-slate-800/80 rounded-2xl p-6 shadow-xl md:col-span-3 flex items-center justify-center text-slate-500 text-sm italic font-mono">
                {runningAdvSuite ? (
                  <div className="flex flex-col items-center gap-3">
                    <div className="w-8 h-8 border-4 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin"></div>
                    <span className="text-xs text-slate-400 font-bold animate-pulse">Running full sweeps (original, regressions, and controls)...</span>
                  </div>
                ) : (
                  "Test suite has not been launched yet. Click launcher above to execute audits."
                )}
              </div>
            )}
          </div>

          {/* Hard Gate Vulnerabilities Checklist */}
          {advMetrics && (
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl animate-fadeIn">
              <h3 className="font-bold text-sm text-slate-200 border-b border-slate-800 pb-3 mb-4 flex items-center gap-2">
                <CheckSquare className="w-4 h-4 text-indigo-400" />
                Deterministic Guardrails Audit checklist (Unconditional Cross-checking)
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="p-3 rounded-xl bg-slate-950 border border-slate-850 flex justify-between items-center text-xs">
                  <span className="text-slate-300">Revenue/Metric Fabrication</span>
                  {advMetrics.groundingFailures === 0 && advMetrics.criticalFalseNegatives === 0 ? (
                    <span className="text-emerald-400 font-bold font-mono">PASS</span>
                  ) : (
                    <span className="text-rose-400 font-bold font-mono">FAIL</span>
                  )}
                </div>
                <div className="p-3 rounded-xl bg-slate-950 border border-slate-850 flex justify-between items-center text-xs">
                  <span className="text-slate-300">Pricing Integrity ($400/$900)</span>
                  {advMetrics.pricingFailures === 0 ? (
                    <span className="text-emerald-400 font-bold font-mono">PASS</span>
                  ) : (
                    <span className="text-rose-400 font-bold font-mono">FAIL</span>
                  )}
                </div>
                <div className="p-3 rounded-xl bg-slate-950 border border-slate-850 flex justify-between items-center text-xs">
                  <span className="text-slate-300">Defined Scope Shield</span>
                  {advMetrics.scopeFailures === 0 ? (
                    <span className="text-emerald-400 font-bold font-mono">PASS</span>
                  ) : (
                    <span className="text-rose-400 font-bold font-mono">FAIL</span>
                  )}
                </div>
                <div className="p-3 rounded-xl bg-slate-950 border border-slate-850 flex justify-between items-center text-xs">
                  <span className="text-slate-300">Disclaimer Leak Proof</span>
                  {advMetrics.criticalFalseNegatives === 0 ? (
                    <span className="text-emerald-400 font-bold font-mono">PASS</span>
                  ) : (
                    <span className="text-rose-400 font-bold font-mono">FAIL</span>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Sub-suite tab selector & List panel */}
          {advResults.length > 0 && (
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4 animate-fadeIn">
              <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-slate-800 pb-4">
                <div className="flex flex-col md:flex-row md:items-center gap-4">
                  <h3 className="font-bold text-slate-200 text-sm">Harness Sweeper Details</h3>
                  <div className="flex rounded-lg border border-slate-800 bg-slate-950 p-1">
                    <button
                      onClick={() => setSubSuiteTab("original")}
                      className={`px-3 py-1.5 text-[10px] font-bold rounded cursor-pointer ${
                        subSuiteTab === "original" ? "bg-indigo-600 text-white" : "text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      31 ORIGINAL LIVE TESTS
                    </button>
                    <button
                      onClick={() => setSubSuiteTab("regressions")}
                      className={`px-3 py-1.5 text-[10px] font-bold rounded cursor-pointer ${
                        subSuiteTab === "regressions" ? "bg-indigo-600 text-white" : "text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      22 BYPASS REGRESSIONS
                    </button>
                    <button
                      onClick={() => setSubSuiteTab("controls")}
                      className={`px-3 py-1.5 text-[10px] font-bold rounded cursor-pointer ${
                        subSuiteTab === "controls" ? "bg-indigo-600 text-white" : "text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      3 POSITIVE CONTROLS
                    </button>
                  </div>
                </div>

                {/* Filter & Search */}
                <div className="flex items-center gap-3 w-full md:w-auto">
                  <select
                    value={advFilter}
                    onChange={(e: any) => setAdvFilter(e.target.value)}
                    className="bg-slate-950 border border-slate-850 rounded-xl px-3 py-1.5 text-xs text-slate-300 focus:outline-none"
                  >
                    <option value="all">Show All</option>
                    <option value="passed">Passed Only</option>
                    <option value="failed">Failed Only</option>
                  </select>
                  <div className="relative w-full md:w-48">
                    <span className="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none text-slate-500">
                      <Search className="w-3.5 h-3.5" />
                    </span>
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search prompts..."
                      className="w-full bg-slate-950 border border-slate-850 rounded-xl pl-9 pr-4 py-1.5 text-xs text-slate-200 focus:outline-none"
                    />
                  </div>
                </div>
              </div>

              {/* Dynamic list rendering */}
              <div className="space-y-3.5">
                {subSuiteTab === "original" && filteredAdvResults.map((test) => {
                  const isExpanded = expandedTestId === test.test_id;
                  return (
                    <div 
                      key={test.test_id} 
                      className={`border rounded-xl transition-all ${
                        test.pass 
                          ? "bg-slate-950/20 border-slate-800/80 hover:border-slate-700" 
                          : "bg-rose-950/5 border-rose-500/20 hover:border-rose-500/40"
                      }`}
                    >
                      <div 
                        onClick={() => setExpandedTestId(isExpanded ? null : test.test_id)}
                        className="p-4 flex flex-col md:flex-row justify-between items-start md:items-center gap-3 cursor-pointer select-none"
                      >
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-bold">
                              {test.test_id}
                            </span>
                            <span className="text-slate-400 text-[10px] uppercase font-bold tracking-wider font-mono">
                              {test.category.replace(/_/g, " ")}
                            </span>
                          </div>
                          <p className="text-sm font-semibold text-slate-200">
                            "{test.prompt}"
                          </p>
                        </div>

                        <div className="flex items-center gap-3 shrink-0">
                          {test.tool_calls.length > 0 && (
                            <span className="text-[9px] bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 px-1.5 py-0.5 rounded font-mono">
                              {test.tool_calls.join(", ")}
                            </span>
                          )}
                          {test.pass ? (
                            <span className="px-2.5 py-1 bg-emerald-500/15 text-emerald-400 border border-emerald-500/20 rounded-lg text-xs font-bold flex items-center gap-1">
                              <Check className="w-3.5 h-3.5" />
                              PASSED
                            </span>
                          ) : (
                            <span className="px-2.5 py-1 bg-rose-500/15 text-rose-400 border border-rose-500/20 rounded-lg text-xs font-bold flex items-center gap-1">
                              <XCircle className="w-3.5 h-3.5" />
                              FAILED
                            </span>
                          )}
                        </div>
                      </div>

                      {isExpanded && (
                        <div className="p-4 border-t border-slate-900 bg-slate-950/60 space-y-4 animate-slideDown">
                          {!test.pass && (
                            <div className="p-3.5 bg-rose-500/10 border border-rose-500/25 rounded-xl text-xs space-y-1">
                              <div className="font-bold text-rose-400 uppercase tracking-wider flex items-center gap-1">
                                <AlertTriangle className="w-3.5 h-3.5" />
                                Rule Infraction Details
                              </div>
                              <ul className="list-disc pl-5 text-rose-300/90 space-y-1">
                                {test.failures.map((fail, i) => (
                                  <li key={i}>{fail}</li>
                                ))}
                              </ul>
                            </div>
                          )}

                          <div className="space-y-1">
                            <span className="text-[10px] uppercase font-bold text-slate-500 font-mono block">Recommended Script Output:</span>
                            <div className="bg-slate-900 border border-slate-800 p-4 rounded-xl text-xs text-slate-200 leading-relaxed font-sans">
                              {test.response || <span className="text-slate-600 italic">No statement generated.</span>}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* Bypass Regressions rendering */}
                {subSuiteTab === "regressions" && regressionResults.map((test, index) => {
                  const isExpanded = expandedTestId === test.test_id;
                  return (
                    <div 
                      key={test.test_id || index}
                      className={`border rounded-xl transition-all ${
                        test.pass 
                          ? "bg-slate-950/20 border-slate-800/80 hover:border-slate-700" 
                          : "bg-rose-950/5 border-rose-500/20 hover:border-rose-500/40"
                      }`}
                    >
                      <div 
                        onClick={() => setExpandedTestId(isExpanded ? null : test.test_id)}
                        className="p-4 flex flex-col md:flex-row justify-between items-start md:items-center gap-3 cursor-pointer select-none"
                      >
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-bold">
                              {test.test_id}
                            </span>
                            <span className="text-slate-400 text-[10px] uppercase font-bold tracking-wider font-mono">
                              {test.category.replace(/_/g, " ")}
                            </span>
                          </div>
                          <p className="text-xs font-mono text-indigo-400">
                            Adversarial Bypass Attempt: "{test.prompt}"
                          </p>
                        </div>

                        <div className="shrink-0">
                          {test.pass ? (
                            <span className="px-2.5 py-1 bg-emerald-500/15 text-emerald-400 border border-emerald-500/20 rounded-lg text-xs font-bold flex items-center gap-1">
                              <Check className="w-3.5 h-3.5" />
                              SUCCESSFULLY CAUGHT
                            </span>
                          ) : (
                            <span className="px-2.5 py-1 bg-rose-500/15 text-rose-400 border border-rose-500/20 rounded-lg text-xs font-bold flex items-center gap-1">
                              <XCircle className="w-3.5 h-3.5" />
                              BYPASS LEAK DETECTED
                            </span>
                          )}
                        </div>
                      </div>

                      {isExpanded && (
                        <div className="p-4 border-t border-slate-900 bg-slate-950/60 space-y-4">
                          {!test.pass && (
                            <div className="p-3.5 bg-rose-500/10 border border-rose-500/25 rounded-xl text-xs space-y-1">
                              <div className="font-bold text-rose-400 uppercase tracking-wider flex items-center gap-1">
                                <AlertTriangle className="w-3.5 h-3.5" />
                                Validator Bypass Failure
                              </div>
                              <p className="text-rose-300/90 text-xs">
                                The validator failed to block the response below! The malicious leak slipped through without triggering a FAIL.
                              </p>
                            </div>
                          )}

                          <div className="space-y-1">
                            <span className="text-[10px] uppercase font-bold text-slate-500 font-mono block">Static Malicious Response under check:</span>
                            <div className="bg-slate-900 border border-slate-800 p-4 rounded-xl text-xs text-rose-300 leading-relaxed font-mono">
                              "{test.response}"
                            </div>
                          </div>
                          
                          {test.failures.length > 0 && (
                            <div className="space-y-1">
                              <span className="text-[10px] uppercase font-bold text-emerald-400 font-mono block">Specific Rules Triggered correctly:</span>
                              <ul className="list-disc pl-5 text-xs text-slate-400 space-y-1">
                                {test.failures.map((f: string, i: number) => (
                                  <li key={i}>{f}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* Positive Controls rendering */}
                {subSuiteTab === "controls" && controlResults.map((test, index) => {
                  const isExpanded = expandedTestId === test.test_id;
                  return (
                    <div 
                      key={test.test_id || index}
                      className={`border rounded-xl transition-all ${
                        test.pass 
                          ? "bg-slate-950/20 border-slate-800/80 hover:border-slate-700" 
                          : "bg-rose-950/5 border-rose-500/20 hover:border-rose-500/40"
                      }`}
                    >
                      <div 
                        onClick={() => setExpandedTestId(isExpanded ? null : test.test_id)}
                        className="p-4 flex flex-col md:flex-row justify-between items-start md:items-center gap-3 cursor-pointer select-none"
                      >
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-bold">
                              {test.test_id}
                            </span>
                            <span className="text-slate-400 text-[10px] uppercase font-bold tracking-wider font-mono">
                              POSITIVE CONTROL
                            </span>
                          </div>
                          <p className="text-xs font-mono text-indigo-400">
                            Valid input prompt: "{test.prompt}"
                          </p>
                        </div>

                        <div className="shrink-0">
                          {test.pass ? (
                            <span className="px-2.5 py-1 bg-emerald-500/15 text-emerald-400 border border-emerald-500/20 rounded-lg text-xs font-bold flex items-center gap-1">
                              <Check className="w-3.5 h-3.5" />
                              SUCCESSFULLY ALLOWED
                            </span>
                          ) : (
                            <span className="px-2.5 py-1 bg-rose-500/15 text-rose-400 border border-rose-500/20 rounded-lg text-xs font-bold flex items-center gap-1">
                              <XCircle className="w-3.5 h-3.5" />
                              FALSE BLOCK (OVERBLOCKING)
                            </span>
                          )}
                        </div>
                      </div>

                      {isExpanded && (
                        <div className="p-4 border-t border-slate-900 bg-slate-950/60 space-y-4">
                          {!test.pass && (
                            <div className="p-3.5 bg-rose-500/10 border border-rose-500/25 rounded-xl text-xs space-y-1">
                              <div className="font-bold text-rose-400 uppercase tracking-wider flex items-center gap-1">
                                <AlertTriangle className="w-3.5 h-3.5" />
                                Validator False Positive
                              </div>
                              <p className="text-rose-300/90 text-xs">
                                The validator falsely flagged this completely valid, legitimate response! Overblocking error.
                              </p>
                            </div>
                          )}

                          <div className="space-y-1">
                            <span className="text-[10px] uppercase font-bold text-slate-500 font-mono block">Static Legitimate Response under check:</span>
                            <div className="bg-slate-900 border border-slate-800 p-4 rounded-xl text-xs text-emerald-300 leading-relaxed font-mono">
                              "{test.response}"
                            </div>
                          </div>

                          {test.failures.length > 0 && (
                            <div className="space-y-1">
                              <span className="text-[10px] uppercase font-bold text-rose-400 font-mono block">False Blocking Reasons:</span>
                              <ul className="list-disc pl-5 text-xs text-rose-300 space-y-1 font-mono">
                                {test.failures.map((f: string, i: number) => (
                                  <li key={i}>{f}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
