import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  BarChart3,
  CheckCircle2,
  ChevronRight,
  FlaskConical,
  LoaderCircle,
  Play,
  RefreshCw,
  Settings,
  XCircle,
} from "lucide-react";

type TargetKind = "all" | "suite" | "llm-call" | "flow";
type RunStatus = "queued" | "running" | "passed" | "failed";

interface EvalCase {
  id: string;
  suite: string;
  semanticChecks: string[];
  live: string;
}

interface EvalFlow {
  id: string;
  pipeline: string;
  stages: string[];
  callIds: string[];
  handoff: { input: string; output: string };
}

interface EvalCatalog {
  cases: EvalCase[];
  flows: EvalFlow[];
  suites: string[];
}

interface EvalSummary {
  passed: number;
  failed: number;
  total: number;
  flowPassed: number;
  flowFailed: number;
  flowTotal: number;
  calls: number;
  totalTokens: number;
}

interface EvalTrial {
  id: string;
  suite: string;
  mode: "contract" | "live";
  passed: boolean;
  schemaPassed: boolean;
  semanticPassed: boolean;
  livePassed?: boolean;
  errors: string[];
  calls: number;
  totalTokens: number;
  artifactDirectory: string;
}

interface EvalRun {
  id: string;
  status: RunStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  outputRoot: string;
  request: {
    targetKind: TargetKind;
    suites: string[];
    caseIds: string[];
    flowIds: string[];
    live: boolean;
    model?: string;
    concurrency?: number;
    outputRoot?: string;
  };
  summary?: EvalSummary;
  report?: string;
  results?: EvalTrial[];
  error?: string;
  resultCount?: number;
}

