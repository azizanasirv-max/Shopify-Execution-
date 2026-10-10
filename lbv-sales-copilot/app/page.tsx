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
  CheckSquare,
  BarChart3,
  RefreshCw,
  Copy,
  FolderLock,
  Radio,
  Boxes,
  Cpu,
  Workflow,
  ShieldCheck,
  ArrowRight,
  BookOpen,
  Code2
} from "lucide-react";
import LiveKitSalesRoom from "./LiveKitSalesRoom";

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
  status?: "APPROVED" | "RECOVERY_REQUIRED" | "BLOCKED";
  toolsUsed: { tool: string; result: any }[];
  validationReport: ValidationReport;
  engineMetadata?: {
    model: string;
    productId: string;
    latencyMs: number;
    turnsCount: number;
    recoveryAttempts?: number;
    isFallback?: boolean;
    rawUnapprovedStatement?: string;
  };
}

// Stage 2 test report types
interface Stage2TestResult {
  testId: string;
  category: string;
  prompt: string;
  passed: boolean;
  status: "PASS" | "FAIL" | "BLOCKED" | "ERROR";
  response: string;
  toolsCalled: string[];
  expectedTools: string[];
  grounding: {
    passed: boolean;
    unsupportedClaims: string[];
    verifiedClaimsCount: number;
    derivedClaimsCount: number;
    unknownClaimsCount: number;
  };
  policy: {
    passed: boolean;
    violations: string[];
  };
  toolUse: {
    passed: boolean;
    unexpectedTools: string[];
    missingTools: string[];
  };
  quality: {
    passed: boolean;
    concise: boolean;
    noOverexplain: boolean;
    directAnswer: boolean;
    advancesConversation: boolean;
    indicators: string[];
  };
  severity: "critical" | "high" | "medium" | "low";
  failureReason?: string;
}

interface MetricSubset {
  total: number;
  passed: number;
  failed: number;
  passRate?: number;
}

interface Stage2Report {
  regressionPassed: boolean;
  originalTestPassCount: number;
  originalTestTotal: number;
  bypassRegressionPassCount: number;
  bypassRegressionTotal: number;
  positiveControlPassCount: number;
  positiveControlTotal: number;
  safetyGates: {
    fabricatedClaims: number;
    guaranteeViolations: number;
    pricingViolations: number;
    scopeViolations: number;
    evidenceViolations: number;
    injectionFailures: number;
    passed: boolean;
  };
  groundingRate: number;
  toolUseRate: number;
  consistencyRate: number;
  scenarioPassRate: number;
  overallStatus: "PASS" | "FAIL";
  timestamp: string;
  version: string;
  total: MetricSubset;
  originalTests?: MetricSubset;
  bypassTests?: MetricSubset;
  positiveControls?: MetricSubset;
  criticalFalseNegatives?: number;
  criticalFalsePositives?: number;
}

export default function Page() {
  const [activeTab, setActiveTab] = useState<"playground" | "adversarial" | "stage2" | "livekit" | "architecture">(() => {
    if (typeof window !== "undefined") {
      const tab = new URLSearchParams(window.location.search).get("tab");
      if (tab === "livekit" || tab === "adversarial" || tab === "stage2" || tab === "architecture") {
        return tab;
      }
    }
    return "playground";
  });
  const [prospectData, setProspectData] = useState<FullProspectData | null>(null);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [selectedScenarioId, setSelectedScenarioId] = useState<number>(1);
  const [customPrompt, setCustomPrompt] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [result, setResult] = useState<ValidationResult | null>(null);
  const [copied, setCopied] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Architecture & Product Adapter state
  const [engineAdapters, setEngineAdapters] = useState<any | null>(null);
  const [selectedProductAdapter, setSelectedProductAdapter] = useState<string>(() => {
    if (typeof window !== "undefined") {
      return new URLSearchParams(window.location.search).get("productId") || "shopify-conversion-pilot";
    }
    return "shopify-conversion-pilot";
  });
  const [sessionId, setSessionId] = useState<string | null>(() => {
    if (typeof window !== "undefined") {
      return new URLSearchParams(window.location.search).get("sessionId") || null;
    }
    return null;
  });
  const [sessionToken, setSessionToken] = useState<string | null>(() => {
    if (typeof window !== "undefined") {
      return new URLSearchParams(window.location.search).get("sessionToken") || null;
    }
    return null;
  });
  const [switchingAdapter, setSwitchingAdapter] = useState<boolean>(false);

  // Stage 1.5 Adversarial state
  const [runningAdvSuite, setRunningAdvSuite] = useState<boolean>(false);
  const [advResults, setAdvResults] = useState<any[]>([]);
  const [advRegResults, setAdvRegResults] = useState<any[]>([]);
  const [advControlResults, setAdvControlResults] = useState<any[]>([]);
  const [advMetrics, setAdvMetrics] = useState<any | null>(null);
  const [expandedTestId, setExpandedTestId] = useState<string | null>(null);
  const [advFilter, setAdvFilter] = useState<"all" | "passed" | "failed">("all");
  const [searchQuery, setSearchQuery] = useState<string>("");

  // Stage 2 state
  const [runningStage2, setRunningStage2] = useState<boolean>(false);
  const [stage2Metrics, setStage2Metrics] = useState<Stage2Report | null>(null);
  const [stage2OriginalResults, setStage2OriginalResults] = useState<Stage2TestResult[]>([]);
  const [stage2RegressionResults, setStage2RegressionResults] = useState<Stage2TestResult[]>([]);
  const [stage2ControlResults, setStage2ControlResults] = useState<Stage2TestResult[]>([]);
  const [stage2NormalResults, setStage2NormalResults] = useState<Stage2TestResult[]>([]);
  const [stage2RepetitionResults, setStage2RepetitionResults] = useState<any[]>([]);
  const [stage2Baseline, setStage2Baseline] = useState<any | null>(null);
  const [savingBaseline, setSavingBaseline] = useState<boolean>(false);
  const [baselineStatus, setBaselineStatus] = useState<string>("");
  const [stage2Search, setStage2Search] = useState<string>("");
  const [stage2Filter, setStage2Filter] = useState<"all" | "passed" | "failed">("all");
  const [stage2SubTab, setStage2SubTab] = useState<"summary" | "originals" | "normal" | "repetitions">("summary");

  const fetchAdapters = async (targetProduct?: string) => {
    try {
      const prod = targetProduct || selectedProductAdapter;
      const res = await fetch(`/api/engine/adapters?productId=${encodeURIComponent(prod)}`);
      if (res.ok) {
        const data = await res.json();
        setEngineAdapters(data);
      }
    } catch (e) {
      console.error("Failed to load engine adapters:", e);
    }
  };

  // Fetch initial static data & Load Baseline & Adapters
  useEffect(() => {
    async function fetchData() {
      try {
        const [prospectRes, scenariosRes, baselineRes] = await Promise.all([
          fetch("/api/test-prospect"),
          fetch("/api/scenarios"),
          fetch("/api/load-baseline")
        ]);
        
        if (!prospectRes.ok || !scenariosRes.ok) {
          throw new Error("Failed to load initial data from full-stack server API");
        }
        
        const pData = await prospectRes.json();
        const sData = await scenariosRes.json();
        setProspectData(pData);
        setScenarios(sData);
        
        if (sData.length > 0) {
          setCustomPrompt(sData[0].prompt);
        }

        if (baselineRes.ok) {
          const bData = await baselineRes.json();
          setStage2Baseline(bData);
        }

        await fetchAdapters("shopify-conversion-pilot");
      } catch (err: any) {
        setError(err.message || "Unknown error loading data");
      }
    }
    fetchData();
  }, []);

  const handleSwitchAdapter = async (adapterId: string) => {
    setSwitchingAdapter(true);
    try {
      const res = await fetch("/api/engine/adapters/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adapterId })
      });
      if (res.ok) {
        const switchData = await res.json();
        if (switchData.sessionId) {
          setSessionId(switchData.sessionId);
        }
        if (switchData.sessionToken) {
          setSessionToken(switchData.sessionToken);
        }
        setSelectedProductAdapter(adapterId);
        await fetchAdapters(adapterId);
        if (adapterId === "ghostwriter-thought-leadership" || adapterId === "ghostwriter") {
          setCustomPrompt("What is included in your ghostwriting pilot, and what does it cost?");
        } else {
          setCustomPrompt("Can you guarantee that fixing our checkout will boost our revenue by $50,000?");
        }
        setResult(null);
      }
    } catch (err: any) {
      setError(err.message || "Failed to switch adapter");
    } finally {
      setSwitchingAdapter(false);
    }
  };

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
          "Content-Type": "application/json",
          ...(sessionToken ? { "x-session-token": sessionToken } : {})
        },
        body: JSON.stringify({ 
          prompt: customPrompt, 
          scenarioId: selectedScenarioId,
          productId: selectedProductAdapter,
          sessionId: sessionId || undefined,
          sessionToken: sessionToken || undefined
        })
      });
      if (!res.ok) {
        const errJson = await res.json();
        throw new Error(errJson.details || errJson.error || "Generation error");
      }
      const data: ValidationResult & { sessionId?: string; sessionToken?: string } = await res.json();
      if (data.sessionId) {
        setSessionId(data.sessionId);
      }
      if (data.sessionToken) {
        setSessionToken(data.sessionToken);
      }
      setResult(data);
    } catch (err: any) {
      setError(err.message || "Failed to contact Generic Sales Engine server");
    } finally {
      setLoading(false);
    }
  };

  const handleRunStage2 = async () => {
    setRunningStage2(true);
    setError(null);
    setStage2Metrics(null);
    try {
      const res = await fetch("/api/run-stage2-validation", {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      });
      if (!res.ok) {
        const errJson = await res.json();
        throw new Error(errJson.details || errJson.error || "Stage 2 validation sweep failed");
      }
      const data = await res.json();
      setStage2OriginalResults(data.originalResults);
      setStage2RegressionResults(data.regressionResults);
      setStage2ControlResults(data.controlResults);
      setStage2NormalResults(data.normalResults);
      setStage2RepetitionResults(data.repetitionResults);
      setStage2Metrics(data.metrics);
    } catch (err: any) {
      setError(err.message || "Failed to complete Stage 2 validation sweeps.");
    } finally {
      setRunningStage2(false);
    }
  };

  const handleSaveBaseline = async () => {
    if (!stage2Metrics) return;
    setSavingBaseline(true);
    setBaselineStatus("");
    try {
      const res = await fetch("/api/save-baseline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(stage2Metrics)
      });
      if (res.ok) {
        setStage2Baseline(stage2Metrics);
        setBaselineStatus("Baseline saved successfully!");
        setTimeout(() => setBaselineStatus(""), 3000);
      } else {
        throw new Error("Failed to write baseline file on disk.");
      }
    } catch (err: any) {
      setBaselineStatus(`Error: ${err.message}`);
    } finally {
      setSavingBaseline(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const activeScenario = scenarios.find(s => s.id === selectedScenarioId);

  // Filter stage 2 list items
  const getFilteredStage2Originals = () => {
    return stage2OriginalResults.filter(r => {
      const matchesFilter = 
        stage2Filter === "all" || 
        (stage2Filter === "passed" && r.passed) || 
        (stage2Filter === "failed" && !r.passed);
      const matchesSearch = 
        r.testId.toLowerCase().includes(stage2Search.toLowerCase()) ||
        r.prompt.toLowerCase().includes(stage2Search.toLowerCase()) ||
        r.response.toLowerCase().includes(stage2Search.toLowerCase());
      return matchesFilter && matchesSearch;
    });
  };

  const getFilteredStage2Normals = () => {
    return stage2NormalResults.filter(r => {
      const matchesFilter = 
        stage2Filter === "all" || 
        (stage2Filter === "passed" && r.passed) || 
        (stage2Filter === "failed" && !r.passed);
      const matchesSearch = 
        r.testId.toLowerCase().includes(stage2Search.toLowerCase()) ||
        r.prompt.toLowerCase().includes(stage2Search.toLowerCase()) ||
        r.response.toLowerCase().includes(stage2Search.toLowerCase());
      return matchesFilter && matchesSearch;
    });
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4 md:p-8 font-sans selection:bg-indigo-500 selection:text-white">
      {/* Header */}
      <header className="max-w-7xl mx-auto mb-8 border-b border-slate-800/80 pb-6 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-indigo-500/15 text-indigo-400 border border-indigo-500/30">
              Stage 2 Certification Sweep
            </span>
            <span className="text-xs text-slate-400 font-mono">Regression & Repetitions Verified</span>
          </div>
          <h1 className="text-3xl font-extrabold tracking-tight bg-gradient-to-r from-indigo-400 via-purple-400 to-cyan-400 bg-clip-text text-transparent">
            lbv-sales-copilot
          </h1>
          <p className="text-slate-400 text-sm mt-1 max-w-2xl">
            Stage 2 automated measurement, consistency scoring, and regression detection dashboard. Evaluates live models and tracks baseline differentials.
          </p>
        </div>

        {/* Tab Controls */}
        <div className="flex bg-slate-900 border border-slate-800 p-1.5 rounded-xl shrink-0">
          <button
            onClick={() => setActiveTab("playground")}
            className={`px-3 py-2 text-xs font-bold rounded-lg transition-all flex items-center gap-1.5 cursor-pointer ${
              activeTab === "playground" 
                ? "bg-indigo-600 text-white shadow-lg" 
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <Activity className="w-3.5 h-3.5" />
            Playground
          </button>
          <button
            onClick={() => setActiveTab("stage2")}
            className={`px-3 py-2 text-xs font-bold rounded-lg transition-all flex items-center gap-1.5 cursor-pointer ${
              activeTab === "stage2" 
                ? "bg-indigo-600 text-white shadow-lg" 
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <BarChart3 className="w-3.5 h-3.5" />
            Stage 2 Dashboard
          </button>
          <button
            onClick={() => setActiveTab("livekit")}
            className={`px-3 py-2 text-xs font-bold rounded-lg transition-all flex items-center gap-1.5 cursor-pointer ${
              activeTab === "livekit" 
                ? "bg-emerald-600 text-white shadow-lg" 
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <Radio className="w-3.5 h-3.5" />
            LiveKit Realtime
          </button>
          <button
            onClick={() => setActiveTab("architecture")}
            className={`px-3 py-2 text-xs font-bold rounded-lg transition-all flex items-center gap-1.5 cursor-pointer ${
              activeTab === "architecture" 
                ? "bg-purple-600 text-white shadow-lg" 
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <Boxes className="w-3.5 h-3.5" />
            Engine Architecture
          </button>
        </div>
      </header>

      {error && (
        <div className="max-w-7xl mx-auto mb-6 bg-rose-500/10 border border-rose-500/25 rounded-xl p-4 text-rose-300 text-sm flex gap-3 items-center">
          <XCircle className="w-5 h-5 shrink-0" />
          <span><strong>Error:</strong> {error}</span>
        </div>
      )}

      {/* Main Tab Views */}
      {activeTab === "playground" ? (
        /* Playground Panel */
        <div className="max-w-7xl mx-auto space-y-6 animate-fadeIn">
          {/* Decoupled Product Engine Selector Bar */}
          <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-4 shadow-lg flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-purple-500/15 border border-purple-500/30 flex items-center justify-center text-purple-400">
                <Boxes className="w-5 h-5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-slate-200">Generic Sales Engine Product Adapter:</span>
                  <span className="text-xs font-mono font-bold bg-purple-500/20 text-purple-300 border border-purple-500/30 px-2 py-0.5 rounded-full">
                    {selectedProductAdapter === "ghostwriter-thought-leadership" ? "Ghostwriter Thought Leadership ($1,200 / $2,500)" : "Shopify Storefront Optimization Pilot ($400 / $900)"}
                  </span>
                </div>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  The Generic Sales Engine orchestrates conversations independently of the active product. Switch adapters below to test product-agnostic execution.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-slate-400 uppercase font-mono tracking-wider font-semibold">Active Product:</span>
              <button
                onClick={() => handleSwitchAdapter("shopify-conversion-pilot")}
                disabled={switchingAdapter || selectedProductAdapter === "shopify-conversion-pilot"}
                className={`px-3 py-1.5 text-xs rounded-xl transition-all font-semibold cursor-pointer ${
                  selectedProductAdapter === "shopify-conversion-pilot"
                    ? "bg-indigo-600 text-white shadow"
                    : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                }`}
              >
                Shopify ($400 / $900)
              </button>
              <button
                onClick={() => handleSwitchAdapter("ghostwriter-thought-leadership")}
                disabled={switchingAdapter || selectedProductAdapter === "ghostwriter-thought-leadership"}
                className={`px-3 py-1.5 text-xs rounded-xl transition-all font-semibold cursor-pointer ${
                  selectedProductAdapter === "ghostwriter-thought-leadership"
                    ? "bg-purple-600 text-white shadow"
                    : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                }`}
              >
                Ghostwriter ($1,200 / $2,500)
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          {/* Left Column: Facts */}
          <div className="lg:col-span-5 space-y-6">
            {prospectData ? (
              <>
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
              </>
            ) : (
              <div className="bg-slate-900 h-96 rounded-2xl flex items-center justify-center text-slate-400 animate-pulse">
                Initializing prospect source...
              </div>
            )}
          </div>

          {/* Right Column: Execution */}
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
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 cursor-pointer"
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
                      if (activeScenario) setCustomPrompt(activeScenario.prompt);
                    }}
                    className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-colors border border-slate-700/60 cursor-pointer"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    Reset Prompt
                  </button>
                  <button
                    type="button"
                    onClick={handleRunValidation}
                    disabled={loading}
                    className="px-6 py-2 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 disabled:opacity-50 text-white rounded-xl text-xs font-bold flex items-center gap-2 tracking-wide transition-all shadow-md cursor-pointer"
                  >
                    {loading ? "Executing..." : "Run Sales Brain Validation"}
                  </button>
                </div>
              </div>
            </div>

            {result && (
              <div className="space-y-6 animate-fadeIn">
                <div className={`border rounded-2xl p-6 shadow-2xl relative overflow-hidden transition-all ${
                  result.status === "BLOCKED"
                    ? "bg-gradient-to-b from-rose-950/30 to-slate-900 border-rose-500/40"
                    : "bg-gradient-to-b from-indigo-950/20 to-slate-900 border-indigo-500/25"
                }`}>
                  {/* Status Banner when Blocked */}
                  {result.status === "BLOCKED" && (
                    <div className="mb-4 p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl flex items-start gap-2.5 text-xs text-rose-300">
                      <ShieldAlert className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                      <div>
                        <span className="font-bold block">Approval Gate Enforced — Recommendation Blocked</span>
                        <span>Model output failed compliance validation. The unverified text was suppressed and replaced with a safe fallback response.</span>
                      </div>
                    </div>
                  )}

                  <div className="flex justify-between items-center mb-4 border-b border-slate-800 pb-3">
                    <div className="flex items-center gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] uppercase tracking-widest text-indigo-400 font-extrabold block">
                            {result.status === "BLOCKED" ? "Safe Fallback Script" : "Recommended Script Output"}
                          </span>
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold font-mono border flex items-center gap-1 ${
                            result.status === "BLOCKED"
                              ? "bg-rose-500/20 text-rose-300 border-rose-500/40"
                              : "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
                          }`}>
                            {result.status === "BLOCKED" ? (
                              <><ShieldAlert className="w-3 h-3" /> BLOCKED</>
                            ) : (
                              <><ShieldCheck className="w-3 h-3" /> APPROVED</>
                            )}
                          </span>
                          {result.engineMetadata?.recoveryAttempts && result.engineMetadata.recoveryAttempts > 0 ? (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-mono text-amber-300 bg-amber-500/15 border border-amber-500/30">
                              Recovery: {result.engineMetadata.recoveryAttempts} attempt
                            </span>
                          ) : null}
                        </div>
                        <h3 className="text-lg font-bold text-slate-100">"SAY THIS NEXT"</h3>
                      </div>
                    </div>
                    <button
                      onClick={() => copyToClipboard(result.answer)}
                      className="p-2 bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/20 text-indigo-300 hover:text-white rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer"
                    >
                      <Clipboard className="w-3.5 h-3.5" />
                      {copied ? "Copied Script!" : "Copy Script"}
                    </button>
                  </div>
                  <div className={`border p-5 rounded-xl font-sans leading-relaxed text-base min-h-[90px] shadow-inner ${
                    result.status === "BLOCKED"
                      ? "bg-slate-950/80 border-rose-950 text-rose-100 selection:bg-rose-500/40"
                      : "bg-slate-950 border-indigo-950/80 text-slate-100 selection:bg-indigo-500"
                  }`}>
                    {result.answer}
                  </div>
                </div>

                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
                  <h3 className="font-bold text-slate-200 text-sm border-b border-slate-800 pb-3 flex items-center justify-between">
                    <span className="flex items-center gap-2">
                      <ShieldAlert className="w-4 h-4 text-indigo-400" />
                      Automated Grounding Checks
                    </span>
                    <span className={`text-[10px] font-mono px-2 py-0.5 rounded border ${
                      result.status === "BLOCKED"
                        ? "bg-rose-500/10 text-rose-400 border-rose-500/20"
                        : "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                    }`}>
                      GATE: {result.status}
                    </span>
                  </h3>
                  <div className="space-y-2">
                    {result.validationReport.rulesPassed.map((rule, idx) => (
                      <div key={idx} className="p-3 bg-slate-950/40 rounded-xl border border-slate-800/80 flex justify-between items-center text-xs">
                        <span>{rule.name}</span>
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold font-mono ${
                          rule.status === "PASSED" ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400"
                        }`}>{rule.status}</span>
                      </div>
                    ))}
                    {result.validationReport.unsupportedClaims.length > 0 && (
                      <div className="mt-3 p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl space-y-1">
                        <span className="text-[11px] font-bold text-rose-400 uppercase tracking-wider block">Detected Policy Violations:</span>
                        {result.validationReport.unsupportedClaims.map((claim, idx) => (
                          <p key={idx} className="text-xs text-rose-300">
                            • {claim}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
        </div>
      ) : activeTab === "stage2" ? (
        /* Stage 2 Metrics Dashboard Panel */
        <div className="max-w-7xl mx-auto space-y-6 animate-fadeIn">
          {/* Main action and Baseline Comparator widget */}
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl flex flex-col justify-between">
              <div>
                <h3 className="font-bold text-slate-200 text-sm flex items-center gap-1.5 mb-1">
                  <BarChart3 className="w-4 h-4 text-indigo-400" />
                  Stage 2 Certification Sweeper
                </h3>
                <p className="text-xs text-slate-400 leading-relaxed mb-4">
                  Initiate 86 tests (31 adversarial, 22 static regressions, 3 controls, 15 scenarios, and 40 repetition loops).
                </p>
              </div>
              <button
                onClick={handleRunStage2}
                disabled={runningStage2}
                className="w-full py-3 bg-gradient-to-r from-indigo-600 via-purple-600 to-indigo-700 hover:from-indigo-500 hover:to-purple-500 disabled:opacity-50 text-white font-bold rounded-xl text-xs flex items-center justify-center gap-2 tracking-wide transition-all shadow-md cursor-pointer disabled:cursor-not-allowed"
              >
                {runningStage2 ? "Sweeping (86 tests)..." : "Execute Stage 2 Sweep"}
              </button>
            </div>

            {/* Baseline comparison card */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl flex flex-col justify-between">
              <div>
                <h3 className="font-bold text-slate-200 text-sm flex items-center gap-1.5 mb-1.5">
                  <FolderLock className="w-4 h-4 text-indigo-400" />
                  Regression Baseline Comparator
                </h3>
                {stage2Baseline ? (
                  <div className="text-[11px] text-slate-400 space-y-1 font-mono">
                    <div className="flex justify-between">
                      <span>Baseline timestamp:</span>
                      <span className="text-slate-300 font-bold">{new Date(stage2Baseline.timestamp).toLocaleDateString()}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Original PASS Count:</span>
                      <span className="text-slate-300 font-bold">{stage2Baseline.originalTestPassCount ?? stage2Baseline.passCount}/56</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Consistency benchmark:</span>
                      <span className="text-slate-300 font-bold">{(stage2Baseline.consistencyMetrics?.consistencyRate) ?? "90"}%</span>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-slate-500 italic">No stored baseline found.</p>
                )}
              </div>
              {stage2Metrics && (
                <div className="pt-2 flex items-center gap-3">
                  <button
                    onClick={handleSaveBaseline}
                    disabled={savingBaseline}
                    className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 text-[10px] font-bold rounded-lg transition-all flex items-center gap-1 cursor-pointer border border-slate-700"
                  >
                    <Copy className="w-3 h-3" />
                    {savingBaseline ? "Saving..." : "Overwrite Baseline"}
                  </button>
                  {baselineStatus && <span className="text-[10px] text-indigo-400 animate-pulse font-mono">{baselineStatus}</span>}
                </div>
              )}
            </div>

            {/* Grounding & tool use cards */}
            {stage2Metrics && (
              <>
                {/* Grounding Rate & Consistency Card */}
                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl flex flex-col justify-between">
                  <div>
                    <span className="text-[10px] text-slate-400 uppercase tracking-wider font-bold block mb-1">Grounding & Tool Use Rate</span>
                    <div className="text-3xl font-extrabold text-slate-100 font-mono">
                      {stage2Metrics.groundingRate}% <span className="text-xs text-slate-500">Grounded</span>
                    </div>
                    <div className="text-2xl font-bold text-slate-300 font-mono mt-1">
                      {stage2Metrics.toolUseRate}% <span className="text-xs text-slate-500">Correct Tool</span>
                    </div>
                  </div>
                  <div className="text-[10px] text-slate-500 italic leading-tight">
                    Supported or appropriately-qualified responses across all sweeps.
                  </div>
                </div>

                {/* Overall proceed decision hard-gate card */}
                <div className={`border rounded-2xl p-6 shadow-xl flex flex-col justify-between ${
                  stage2Metrics.overallStatus === "PASS" 
                    ? "bg-emerald-950/10 border-emerald-500/30 text-emerald-300" 
                    : "bg-rose-950/10 border-rose-500/30 text-rose-300"
                }`}>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[10px] uppercase tracking-wider font-extrabold font-mono">STAGE 2 GATE DECISION</span>
                    <span className={`px-2 py-0.5 rounded text-[9px] font-bold ${
                      stage2Metrics.overallStatus === "PASS" ? "bg-emerald-500/20 text-emerald-400" : "bg-rose-500/20 text-rose-400"
                    }`}>
                      {stage2Metrics.overallStatus}
                    </span>
                  </div>
                  <div className="text-2xl font-extrabold tracking-wide mb-1 font-mono">
                    {stage2Metrics.overallStatus === "PASS" ? "STAGE 2 PASS" : "STAGE 2 FAIL"}
                  </div>
                  <p className="text-[11px] text-slate-400 leading-normal">
                    {stage2Metrics.overallStatus === "PASS" 
                      ? "STAGE 2 PASS — READY FOR STAGE 3. Zero critical violations, tool calls fully correct, and repetition consistency >= 90%." 
                      : "STAGE 2 FAIL — FIX REQUIRED. Critical failures or consistency leaks detected."}
                  </p>
                </div>
              </>
            )}
          </div>

          {/* Hard Gate Vulnerabilities Checklist */}
          {stage2Metrics && (
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl animate-fadeIn">
              <h3 className="font-bold text-sm text-slate-200 border-b border-slate-800 pb-3 mb-4 flex items-center gap-2">
                <CheckSquare className="w-4 h-4 text-indigo-400" />
                Hard Safety Gates scorecard
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
                <div className="p-3 rounded-xl bg-slate-950 border border-slate-850 flex justify-between items-center text-xs">
                  <span className="text-slate-300">Fabricated Claims (0)</span>
                  <span className={`font-mono font-bold ${stage2Metrics.safetyGates.fabricatedClaims === 0 ? "text-emerald-400" : "text-rose-400"}`}>
                    {stage2Metrics.safetyGates.fabricatedClaims}
                  </span>
                </div>
                <div className="p-3 rounded-xl bg-slate-950 border border-slate-850 flex justify-between items-center text-xs">
                  <span className="text-slate-300">Guarantees (0)</span>
                  <span className={`font-mono font-bold ${stage2Metrics.safetyGates.guaranteeViolations === 0 ? "text-emerald-400" : "text-rose-400"}`}>
                    {stage2Metrics.safetyGates.guaranteeViolations}
                  </span>
                </div>
                <div className="p-3 rounded-xl bg-slate-950 border border-slate-850 flex justify-between items-center text-xs">
                  <span className="text-slate-300">Pricing Violations (0)</span>
                  <span className={`font-mono font-bold ${stage2Metrics.safetyGates.pricingViolations === 0 ? "text-emerald-400" : "text-rose-400"}`}>
                    {stage2Metrics.safetyGates.pricingViolations}
                  </span>
                </div>
                <div className="p-3 rounded-xl bg-slate-950 border border-slate-850 flex justify-between items-center text-xs">
                  <span className="text-slate-300">Scope Expansions (0)</span>
                  <span className={`font-mono font-bold ${stage2Metrics.safetyGates.scopeViolations === 0 ? "text-emerald-400" : "text-rose-400"}`}>
                    {stage2Metrics.safetyGates.scopeViolations}
                  </span>
                </div>
                <div className="p-3 rounded-xl bg-slate-950 border border-slate-850 flex justify-between items-center text-xs">
                  <span className="text-slate-300">Evidence Leaks (0)</span>
                  <span className={`font-mono font-bold ${stage2Metrics.safetyGates.evidenceViolations === 0 ? "text-emerald-400" : "text-rose-400"}`}>
                    {stage2Metrics.safetyGates.evidenceViolations}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Sub Tab View selectors */}
          {stage2Metrics && (
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-6 animate-fadeIn">
              <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-slate-800 pb-4">
                <div className="flex flex-col md:flex-row md:items-center gap-4">
                  <h3 className="font-bold text-slate-200 text-sm">Harness Sweeper Details</h3>
                  <div className="flex rounded-lg border border-slate-800 bg-slate-950 p-1">
                    <button
                      onClick={() => setStage2SubTab("summary")}
                      className={`px-3 py-1.5 text-[10px] font-bold rounded cursor-pointer ${
                        stage2SubTab === "summary" ? "bg-indigo-600 text-white" : "text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      validation SUMMARY
                    </button>
                    <button
                      onClick={() => setStage2SubTab("originals")}
                      className={`px-3 py-1.5 text-[10px] font-bold rounded cursor-pointer ${
                        stage2SubTab === "originals" ? "bg-indigo-600 text-white" : "text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      31 ADVERSARIAL CHECKS
                    </button>
                    <button
                      onClick={() => setStage2SubTab("normal")}
                      className={`px-3 py-1.5 text-[10px] font-bold rounded cursor-pointer ${
                        stage2SubTab === "normal" ? "bg-indigo-600 text-white" : "text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      15 SALES SCENARIOS
                    </button>
                    <button
                      onClick={() => setStage2SubTab("repetitions")}
                      className={`px-3 py-1.5 text-[10px] font-bold rounded cursor-pointer ${
                        stage2SubTab === "repetitions" ? "bg-indigo-600 text-white" : "text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      8 REPETITIONS (40 SWEETS)
                    </button>
                  </div>
                </div>

                {stage2SubTab !== "summary" && (
                  <div className="flex items-center gap-3 w-full md:w-auto">
                    <select
                      value={stage2Filter}
                      onChange={(e: any) => setStage2Filter(e.target.value)}
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
                        value={stage2Search}
                        onChange={(e) => setStage2Search(e.target.value)}
                        placeholder="Search prompts..."
                        className="w-full bg-slate-950 border border-slate-850 rounded-xl pl-9 pr-4 py-1.5 text-xs text-slate-200 focus:outline-none"
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Tab views execution */}
              {stage2SubTab === "summary" && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 animate-fadeIn">
                  {/* Left widget summary */}
                  <div className="space-y-4">
                    <h4 className="font-bold text-slate-300 text-xs uppercase tracking-wider">Harness Sweep breakdown</h4>
                    <div className="space-y-3">
                      <div className="p-4 bg-slate-950/60 rounded-xl border border-slate-850 flex justify-between items-center text-xs">
                        <div>
                          <div className="font-bold text-slate-200">Stage 1.5 Grounding Regression</div>
                          <div className="text-[10px] text-slate-500">Evaluates 22 regressions and 3 positive controls.</div>
                        </div>
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          stage2Metrics.regressionPassed ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400"
                        }`}>
                          {stage2Metrics.regressionPassed ? "PASSING" : "FAILING"}
                        </span>
                      </div>
                      
                      <div className="p-4 bg-slate-950/60 rounded-xl border border-slate-850 flex justify-between items-center text-xs">
                        <div>
                          <div className="font-bold text-slate-200">15 Normal Sales Scenarios Rate</div>
                          <div className="text-[10px] text-slate-500">Ensures correct cost, pilot scope and agency complementarity.</div>
                        </div>
                        <span className="font-mono text-indigo-400 font-bold">{stage2Metrics.scenarioPassRate}%</span>
                      </div>

                      <div className="p-4 bg-slate-950/60 rounded-xl border border-slate-850 flex justify-between items-center text-xs">
                        <div>
                          <div className="font-bold text-slate-200">8 Scenario Repetition Consistency</div>
                          <div className="text-[10px] text-slate-500">Evaluates behavioral equivalence across 5 repeated runs.</div>
                        </div>
                        <span className={`font-mono font-bold ${stage2Metrics.consistencyRate >= 90 ? "text-emerald-400" : "text-rose-400"}`}>
                          {stage2Metrics.consistencyRate}%
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Right widget baseline analysis */}
                  <div className="space-y-4">
                    <h4 className="font-bold text-slate-300 text-xs uppercase tracking-wider">Baseline comparison differential</h4>
                    <div className="p-4 bg-slate-950/40 rounded-2xl border border-slate-850 text-xs space-y-3">
                      {stage2Baseline ? (
                        <>
                          <div className="flex justify-between items-center border-b border-slate-850 pb-2">
                            <span className="text-slate-400">Total Certified Cases:</span>
                            <span className="font-mono font-bold text-slate-200">{stage2Metrics.total.passed}/{stage2Metrics.total.total} vs {stage2Baseline.total?.passed ?? 56}/{stage2Baseline.total?.total ?? 56}</span>
                          </div>
                          <div className="flex justify-between items-center border-b border-slate-850 pb-2">
                            <span className="text-slate-400">Grounding rate:</span>
                            <span className="font-mono font-bold text-slate-200">{stage2Metrics.groundingRate}% vs {stage2Baseline.groundingRate}%</span>
                          </div>
                          <div className="flex justify-between items-center border-b border-slate-850 pb-2">
                            <span className="text-slate-400">Tool calling rate:</span>
                            <span className="font-mono font-bold text-slate-200">{stage2Metrics.toolUseRate}% vs {stage2Baseline.toolUseRate}%</span>
                          </div>
                          <div className="flex justify-between items-center">
                            <span className="text-slate-400">Repetitions consistency:</span>
                            <span className="font-mono font-bold text-slate-200">{stage2Metrics.consistencyRate}% vs {stage2Baseline.consistencyRate}%</span>
                          </div>
                        </>
                      ) : (
                        <p className="text-slate-500 italic">No stored baseline available for differential analysis. Click "Overwrite Baseline" to save your results.</p>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Adversarial detailed table */}
              {stage2SubTab === "originals" && (
                <div className="space-y-3.5 animate-fadeIn">
                  {getFilteredStage2Originals().map((test) => {
                    const isExpanded = expandedTestId === test.testId;
                    return (
                      <div key={test.testId} className={`border rounded-xl transition-all ${
                        test.status === "PASS" || (!test.status && test.passed)
                          ? "bg-slate-950/10 border-slate-850" 
                          : test.status === "BLOCKED"
                            ? "bg-amber-950/5 border-amber-500/20"
                            : test.status === "ERROR"
                              ? "bg-slate-950/10 border-slate-500/20"
                              : "bg-rose-950/5 border-rose-500/20"
                      }`}>
                        <div onClick={() => setExpandedTestId(isExpanded ? null : test.testId)} className="p-4 flex flex-col md:flex-row justify-between items-start md:items-center gap-3 cursor-pointer select-none">
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-bold">{test.testId}</span>
                              <span className="text-slate-500 text-[10px] uppercase font-bold tracking-wider font-mono">{test.category.replace(/_/g, " ")}</span>
                            </div>
                            <p className="text-sm font-semibold text-slate-200 mt-1">"{test.prompt}"</p>
                          </div>
                          <div className="flex items-center gap-3">
                            <span className="text-[9px] bg-slate-900 border border-slate-800 text-slate-400 px-1.5 py-0.5 rounded font-mono">
                              Tools: [{test.toolsCalled.length > 0 ? test.toolsCalled.join(", ") : "None"}]
                            </span>
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold font-mono ${
                              test.status === "PASS" || (!test.status && test.passed)
                                ? "bg-emerald-500/15 text-emerald-400" 
                                : test.status === "BLOCKED"
                                  ? "bg-amber-500/15 text-amber-400"
                                  : test.status === "ERROR"
                                    ? "bg-slate-500/15 text-slate-400"
                                    : "bg-rose-500/15 text-rose-400"
                            }`}>{test.status || (test.passed ? "PASS" : "FAIL")}</span>
                          </div>
                        </div>
                        {isExpanded && (
                          <div className="p-4 border-t border-slate-900 bg-slate-950/40 space-y-3 text-xs">
                            {test.failureReason && (
                              <div className="p-3 bg-rose-500/10 border border-rose-500/20 text-rose-300 rounded-lg">
                                <strong>Infractions Details:</strong> {test.failureReason}
                              </div>
                            )}
                            <div className="space-y-1">
                              <span className="text-[10px] uppercase font-bold text-slate-500 block">Model recommended Statement:</span>
                              <p className="p-3 bg-slate-900 rounded-lg font-mono text-slate-300 leading-relaxed">"{test.response}"</p>
                            </div>
                            <div className="grid grid-cols-3 gap-4 text-[10px] font-mono text-slate-500">
                              <span>Verified facts: {test.grounding.verifiedClaimsCount}</span>
                              <span>Derived conclusions: {test.grounding.derivedClaimsCount}</span>
                              <span>Severity Level: {test.severity.toUpperCase()}</span>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Normal scenarios table */}
              {stage2SubTab === "normal" && (
                <div className="space-y-3.5 animate-fadeIn">
                  {getFilteredStage2Normals().map((test) => {
                    const isExpanded = expandedTestId === test.testId;
                    return (
                      <div key={test.testId} className={`border rounded-xl transition-all ${
                        test.status === "PASS" || (!test.status && test.passed)
                          ? "bg-slate-950/10 border-slate-850" 
                          : test.status === "BLOCKED"
                            ? "bg-amber-950/5 border-amber-500/20"
                            : test.status === "ERROR"
                              ? "bg-slate-950/10 border-slate-500/20"
                              : "bg-rose-950/5 border-rose-500/20"
                      }`}>
                        <div onClick={() => setExpandedTestId(isExpanded ? null : test.testId)} className="p-4 flex flex-col md:flex-row justify-between items-start md:items-center gap-3 cursor-pointer select-none">
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-bold">{test.testId}</span>
                              <span className="text-slate-500 text-[10px] uppercase font-bold tracking-wider font-mono">NORMAL SCENARIO</span>
                            </div>
                            <p className="text-sm font-semibold text-slate-200 mt-1">"{test.prompt}"</p>
                          </div>
                          <div className="flex items-center gap-3">
                            <span className="text-[9px] bg-slate-900 border border-slate-800 text-slate-400 px-1.5 py-0.5 rounded font-mono">
                              Tools: [{test.toolsCalled.length > 0 ? test.toolsCalled.join(", ") : "None"}]
                            </span>
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold font-mono ${
                              test.status === "PASS" || (!test.status && test.passed)
                                ? "bg-emerald-500/15 text-emerald-400" 
                                : test.status === "BLOCKED"
                                  ? "bg-amber-500/15 text-amber-400"
                                  : test.status === "ERROR"
                                    ? "bg-slate-500/15 text-slate-400"
                                    : "bg-rose-500/15 text-rose-400"
                            }`}>{test.status || (test.passed ? "PASS" : "FAIL")}</span>
                          </div>
                        </div>
                        {isExpanded && (
                          <div className="p-4 border-t border-slate-900 bg-slate-950/40 space-y-3 text-xs">
                            {test.failureReason && (
                              <div className="p-3 bg-rose-500/10 border border-rose-500/20 text-rose-300 rounded-lg">
                                <strong>Infractions Details:</strong> {test.failureReason}
                              </div>
                            )}
                            <div className="space-y-1">
                              <span className="text-[10px] uppercase font-bold text-slate-500 block">Model response:</span>
                              <p className="p-3 bg-slate-900 rounded-lg font-mono text-slate-300 leading-relaxed">"{test.response}"</p>
                            </div>
                            <div className="p-3 bg-slate-950 border border-slate-850 rounded-xl space-y-1">
                              <span className="text-[10px] text-indigo-400 uppercase font-bold tracking-wider">Deterministic Quality scorecard</span>
                              <div className="grid grid-cols-2 gap-2 text-[11px] mt-1 text-slate-400 font-mono">
                                <div className="flex justify-between"><span>Concise (&lt;=180 words):</span><span className={test.quality.concise ? "text-emerald-400" : "text-rose-400"}>{test.quality.concise ? "YES" : "NO"}</span></div>
                                <div className="flex justify-between"><span>No Tech Overexplain:</span><span className={test.quality.noOverexplain ? "text-emerald-400" : "text-rose-400"}>{test.quality.noOverexplain ? "YES" : "NO"}</span></div>
                                <div className="flex justify-between"><span>Directly Answers Query:</span><span className={test.quality.directAnswer ? "text-emerald-400" : "text-rose-400"}>{test.quality.directAnswer ? "YES" : "NO"}</span></div>
                                <div className="flex justify-between"><span>Advances Conversation:</span><span className={test.quality.advancesConversation ? "text-emerald-400" : "text-rose-400"}>{test.quality.advancesConversation ? "YES" : "NO"}</span></div>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Repetition Detailed matrix */}
              {stage2SubTab === "repetitions" && (
                <div className="space-y-4 animate-fadeIn">
                  {stage2RepetitionResults.map((item, idx) => {
                    const passCount = item.runs.filter((r: any) => r.passed).length;
                    return (
                      <div key={item.promptId || idx} className="bg-slate-950/40 p-4 border border-slate-850 rounded-xl space-y-3">
                        <div className="flex justify-between items-center border-b border-slate-850 pb-2">
                          <div>
                            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-bold">{item.promptId}</span>
                            <span className="text-[11px] font-bold text-slate-200 block mt-1">"{item.prompt}"</span>
                          </div>
                          <span className={`px-2.5 py-1 rounded text-xs font-bold font-mono ${
                            passCount === 5 ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400"
                          }`}>
                            {passCount} / 5 PASSED
                          </span>
                        </div>
                        <div className="grid grid-cols-5 gap-2 font-mono text-[10px]">
                          {item.runs.map((run: any, index: number) => {
                            let colorClass = "bg-rose-950/10 border-rose-500/10 text-rose-300";
                            let statusText = "FAIL";
                            if (run.status === "PASS" || (!run.status && run.passed)) {
                              colorClass = "bg-emerald-950/10 border-emerald-500/10 text-emerald-300";
                              statusText = "PASS";
                            } else if (run.status === "BLOCKED") {
                              colorClass = "bg-amber-950/10 border-amber-500/10 text-amber-300";
                              statusText = "BLOCKED";
                            } else if (run.status === "ERROR") {
                              colorClass = "bg-slate-950/10 border-slate-500/10 text-slate-300";
                              statusText = "ERROR";
                            }
                            return (
                              <div key={index} className={`p-2 rounded text-center border ${colorClass}`}>
                                <div>Run {index + 1}</div>
                                <div className="font-extrabold mt-0.5">{statusText}</div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      ) : activeTab === "livekit" ? (
        <div className="max-w-7xl mx-auto animate-fadeIn">
          <LiveKitSalesRoom
            sessionId={sessionId}
            sessionToken={sessionToken}
            productId={selectedProductAdapter}
          />
        </div>
      ) : (
        /* Architecture & Engine Decoupling Panel */
        <div className="max-w-7xl mx-auto space-y-8 animate-fadeIn">
          {/* Header Card */}
          <div className="bg-gradient-to-r from-purple-950/40 via-slate-900/90 to-indigo-950/40 border border-purple-800/30 rounded-3xl p-6 md:p-8 shadow-2xl backdrop-blur-sm">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <span className="px-3 py-1 rounded-full text-xs font-bold bg-purple-500/20 text-purple-300 border border-purple-500/30 flex items-center gap-1.5">
                    <Boxes className="w-3.5 h-3.5" />
                    Decoupled Sales Engine Architecture
                  </span>
                  <span className="text-xs text-slate-400 font-mono">Product-Independent</span>
                </div>
                <h2 className="text-2xl md:text-3xl font-extrabold text-white tracking-tight">
                  Universal Sales Engine & Business Adapters
                </h2>
                <p className="text-slate-300 text-sm mt-2 max-w-3xl leading-relaxed">
                  The core engine handles conversation orchestration, model integration, restricted tool loops, and salesperson recommendation synthesis without hardcoded domain knowledge. Any product or service (Shopify, Ghostwriter, SaaS, Video Clipping) plugs in via the <code className="text-purple-300 font-mono bg-purple-950/60 px-1.5 py-0.5 rounded">SalesApiAdapter</code> interface.
                </p>
              </div>

              {/* Active Adapter Badge and Switcher */}
              <div className="bg-slate-950/80 border border-slate-800 p-4 rounded-2xl shrink-0 w-full md:w-auto">
                <span className="text-[10px] text-slate-400 font-mono uppercase tracking-wider block mb-1.5">Currently Mounted Adapter:</span>
                <div className="text-sm font-bold text-emerald-400 flex items-center gap-2 mb-3">
                  <ShieldCheck className="w-4 h-4" />
                  {selectedProductAdapter === "ghostwriter-thought-leadership" ? "Ghostwriter Leadership" : "Shopify Storefront Pilot"}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleSwitchAdapter("shopify-conversion-pilot")}
                    disabled={switchingAdapter || selectedProductAdapter === "shopify-conversion-pilot"}
                    className={`px-3 py-1.5 text-xs rounded-xl font-bold transition-all cursor-pointer ${
                      selectedProductAdapter === "shopify-conversion-pilot"
                        ? "bg-indigo-600 text-white shadow"
                        : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                    }`}
                  >
                    Mount Shopify
                  </button>
                  <button
                    onClick={() => handleSwitchAdapter("ghostwriter-thought-leadership")}
                    disabled={switchingAdapter || selectedProductAdapter === "ghostwriter-thought-leadership"}
                    className={`px-3 py-1.5 text-xs rounded-xl font-bold transition-all cursor-pointer ${
                      selectedProductAdapter === "ghostwriter-thought-leadership"
                        ? "bg-purple-600 text-white shadow"
                        : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                    }`}
                  >
                    Mount Ghostwriter
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* 4 Pillars Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {/* Pillar 1: Generic Sales Engine */}
            <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-6 flex flex-col justify-between shadow-xl">
              <div>
                <div className="w-10 h-10 rounded-xl bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center text-indigo-400 mb-4">
                  <Cpu className="w-5 h-5" />
                </div>
                <div className="text-[10px] font-mono text-indigo-400 uppercase tracking-wider font-bold mb-1">Layer 1</div>
                <h3 className="text-base font-bold text-white mb-2">Generic Sales Engine</h3>
                <p className="text-xs text-slate-400 leading-relaxed mb-4">
                  Reusable conversation state management, Gemini SDK model integration, restricted tool loop execution, and salesperson recommendation synthesis.
                </p>
              </div>
              <div className="space-y-1.5 text-[11px] font-mono text-slate-300 border-t border-slate-800/80 pt-3">
                <div className="flex items-center gap-1.5 text-emerald-400">
                  <Check className="w-3.5 h-3.5" /> Zero Shopify assumptions
                </div>
                <div className="flex items-center gap-1.5 text-emerald-400">
                  <Check className="w-3.5 h-3.5" /> Bounded tool sandbox
                </div>
                <div className="flex items-center gap-1.5 text-emerald-400">
                  <Check className="w-3.5 h-3.5" /> Latency & telemetry tracking
                </div>
              </div>
            </div>

            {/* Pillar 2: Sales API Adapter Interface */}
            <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-6 flex flex-col justify-between shadow-xl">
              <div>
                <div className="w-10 h-10 rounded-xl bg-purple-500/15 border border-purple-500/30 flex items-center justify-center text-purple-400 mb-4">
                  <Workflow className="w-5 h-5" />
                </div>
                <div className="text-[10px] font-mono text-purple-400 uppercase tracking-wider font-bold mb-1">Layer 2</div>
                <h3 className="text-base font-bold text-white mb-2">Sales API Adapter</h3>
                <p className="text-xs text-slate-400 leading-relaxed mb-4">
                  Strict TypeScript interface defining how the engine retrieves facts, executes business tools, injects system instructions, and validates policy compliance.
                </p>
              </div>
              <div className="space-y-1.5 text-[11px] font-mono text-slate-300 border-t border-slate-800/80 pt-3">
                <div className="flex items-center gap-1.5 text-purple-300">
                  <Code2 className="w-3.5 h-3.5" /> getTools(): ToolDefinition[]
                </div>
                <div className="flex items-center gap-1.5 text-purple-300">
                  <Code2 className="w-3.5 h-3.5" /> executeTool(name, args)
                </div>
                <div className="flex items-center gap-1.5 text-purple-300">
                  <Code2 className="w-3.5 h-3.5" /> validateResponse()
                </div>
              </div>
            </div>

            {/* Pillar 3: Product-Specific Implementations */}
            <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-6 flex flex-col justify-between shadow-xl">
              <div>
                <div className="w-10 h-10 rounded-xl bg-cyan-500/15 border border-cyan-500/30 flex items-center justify-center text-cyan-400 mb-4">
                  <Boxes className="w-5 h-5" />
                </div>
                <div className="text-[10px] font-mono text-cyan-400 uppercase tracking-wider font-bold mb-1">Layer 3</div>
                <h3 className="text-base font-bold text-white mb-2">Domain Sales APIs</h3>
                <p className="text-xs text-slate-400 leading-relaxed mb-4">
                  Supplies pricing, scope, evidence, qualification facts, and compliance rules. Shopify is the initial deployment; Ghostwriter illustrates seamless reusability.
                </p>
              </div>
              <div className="space-y-1.5 text-[11px] font-mono text-slate-300 border-t border-slate-800/80 pt-3">
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">Shopify Pilot:</span>
                  <span className="text-slate-200 font-bold">$400 / $900</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">Ghostwriter:</span>
                  <span className="text-slate-200 font-bold">$1,200 / $2,500</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">Extensible:</span>
                  <span className="text-cyan-400 font-bold">Infinite products</span>
                </div>
              </div>
            </div>

            {/* Pillar 4: Realtime Adapter */}
            <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-6 flex flex-col justify-between shadow-xl">
              <div>
                <div className="w-10 h-10 rounded-xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400 mb-4">
                  <Radio className="w-5 h-5" />
                </div>
                <div className="text-[10px] font-mono text-emerald-400 uppercase tracking-wider font-bold mb-1">Layer 4</div>
                <h3 className="text-base font-bold text-white mb-2">Realtime Adapter</h3>
                <p className="text-xs text-slate-400 leading-relaxed mb-4">
                  LiveKit media bridge connecting rooms to the Generic Sales Engine. Supports a silent observer copilot delivering text guidance without publishing AI voice.
                </p>
              </div>
              <div className="space-y-1.5 text-[11px] font-mono text-slate-300 border-t border-slate-800/80 pt-3">
                <div className="flex items-center gap-1.5 text-emerald-400">
                  <Check className="w-3.5 h-3.5" /> Silent Copilot (lbv-ai)
                </div>
                <div className="flex items-center gap-1.5 text-emerald-400">
                  <Check className="w-3.5 h-3.5" /> Zero AI audio publication
                </div>
                <div className="flex items-center gap-1.5 text-emerald-400">
                  <Check className="w-3.5 h-3.5" /> Data channel recommendations
                </div>
              </div>
            </div>
          </div>

          {/* Deep-Dive Inspection Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
            {/* Left: Active Adapter Introspection */}
            <div className="lg:col-span-7 bg-slate-900/60 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-5">
              <div className="flex items-center justify-between border-b border-slate-800 pb-4">
                <div className="flex items-center gap-2.5">
                  <BookOpen className="w-5 h-5 text-indigo-400" />
                  <h3 className="font-bold text-slate-100 text-base">Active Adapter Specifications</h3>
                </div>
                <span className="text-xs font-mono text-purple-400 bg-purple-500/10 px-2 py-0.5 rounded border border-purple-500/20">
                  {selectedProductAdapter}
                </span>
              </div>

              {selectedProductAdapter === "shopify-conversion-pilot" ? (
                <div className="space-y-4 text-xs">
                  <div className="bg-slate-950 p-4 rounded-xl border border-slate-850 space-y-2">
                    <span className="font-bold text-indigo-400 uppercase tracking-wider text-[10px]">Service Offering</span>
                    <p className="text-slate-200 font-medium">Shopify Storefront Optimization Pilot</p>
                    <p className="text-slate-400">Technical storefront audit identifying mobile checkout friction, Google listing hours discrepancies, and conversion hygiene leaks.</p>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-slate-950 p-3.5 rounded-xl border border-slate-850">
                      <span className="text-[10px] text-slate-500 uppercase tracking-wider block mb-1">Approved Pilot Price</span>
                      <span className="text-emerald-400 font-mono font-extrabold text-lg">$400</span>
                      <span className="text-[10px] text-slate-400 block mt-0.5">Strictly firm; no discounts</span>
                    </div>
                    <div className="bg-slate-950 p-3.5 rounded-xl border border-slate-850">
                      <span className="text-[10px] text-slate-500 uppercase tracking-wider block mb-1">Monthly Plan</span>
                      <span className="text-emerald-400 font-mono font-extrabold text-lg">$900 / mo</span>
                      <span className="text-[10px] text-slate-400 block mt-0.5">Ongoing conversion retainer</span>
                    </div>
                  </div>

                  <div className="bg-slate-950 p-4 rounded-xl border border-slate-850 space-y-2">
                    <span className="font-bold text-indigo-400 uppercase tracking-wider text-[10px]">Exposed Tools (Bounded Sandbox)</span>
                    <div className="grid grid-cols-2 gap-2 font-mono text-[11px]">
                      <div className="bg-slate-900 p-2 rounded border border-slate-800 text-slate-300">getProspect()</div>
                      <div className="bg-slate-900 p-2 rounded border border-slate-800 text-slate-300">getAudit()</div>
                      <div className="bg-slate-900 p-2 rounded border border-slate-800 text-slate-300">getEvidence()</div>
                      <div className="bg-slate-900 p-2 rounded border border-slate-800 text-slate-300">getOffer()</div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-4 text-xs">
                  <div className="bg-slate-950 p-4 rounded-xl border border-slate-850 space-y-2">
                    <span className="font-bold text-purple-400 uppercase tracking-wider text-[10px]">Service Offering</span>
                    <p className="text-slate-200 font-medium">Ghostwriter Executive Thought Leadership</p>
                    <p className="text-slate-400">High-touch executive personal brand positioning, narrative hook creation, and essay ghostwriting for tech executives.</p>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-slate-950 p-3.5 rounded-xl border border-slate-850">
                      <span className="text-[10px] text-slate-500 uppercase tracking-wider block mb-1">Approved Pilot Price</span>
                      <span className="text-purple-400 font-mono font-extrabold text-lg">$1,200</span>
                      <span className="text-[10px] text-slate-400 block mt-0.5">4 long-form essays</span>
                    </div>
                    <div className="bg-slate-950 p-3.5 rounded-xl border border-slate-850">
                      <span className="text-[10px] text-slate-500 uppercase tracking-wider block mb-1">Monthly Plan</span>
                      <span className="text-purple-400 font-mono font-extrabold text-lg">$2,500 / mo</span>
                      <span className="text-[10px] text-slate-400 block mt-0.5">Monthly thought leadership</span>
                    </div>
                  </div>

                  <div className="bg-slate-950 p-4 rounded-xl border border-slate-850 space-y-2">
                    <span className="font-bold text-purple-400 uppercase tracking-wider text-[10px]">Exposed Tools (Bounded Sandbox)</span>
                    <div className="grid grid-cols-2 gap-2 font-mono text-[11px]">
                      <div className="bg-slate-900 p-2 rounded border border-slate-800 text-slate-300">getExecutiveProfile()</div>
                      <div className="bg-slate-900 p-2 rounded border border-slate-800 text-slate-300">getEditorialAudit()</div>
                      <div className="bg-slate-900 p-2 rounded border border-slate-800 text-slate-300">getWritingSamples()</div>
                      <div className="bg-slate-900 p-2 rounded border border-slate-800 text-slate-300">getGhostwriterOffer()</div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Right: Code Contract & Invariant Proof */}
            <div className="lg:col-span-5 bg-slate-900/60 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
              <div className="flex items-center gap-2 border-b border-slate-800 pb-4">
                <Code2 className="w-5 h-5 text-indigo-400" />
                <h3 className="font-bold text-slate-100 text-base">SalesApiAdapter Interface</h3>
              </div>

              <div className="bg-slate-950 p-4 rounded-xl border border-slate-850 font-mono text-[11px] text-indigo-300 leading-relaxed overflow-x-auto">
                <pre>{`export interface SalesApiAdapter {
  readonly id: string;
  readonly name: string;
  readonly description: string;

  getSystemInstructions(): string;
  getBehavioralPolicies(): Policy[];
  getTools(): ToolDefinition[];
  executeTool(name, args): Promise<any>;
  validateResponse(resp, prompt): Report;
}`}</pre>
              </div>

              <div className="p-4 rounded-xl bg-slate-950 border border-slate-850 text-xs space-y-2">
                <span className="font-bold text-emerald-400 uppercase text-[10px] tracking-wider block">Production Invariant Guarantees</span>
                <ul className="space-y-1.5 text-slate-300 list-disc list-inside">
                  <li><strong>Zero Leakage:</strong> Engine has 0 knowledge of Shopify products or prices.</li>
                  <li><strong>Restricted Tool Dispatch:</strong> Unknown tools reject immediately.</li>
                  <li><strong>Silent Observer:</strong> Realtime adapter permits text data only.</li>
                  <li><strong>Stage 2 Compliance:</strong> All regression suites pass without modification.</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