export function EvalApp() {
  const [catalog, setCatalog] = useState<EvalCatalog | null>(null);
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string>("");
  const [targetKind, setTargetKind] = useState<TargetKind>("all");
  const [selectedSuites, setSelectedSuites] = useState<string[]>([]);
  const [selectedCases, setSelectedCases] = useState<string[]>([]);
  const [selectedFlows, setSelectedFlows] = useState<string[]>([]);
  const [live, setLive] = useState(false);
  const [model, setModel] = useState("");
  const [concurrency, setConcurrency] = useState(4);
  const [outputRoot, setOutputRoot] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void refreshCatalog();
    void refreshRuns();
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshRuns();
      if (selectedRunId) void refreshRun(selectedRunId);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [selectedRunId]);

  const selectedRun = runs.find((run) => run.id === selectedRunId);
  const casesBySuite = useMemo(() => {
    const grouped = new Map<string, EvalCase[]>();
    for (const testCase of catalog?.cases ?? []) {
      const list = grouped.get(testCase.suite) ?? [];
      list.push(testCase);
      grouped.set(testCase.suite, list);
    }
    return grouped;
  }, [catalog]);

  async function refreshCatalog() {
    setCatalog(await getJson<EvalCatalog>("/api/evals/catalog"));
  }

  async function refreshRuns() {
    const response = await getJson<{ runs: EvalRun[] }>("/api/evals/runs");
    setRuns(response.runs);
    if (!selectedRunId && response.runs[0]) setSelectedRunId(response.runs[0].id);
  }

  async function refreshRun(id: string) {
    const run = await getJson<EvalRun>(`/api/evals/runs/${encodeURIComponent(id)}`);
    setRuns((current) => {
      const next = current.filter((item) => item.id !== run.id);
      return [run, ...next].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    });
  }

  async function startRun() {
    const validationError = validateRunSelection({
      targetKind,
      selectedSuites,
      selectedCases,
      selectedFlows,
      live,
    });
    if (validationError) {
      setError(validationError);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const run = await postJson<EvalRun>("/api/evals/runs", {
        targetKind,
        suites: targetKind === "suite" ? selectedSuites : [],
        caseIds: targetKind === "llm-call" ? selectedCases : [],
        flowIds: targetKind === "flow" ? selectedFlows : [],
        live,
        model: model.trim() || undefined,
        concurrency,
        outputRoot: outputRoot.trim() || undefined,
      });
      setRuns((current) => [run, ...current]);
      setSelectedRunId(run.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shell eval-shell">
      <nav className="nav">
        <div className="brand">
          <span><FlaskConical size={19} /></span>
          <div>
            <strong>RolegAIn</strong>
            <small>Eval control center</small>
          </div>
        </div>
        <button className="nav-btn active" type="button">
          <BarChart3 size={17} />
          <span>Runs</span>
          <small>{runs.length}</small>
        </button>
        <button className="nav-btn" type="button">
          <Settings size={17} />
          <span>Parameters</span>
          <small>{live ? "live" : "contract"}</small>
        </button>
        <div className="candidate-identity">
          <span>Runtime</span>
          <strong>Eval UI only</strong>
          <small>Normal server is not started</small>
        </div>
        <div className="runtime-card">
          <div>
            <span className="online-dot on" />
            <span>Eval API</span>
          </div>
        </div>
      </nav>

      <main className="eval-main">
        <section className="eval-controls">
          <header className="eval-section-head">
            <div>
              <span>Run Setup</span>
              <h1>Evaluate LLM Calls And Flows</h1>
            </div>
            <button className="eval-primary" type="button" onClick={() => void startRun()} disabled={busy}>
              {busy ? <LoaderCircle className="spin" size={17} /> : <Play size={17} />}
              Run eval
            </button>
          </header>

          {error && <div className="eval-error">{error}</div>}

          <div className="eval-grid">
            <div className="eval-panel">
              <label>Target</label>
              <div className="eval-segments">
                {(["all", "suite", "llm-call", "flow"] as TargetKind[]).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    className={targetKind === kind ? "active" : ""}
                    onClick={() => setTargetKind(kind)}
                  >
                    {label(kind)}
                  </button>
                ))}
              </div>
            </div>

            <div className="eval-panel">
              <label>Mode</label>
              <div className="eval-toggle-row">
                <button type="button" className={!live ? "active" : ""} onClick={() => setLive(false)}>
                  Contract
                </button>
                <button type="button" className={live ? "active" : ""} onClick={() => setLive(true)}>
                  Live Codex
                </button>
              </div>
              <small>Live mode only runs explicitly selected calls or flow calls.</small>
            </div>

            <div className="eval-panel">
              <label htmlFor="model">Model override</label>
              <input id="model" value={model} onChange={(event) => setModel(event.target.value)} placeholder="default runtime model" />
            </div>

            <div className="eval-panel">
              <label htmlFor="concurrency">Concurrency</label>
              <input
                id="concurrency"
                type="number"
                min={1}
                max={20}
                value={concurrency}
                onChange={(event) => setConcurrency(Number(event.target.value))}
              />
            </div>

            <div className="eval-panel wide">
              <label htmlFor="outputRoot">Output root</label>
              <input id="outputRoot" value={outputRoot} onChange={(event) => setOutputRoot(event.target.value)} placeholder=".agent-runtime/eval-ui/runs/<timestamp>" />
            </div>
          </div>

          {targetKind === "suite" && catalog && (
            <Picker title="Suites" values={catalog.suites} selected={selectedSuites} onChange={setSelectedSuites} />
          )}
          {targetKind === "flow" && catalog && (
            <Picker
              title="Flows"
              values={catalog.flows.map((flow) => flow.id)}
              selected={selectedFlows}
              onChange={setSelectedFlows}
              details={Object.fromEntries(catalog.flows.map((flow) => [flow.id, `${flow.pipeline} - ${flow.callIds.length} calls`]))}
            />
          )}
          {targetKind === "llm-call" && catalog && (
            <div className="eval-call-picker">
              {[...casesBySuite.entries()].map(([suite, cases]) => (
                <Picker
                  key={suite}
                  title={suite}
                  values={cases.map((testCase) => testCase.id)}
                  selected={selectedCases}
                  onChange={setSelectedCases}
                  details={Object.fromEntries(cases.map((testCase) => [testCase.id, `${testCase.semanticChecks.length} checks`]))}
                />
              ))}
            </div>
          )}
        </section>

        <section className="eval-results">
          <div className="eval-run-list">
            <header>
              <strong>Runs</strong>
              <button type="button" onClick={() => void refreshRuns()}>
                <RefreshCw size={15} />
              </button>
            </header>
            {runs.map((run) => (
              <button
                key={run.id}
                type="button"
                className={`eval-run-row ${run.id === selectedRunId ? "active" : ""}`}
                onClick={() => {
                  setSelectedRunId(run.id);
                  void refreshRun(run.id);
                }}
              >
                <StatusIcon status={run.status} />
                <span>
                  <strong>{run.request.targetKind}</strong>
                  <small>{new Date(run.createdAt).toLocaleString()}</small>
                </span>
                <ChevronRight size={16} />
              </button>
            ))}
          </div>

          <RunDetail run={selectedRun} />
        </section>
      </main>
    </div>
  );
}

function Picker(props: {
  title: string;
  values: string[];
  selected: string[];
  onChange: (values: string[]) => void;
  details?: Record<string, string>;
}) {
  return (
    <div className="eval-picker">
      <header>
        <strong>{props.title}</strong>
        <button type="button" onClick={() => props.onChange(props.values)}>All</button>
        <button type="button" onClick={() => props.onChange([])}>None</button>
      </header>
      <div>
        {props.values.map((value) => {
          const active = props.selected.includes(value);
          return (
            <button
              type="button"
              key={value}
              className={active ? "active" : ""}
              onClick={() =>
                props.onChange(
                  active
                    ? props.selected.filter((item) => item !== value)
                    : [...props.selected, value],
                )
              }
            >
              <span>{value}</span>
              {props.details?.[value] && <small>{props.details[value]}</small>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function RunDetail({ run }: { run?: EvalRun }) {
  if (!run)
    return (
      <div className="eval-detail empty">
        <Activity size={22} />
        <span>No eval run selected</span>
      </div>
    );

  const failedResults = (run.results ?? []).filter((result) => !result.passed);
  return (
    <div className="eval-detail">
      <header>
        <div>
          <span>Run Detail</span>
          <h2>{run.id}</h2>
        </div>
        <StatusPill status={run.status} />
      </header>

      <div className="eval-metrics">
        <Metric label="Cases" value={run.summary ? `${run.summary.passed}/${run.summary.total}` : String(run.resultCount ?? 0)} />
        <Metric label="Flows" value={run.summary ? `${run.summary.flowPassed}/${run.summary.flowTotal}` : "-"} />
        <Metric label="Tokens" value={run.summary ? String(run.summary.totalTokens) : "-"} />
        <Metric label="Mode" value={run.request.live ? "Live" : "Contract"} />
      </div>

      <div className="eval-artifact">
        <span>Artifacts</span>
        <code>{run.outputRoot}</code>
      </div>

      {run.error && <pre className="eval-pre error">{run.error}</pre>}

      {failedResults.length > 0 && (
        <section className="eval-failures">
          <h3>Failures</h3>
          {failedResults.map((result) => (
            <div key={result.id}>
              <strong>{result.id}</strong>
              <small>{result.errors.join("; ")}</small>
            </div>
          ))}
        </section>
      )}

      {run.results && (
        <section className="eval-table-wrap">
          <h3>Case Results</h3>
          <table className="eval-table">
            <thead>
              <tr>
                <th>Case</th>
                <th>Suite</th>
                <th>Status</th>
                <th>Schema</th>
                <th>Semantic</th>
                <th>Calls</th>
                <th>Tokens</th>
              </tr>
            </thead>
            <tbody>
              {run.results.map((result) => (
                <tr key={result.id}>
                  <td>{result.id}</td>
                  <td>{result.suite}</td>
                  <td>{result.passed ? "pass" : "fail"}</td>
                  <td>{result.schemaPassed ? "pass" : "fail"}</td>
                  <td>{result.semanticPassed ? "pass" : "fail"}</td>
                  <td>{result.calls}</td>
                  <td>{result.totalTokens}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {run.report && (
        <section>
          <h3>Report</h3>
          <pre className="eval-pre">{run.report}</pre>
        </section>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StatusIcon({ status }: { status: RunStatus }) {
  if (status === "running" || status === "queued")
    return <LoaderCircle className="spin" size={17} />;
  if (status === "passed") return <CheckCircle2 size={17} />;
  return <XCircle size={17} />;
}

function StatusPill({ status }: { status: RunStatus }) {
  return <span className={`eval-status ${status}`}>{status}</span>;
}

function label(kind: TargetKind) {
  return kind === "llm-call" ? "LLM call" : kind;
}

function validateRunSelection(selection: {
  targetKind: TargetKind;
  selectedSuites: string[];
  selectedCases: string[];
  selectedFlows: string[];
  live: boolean;
}) {
  if (selection.targetKind === "suite" && selection.selectedSuites.length === 0) {
    return "Select at least one suite, or switch target to All.";
  }
  if (selection.targetKind === "llm-call" && selection.selectedCases.length === 0) {
    return "Select at least one LLM call, or switch target to All.";
  }
  if (selection.targetKind === "flow" && selection.selectedFlows.length === 0) {
    return "Select at least one flow, or switch target to All.";
  }
  if (selection.live && selection.targetKind !== "llm-call" && selection.targetKind !== "flow") {
    return "Live evals require selected LLM calls or selected flows.";
  }
  return "";
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(await responseError(response));
  return response.json() as Promise<T>;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await responseError(response));
  return response.json() as Promise<T>;
}

async function responseError(response: Response) {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `Request failed (${response.status})`;
}
