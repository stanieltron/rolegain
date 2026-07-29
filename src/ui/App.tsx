import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  BellRing,
  BriefcaseBusiness,
  Building2,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  CircleHelp,
  Code2,
  FileCheck2,
  FileText,
  Globe2,
  Download,
  Inbox,
  LoaderCircle,
  MapPin,
  Paperclip,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Upload,
  UserRound,
  X,
} from "lucide-react";
import type {
  ApplicationDraft,
  JobSearchWorkspace,
} from "../contracts/job-search.js";
import type { CodexRuntimeInfo } from "../codex-runtime/protocol.js";
import {
  addOpportunity,
  addSource,
  analyzeCandidate,
  answerQuestion,
  continueBackgroundWork,
  downloadTailoredCv,
  finishIntake,
  findMoreApplications,
  getCanonicalEvidence,
  getRuntime,
  getWorkspace,
  prepareApplications,
  prepareSearchReadyApplications,
  promoteOpportunity,
  removeSource,
  resetJobList,
  resetUser,
  refineApplicationField,
  refineCoverLetter,
  setApplicationOutcome,
  stopBackgroundWork,
  tailorApplicationCv,
  updateApplication,
  updateCandidateProfile,
  updateSearchConfig,
} from "./api.js";
import type { CanonicalEvidenceModel } from "./api.js";

type View = "profile" | "discovery" | "applications";
type LongActivity =
  | "candidate-analysis"
  | "job-search"
  | "application-preparation";

const LOCATION_OPTIONS = [
  "Remote",
  "Worldwide",
  "Europe",
  "European Union",
  "European Economic Area",
  "EMEA",
  "Western Europe",
  "Central and Eastern Europe",
  "DACH",
  "Benelux",
  "Nordics",
  "United Kingdom and Ireland",
  "Americas",
  "North America",
  "Latin America",
  "Asia-Pacific",
  "APAC",
  "Middle East and North Africa",
  "Middle East",
  "Africa",
  "Asia",
  "Remote - Europe",
  "Remote - European Union",
  "Remote - United Kingdom",
  "Remote - United States",
  "Hybrid",
  "Slovakia",
  "Czechia",
  "Austria",
  "Germany",
  "United Kingdom",
  "Ireland",
  "Netherlands",
  "Switzerland",
  "Poland",
  "Hungary",
  "France",
  "Spain",
  "Portugal",
  "United States",
  "Canada",
  "Australia",
  "Bratislava, Slovakia",
  "Kosice, Slovakia",
  "Prague, Czechia",
  "Brno, Czechia",
  "Vienna, Austria",
  "Berlin, Germany",
  "Munich, Germany",
  "Hamburg, Germany",
  "London, United Kingdom",
  "Dublin, Ireland",
  "Amsterdam, Netherlands",
  "Zurich, Switzerland",
  "Warsaw, Poland",
  "Krakow, Poland",
  "Budapest, Hungary",
  "Paris, France",
  "Barcelona, Spain",
  "Madrid, Spain",
  "Lisbon, Portugal",
  "Helsinki, Finland",
  "Stockholm, Sweden",
  "Copenhagen, Denmark",
  "Oslo, Norway",
  "Tallinn, Estonia",
  "Riga, Latvia",
  "Vilnius, Lithuania",
  "Bucharest, Romania",
  "Sofia, Bulgaria",
  "Ljubljana, Slovenia",
  "Zagreb, Croatia",
  "New York, NY, United States",
  "San Francisco, CA, United States",
  "Seattle, WA, United States",
  "Austin, TX, United States",
  "Boston, MA, United States",
  "Toronto, Canada",
  "Vancouver, Canada",
  "Montreal, Canada",
  "Singapore",
  "Tokyo, Japan",
  "Sydney, Australia",
  "Melbourne, Australia",
];

const LANGUAGE_OPTIONS = [
  "English",
  "Slovak",
  "Czech",
  "German",
  "French",
  "Spanish",
  "Polish",
  "Hungarian",
  "Dutch",
  "Italian",
  "Portuguese",
  "Ukrainian",
  "Russian",
];

function candidateDiscoveryReady(workspace: JobSearchWorkspace) {
  return (
    (workspace.profileSetupStep ?? 1) >= 4 &&
    workspace.sources.some((source) => source.kind === "cv") &&
    Boolean(workspace.profile.name.trim()) &&
    Boolean(workspace.profile.email.trim()) &&
    workspace.questions.every((question) => !question.required || Boolean(question.answer.trim())) &&
    workspace.intelligence.status === "ready" &&
    workspace.intelligence.evidenceRun?.readyForSearch !== false &&
    !workspace.sources.some((source) => source.status === "processing")
  );
}

function cumulativePipelineItems(workspace: JobSearchWorkspace) {
  const byJobId = new Map<
    string,
    JobSearchWorkspace["jobHistory"][number]
  >();
  for (const item of [
    ...workspace.jobHistory,
    ...(workspace.searchProgress?.items ?? []),
  ])
    byJobId.set(item.id, item);
  return [...byJobId.values()];
}

function preparedVerifiedItemsFrom(
  workspace: JobSearchWorkspace,
  items: JobSearchWorkspace["jobHistory"],
) {
  const applicationJobIds = new Set(
    workspace.applications.map((application) => application.jobId),
  );
  const byJobId = new Map<
    string,
    JobSearchWorkspace["jobHistory"][number]
  >();
  for (const item of items)
    if (
      applicationJobIds.has(item.id) &&
      item.application === "passed" &&
      item.applicationVerification === "passed"
    )
      byJobId.set(item.id, item);
  return [...byJobId.values()];
}

function preparedVerifiedApplications(workspace: JobSearchWorkspace) {
  return workspace.applications.filter((application) =>
    Boolean(application.addedBy),
  );
}

interface ViewProps {
  workspace: JobSearchWorkspace;
  busy: boolean;
  act: (
    operation: () => Promise<JobSearchWorkspace>,
    next?: View,
    activity?: LongActivity,
  ) => Promise<JobSearchWorkspace | undefined>;
}

type EvidenceLinkDraft = Pick<
  JobSearchWorkspace["profile"],
  "linkedin" | "github" | "website"
>;

type StagedEvidenceSource = {
  id: string;
  label: string;
  source: Omit<Parameters<typeof addSource>[0], "deferAnalysis">;
};

export function App() {
  const [workspace, setWorkspace] = useState<JobSearchWorkspace>();
  const [runtime, setRuntime] = useState<CodexRuntimeInfo>();
  const [view, setView] = useState<View>("profile");
  const [selectedId, setSelectedId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [notificationPrompt, setNotificationPrompt] =
    useState<LongActivity>();
  const previousTaskState = useRef<
    | {
        analysisRunning: boolean;
        searchRunning: boolean;
      }
    | undefined
  >(undefined);
  const activeLongActivity = useRef<LongActivity | undefined>(undefined);

  const offerNotifications = (activity: LongActivity) => {
    activeLongActivity.current = activity;
    if (
      typeof Notification !== "undefined" &&
      Notification.permission === "default"
    )
      setNotificationPrompt(activity);
  };

  const notifyWhenAway = (title: string, body: string, tag: string) => {
    if (
      typeof Notification === "undefined" ||
      Notification.permission !== "granted" ||
      (document.visibilityState === "visible" && document.hasFocus())
    )
      return;
    try {
      const notification = new Notification(title, { body, tag });
      notification.onclick = () => window.focus();
    } catch {
      // Some embedded browsers expose permission state without supporting the
      // constructor. The in-app completion state remains the fallback.
    }
  };

  useEffect(() => {
    void Promise.all([
      getWorkspace(),
      getRuntime().catch(() => undefined),
    ]).then(([w, r]) => {
      setWorkspace(w);
      setRuntime(r);
      if (preparedVerifiedApplications(w).length > 0) setView("applications");
      else if (candidateDiscoveryReady(w) && w.phase !== "intake")
        setView("discovery");
    });
  }, []);
  const executionStopped =
    workspace?.backgroundExecution?.state === "stopped";
  const monitoring =
    !executionStopped &&
    (workspace?.intelligence.status === "analyzing" ||
      (workspace?.sources.some((source) => source.status === "processing") ??
        false) ||
      workspace?.searchProgress?.stage === "looking" ||
      workspace?.searchProgress?.stage === "verifying" ||
      workspace?.searchProgress?.stage === "filling" ||
      (workspace?.applications.some(
        (application) => application.tailoredCv?.status === "processing",
      ) ??
        false));
  useEffect(() => {
    if (!monitoring) return;
    const timer = window.setInterval(
      () => void getWorkspace().then(setWorkspace),
      workspace?.intelligence.status === "analyzing" ? 750 : 2000,
    );
    return () => window.clearInterval(timer);
  }, [monitoring, workspace?.intelligence.status]);
  useEffect(() => {
    if (!workspace) return;
    const current = {
      analysisRunning:
        workspace.intelligence.status === "analyzing" ||
        workspace.sources.some((source) => source.status === "processing"),
      searchRunning:
        workspace.searchProgress?.stage === "looking" ||
        workspace.searchProgress?.stage === "verifying" ||
        workspace.searchProgress?.stage === "filling",
    };
    const previous = previousTaskState.current;
    previousTaskState.current = current;
    if (!previous) return;
    if (previous.analysisRunning && !current.analysisRunning) {
      const failed =
        workspace.intelligence.status === "failed" ||
        workspace.sources.some((source) => source.status === "analysis_failed");
      notifyWhenAway(
        failed ? "Candidate analysis needs attention" : "Candidate evidence is ready",
        failed
          ? "Open RolegAIn to review the source that could not be analyzed."
          : "Your CV and evidence batch have finished processing.",
        "candidate-analysis",
      );
      if (activeLongActivity.current === "candidate-analysis")
        activeLongActivity.current = undefined;
    }
    if (previous.searchRunning && !current.searchRunning) {
      const failed = workspace.searchProgress?.stage === "failed";
      const preparing = activeLongActivity.current === "application-preparation";
      notifyWhenAway(
        failed
          ? "Job workflow needs attention"
          : preparing
            ? "Applications are ready for review"
            : "Job discovery is ready",
        failed
          ? "Open RolegAIn to review what stopped the workflow."
          : preparing
            ? "The selected forms and application materials have finished processing."
            : "The search, vacancy checks, and evidence matching have finished.",
        preparing ? "application-preparation" : "job-search",
      );
      activeLongActivity.current = undefined;
    }
  }, [workspace]);
  useEffect(() => {
    if (!workspace) return;
    if (!candidateDiscoveryReady(workspace) && view !== "profile")
      setView("profile");
    else if (
      view === "applications" &&
      workspace.phase !== "applications" &&
      preparedVerifiedApplications(workspace).length === 0
    )
      setView("discovery");
  }, [workspace, view]);
  const act = async (
    operation: () => Promise<JobSearchWorkspace>,
    next?: View,
    activity?: LongActivity,
  ) => {
    if (activity) offerNotifications(activity);
    setBusy(true);
    setError(undefined);
    try {
      const value = await operation();
      setWorkspace(value);
      if (next) setView(next);
      return value;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  if (!workspace)
    return (
      <div className="boot">
        <LoaderCircle className="spin" />
        <span>Opening job-search workspace</span>
      </div>
    );
  const readyCount = workspace.applications.filter(
    (a) => a.status === "ready_to_send" && !a.outcome,
  ).length;
  const appliedCount = workspace.applications.filter(
    (a) => a.outcome === "applied_waiting",
  ).length;
  const discoveryReady = candidateDiscoveryReady(workspace);
  const preparedApplications = preparedVerifiedApplications(workspace);
  return (
    <div className="shell">
      <nav className="nav" aria-label="Primary navigation">
        <div className="brand">
          <span>
            <Sparkles size={18} />
          </span>
          <div>
            <strong>RolegAIn</strong>
            <small>Agentic job search</small>
          </div>
        </div>
        <div className="candidate-identity">
          <span>Candidate</span>
          <strong>{workspace.profile.name || "Candidate profile"}</strong>
          <small>{workspace.profile.email || "Add an email in Profile"}</small>
        </div>
        <NavButton
          icon={UserRound}
          label="Profile"
          active={view === "profile"}
          badge={`${workspace.profileCompleteness}%`}
          onClick={() => setView("profile")}
        />
        {discoveryReady && (
          <NavButton
            icon={Search}
            label="Discovery"
            active={view === "discovery"}
            badge={String(workspace.searchProgress?.items?.length ?? 0)}
            onClick={() => setView("discovery")}
          />
        )}
        {discoveryReady &&
          (workspace.phase === "applications" || preparedApplications.length > 0) && (
          <NavButton
            icon={BriefcaseBusiness}
            label="Applications"
            active={view === "applications"}
            badge={String(preparedApplications.length)}
            onClick={() => {
              setSelectedId(undefined);
              setView("applications");
            }}
          />
        )}
        <div className="runtime-card">
          <div>
            <span className={`online-dot ${runtime?.available ? "on" : ""}`} />
            <strong>Codex CLI</strong>
          </div>
          <dl>
            <dt>Version</dt>
            <dd>{runtime?.version ?? "Checking"}</dd>
            <dt>Model</dt>
            <dd>{runtime?.model ?? "-"}</dd>
            <dt>Protocol</dt>
            <dd>{runtime?.compatible ? "Compatible" : "Review"}</dd>
          </dl>
        </div>
        <div className="settings-menu">
          <button
            className="settings-trigger"
            type="button"
            aria-label="Settings"
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen((open) => !open)}
          >
            <Settings size={17} />
          </button>
          {settingsOpen && (
            <div className="settings-popover" role="menu">
              <strong>Settings</strong>
              <button
                className="reset-user-action"
                type="button"
                role="menuitem"
                disabled={busy}
                onClick={() => {
                  const confirmed = window.confirm(
                    "Permanently reset this user? This deletes the profile, preferences, uploaded files, evidence and knowledge, jobs, applications, history, and numbering. This cannot be undone.",
                  );
                  if (!confirmed) return;
                  setSettingsOpen(false);
                  setSelectedId(undefined);
                  void act(resetUser, "profile");
                }}
              >
                <Trash2 size={15} />
                Reset user
              </button>
              <small>Deletes all candidate and job-search data.</small>
            </div>
          )}
        </div>
      </nav>
      <main>
        <header className="topbar">
          <div>
            <span className="eyebrow">{phaseLabel(workspace.phase)}</span>
            <h1>{title(view)}</h1>
          </div>
          <div className="top-actions">
            <div
              className={`execution-controls ${executionStopped ? "stopped" : ""}`}
              aria-label="Background execution controls"
            >
              <button
                type="button"
                className="stop-execution"
                disabled={busy || executionStopped}
                onClick={() => void act(stopBackgroundWork)}
              >
                <Square size={12} fill="currentColor" /> Stop
              </button>
              <button
                type="button"
                className="continue-execution"
                disabled={busy || !executionStopped}
                onClick={() => void act(continueBackgroundWork)}
              >
                <Play size={13} fill="currentColor" /> Continue
              </button>
            </div>
            <div className="ready-summary">
              <CheckCircle2 size={16} />
              <span>
                <strong>{readyCount}</strong> ready ·{" "}
                <strong>{appliedCount}</strong> applied
              </span>
            </div>
          </div>
        </header>
        {error && (
          <div className="error">
            <CircleHelp size={18} />
            <span>{error}</span>
            <button onClick={() => setError(undefined)}>
              <X size={15} />
            </button>
          </div>
        )}
        <div className="page">
          {view === "profile" && (
            <ProfileView workspace={workspace} busy={busy} act={act} />
          )}
          {view === "discovery" && (
            <DiscoveryView
              workspace={workspace}
              busy={busy}
              act={act}
              onContinue={() => {
                setSelectedId(undefined);
                setView("applications");
              }}
            />
          )}
          {view === "applications" && (
            <ApplicationsView
              workspace={workspace}
              selectedId={selectedId}
              setSelectedId={setSelectedId}
              act={act}
              busy={busy}
              onPrepareNext={() => {
                setSelectedId(undefined);
                setView("discovery");
                void act(findMoreApplications, "discovery", "job-search");
              }}
            />
          )}
        </div>
      </main>
      {notificationPrompt && (
        <NotificationPrompt
          activity={notificationPrompt}
          onDismiss={() => setNotificationPrompt(undefined)}
          onEnable={async () => {
            try {
              await Notification.requestPermission();
            } finally {
              setNotificationPrompt(undefined);
            }
          }}
        />
      )}
    </div>
  );
}

function NotificationPrompt({
  activity,
  onEnable,
  onDismiss,
}: {
  activity: LongActivity;
  onEnable: () => void | Promise<void>;
  onDismiss: () => void;
}) {
  const copy =
    activity === "candidate-analysis"
      ? {
          title: "We’ll take a careful look",
          detail:
            "Thoroughly reading your CV, pages, and files can take a few minutes.",
        }
      : activity === "application-preparation"
        ? {
            title: "Application preparation takes time",
            detail:
              "We’ll inspect forms and prepare each selected application independently.",
          }
        : {
            title: "Discovery may take a while",
            detail:
              "We’ll search broadly, verify live vacancies, and match each one against your evidence.",
          };
  return (
    <div className="notification-prompt-backdrop">
      <section
        className="notification-prompt"
        role="dialog"
        aria-modal="true"
        aria-labelledby="notification-prompt-title"
      >
        <span className="notification-prompt-icon">
          <BellRing size={21} />
        </span>
        <div>
          <span className="section-label">Runs in the background</span>
          <h2 id="notification-prompt-title">{copy.title}</h2>
          <p>
            {copy.detail} You can switch to something else while it runs. Enable
            desktop notifications and we’ll let you know when it’s ready or
            needs attention.
          </p>
        </div>
        <div className="notification-prompt-actions">
          <button className="secondary" type="button" onClick={onDismiss}>
            Not now
          </button>
          <button
            className="primary"
            type="button"
            onClick={() => void onEnable()}
          >
            <BellRing size={15} /> Enable notifications
          </button>
        </div>
      </section>
    </div>
  );
}

function ProfileView({ workspace, busy, act }: ViewProps) {
  const [evidence, setEvidence] = useState("");
  const [evidenceLinks, setEvidenceLinks] = useState<EvidenceLinkDraft>({
    linkedin: workspace.profile.linkedin,
    github: workspace.profile.github,
    website: workspace.profile.website,
  });
  const [stagedEvidence, setStagedEvidence] = useState<StagedEvidenceSource[]>([]);
  const [canonicalEvidence, setCanonicalEvidence] =
    useState<CanonicalEvidenceModel>();
  const [sourceStarting, setSourceStarting] = useState(false);
  const [pendingSourceName, setPendingSourceName] = useState("");
  const previousSavedLinks = useRef<EvidenceLinkDraft>({
    linkedin: workspace.profile.linkedin,
    github: workspace.profile.github,
    website: workspace.profile.website,
  });
  const cvSource = [...workspace.sources]
    .reverse()
    .find((source) => source.kind === "cv");
  useEffect(() => {
    const runId = workspace.intelligence.evidenceRun?.id;
    if (!runId) {
      setCanonicalEvidence(undefined);
      return;
    }
    let active = true;
    void getCanonicalEvidence(workspace.candidateId)
      .then((model) => {
        if (active) setCanonicalEvidence(model);
      })
      .catch(() => {
        if (active) setCanonicalEvidence(undefined);
      });
    return () => {
      active = false;
    };
  }, [workspace.candidateId, workspace.intelligence.evidenceRun?.id]);
  const persistedStep = workspace.profileSetupStep ?? 1;
  const unanswered = workspace.questions.filter(
    (question) => question.required && !question.answer.trim(),
  );
  const basicReady =
    Boolean(workspace.profile.name.trim()) &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(workspace.profile.email.trim());
  const savedEvidenceLinks: EvidenceLinkDraft = {
    linkedin: workspace.profile.linkedin,
    github: workspace.profile.github,
    website: workspace.profile.website,
  };
  const savedEvidenceLinksSerialized = JSON.stringify(savedEvidenceLinks);
  const evidenceLinksChanged =
    JSON.stringify(evidenceLinks) !== savedEvidenceLinksSerialized;
  const hasStagedEvidence = stagedEvidence.length > 0 || evidenceLinksChanged;
  const analyzing =
    sourceStarting ||
    workspace.intelligence.status === "analyzing" ||
    workspace.sources.some((source) => source.status === "processing");
  const cvAnalyzing =
    sourceStarting ||
    cvSource?.status === "processing" ||
    (persistedStep < 2 && workspace.intelligence.status === "analyzing");
  const evidenceNeedsAnalysis =
    hasStagedEvidence ||
    workspace.intelligence.status === "failed" ||
    workspace.intelligence.evidenceRun?.readyForSearch === false ||
    workspace.sources.some(
      (source) =>
        source.analysisRequired || source.status === "analysis_failed",
    );
  const jobInformationReady =
    basicReady &&
    !analyzing &&
    !evidenceNeedsAnalysis &&
    workspace.intelligence.status === "ready";
  const highestStep: 1 | 2 | 3 | 4 =
    !cvSource || persistedStep < 2
      ? 1
      : !jobInformationReady
        ? 2
        : persistedStep < 4 || unanswered.length > 0
          ? 3
          : 4;
  const previousHighestStep = useRef<1 | 2 | 3 | 4>(
    highestStep === 3 ? 2 : highestStep,
  );

  useEffect(() => {
    const previous = previousHighestStep.current;
    previousHighestStep.current = highestStep;
    if (previous >= 3 || highestStep < 3) return;
    window.requestAnimationFrame(() =>
      document.getElementById("job-search-preferences")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      }),
    );
  }, [highestStep]);

  useEffect(() => {
    const previous = previousSavedLinks.current;
    setEvidenceLinks((current) => ({
      linkedin:
        current.linkedin === previous.linkedin
          ? savedEvidenceLinks.linkedin
          : current.linkedin,
      github:
        current.github === previous.github
          ? savedEvidenceLinks.github
          : current.github,
      website:
        current.website === previous.website
          ? savedEvidenceLinks.website
          : current.website,
    }));
    previousSavedLinks.current = savedEvidenceLinks;
  }, [savedEvidenceLinksSerialized]);

  const upload = async (file?: File) => {
    if (!file) return;
    setPendingSourceName(file.name);
    setSourceStarting(true);
    try {
      await act(
        async () => {
          validateCvFile(file);
          const dataBase64 = await fileToBase64(file);
          return addSource({
            kind: "cv",
            name: file.name,
            dataBase64,
          });
        },
        undefined,
        "candidate-analysis",
      );
    } finally {
      setSourceStarting(false);
      setPendingSourceName("");
    }
  };

  const addEvidence = () => {
    const value = evidence.trim();
    if (!value) return;
    const parsed = parseSourceUrl(value);
    const source: Parameters<typeof addSource>[0] = parsed
      ? { kind: "webpage", name: parsed.hostname, url: parsed.href }
      : { kind: "document", name: "Additional experience", content: value };
    setStagedEvidence((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        label: parsed?.hostname || `Text note ${current.length + 1}`,
        source,
      },
    ]);
    setEvidence("");
  };

  const stageEvidenceFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const additions = await Promise.all(
      [...files].map(async (file) => ({
        id: crypto.randomUUID(),
        label: file.name,
        source: {
          kind: "document" as const,
          name: file.name,
          dataBase64: await fileToBase64(file),
          mimeType: file.type,
        },
      })),
    );
    setStagedEvidence((current) => [...current, ...additions]);
  };

  const analyzeEvidenceBatch = async () => {
    setPendingSourceName(
      stagedEvidence.length > 0
        ? `${stagedEvidence.length} staged source${stagedEvidence.length === 1 ? "" : "s"}`
        : "profile links",
    );
    setSourceStarting(true);
    try {
      const result = await act(
        async () => {
          if (evidenceLinksChanged)
            await updateCandidateProfile({
              name: workspace.profile.name,
              email: workspace.profile.email,
              phone: workspace.profile.phone,
              linkedin: evidenceLinks.linkedin,
              github: evidenceLinks.github,
              website: evidenceLinks.website,
              workAuthorization: workspace.profile.workAuthorization,
              deferEvidenceAnalysis: true,
            });
          for (const item of stagedEvidence)
            await addSource({ ...item.source, deferAnalysis: true });
          return analyzeCandidate();
        },
        undefined,
        "candidate-analysis",
      );
      if (result) setStagedEvidence([]);
    } finally {
      setSourceStarting(false);
      setPendingSourceName("");
    }
  };

  return (
    <div className="profile-wizard">
      <section className="band wizard-panel wizard-cv">
          <WizardHeading
            number={1}
            label="Start with your CV"
            title="Upload your CV"
          >
            Your CV is read completely and turned into grounded candidate
            evidence before the next step opens.
          </WizardHeading>
          {cvSource ? (
            <div className="cv-source-complete" role="status">
              <span className="cv-source-icon" aria-hidden="true">
                {cvAnalyzing ? (
                  <LoaderCircle size={18} className="spin" />
                ) : cvSource.status === "analysis_failed" ? (
                  <AlertTriangle size={18} />
                ) : (
                  <CheckCircle2 size={18} />
                )}
              </span>
              <div className="cv-source-copy">
                <strong>
                  {cvAnalyzing
                    ? "Ingesting CV evidence"
                    : cvSource.status === "analysis_failed"
                      ? "CV analysis needs attention"
                      : "CV evidence ready"}
                </strong>
                <span>{pendingSourceName || cvSource.name}</span>
                <small>
                  {cvAnalyzing
                    ? "Reading the CV and building candidate knowledge"
                    : cvSource.error ||
                      "Basic information and experience were extracted"}
                </small>
              </div>
              <label
                className={`cv-update ${busy || analyzing ? "disabled" : ""}`}
              >
                <Upload size={14} /> Update CV
                <input
                  disabled={busy || analyzing}
                  type="file"
                  accept=".pdf,.doc,.docx,.txt,.md,.markdown,.rtf,.html,.htm"
                  onChange={(event) => {
                    void upload(event.target.files?.[0]);
                    event.target.value = "";
                  }}
                />
              </label>
            </div>
          ) : (
            <label className={`dropzone ${analyzing ? "disabled" : ""}`}>
              <Upload size={22} />
              <strong>Choose your CV</strong>
              <span>
                PDF, Word, DOCX, text, Markdown, RTF or HTML · up to 15 MB
              </span>
              <input
                disabled={busy || analyzing}
                type="file"
                accept=".pdf,.doc,.docx,.txt,.md,.markdown,.rtf,.html,.htm"
                onChange={(event) => void upload(event.target.files?.[0])}
              />
            </label>
          )}
          {analyzing && highestStep === 1 && (
            <ProfileAnalysisStatus
              workspace={workspace}
              sourceStarting={sourceStarting}
              pendingSourceName={pendingSourceName}
            />
          )}
      </section>

      {highestStep >= 2 && (
        <div className="wizard-step-stack">
          <section className="band wizard-panel">
            <WizardHeading
              number={2}
              label="Candidate profile"
              title="Confirm your information and evidence"
            >
              Name and email are prefilled when found in your CV. More optional
              evidence produces better search and matching results.
            </WizardHeading>
            <ProfileBasics
              key={workspace.candidateId}
              workspace={workspace}
              busy={busy}
              act={act}
              disabled={analyzing}
              evidenceLinks={evidenceLinks}
              onEvidenceLinksChange={setEvidenceLinks}
            />
            <div className="experience-input">
              <label htmlFor="experience-evidence">
                Anything else that shows your experience?
              </label>
              <span>
                Repository, relevant webpage, or a short description of an
                achievement.
              </span>
              <textarea
                id="experience-evidence"
                disabled={analyzing}
                value={evidence}
                onChange={(event) => setEvidence(event.target.value)}
                placeholder="Paste a link or describe your experience, project or achievement..."
              />
              <div className="evidence-batch-actions">
                <button
                  className="secondary"
                  disabled={busy || analyzing || !evidence.trim()}
                  onClick={addEvidence}
                >
                  <Plus size={15} /> Add text or page
                </button>
                <label className={`secondary file-action ${busy || analyzing ? "disabled" : ""}`}>
                  <Paperclip size={15} /> Add files
                  <input
                    type="file"
                    multiple
                    disabled={busy || analyzing}
                    accept=".pdf,.doc,.docx,.txt,.md,.markdown,.rtf,.html,.htm"
                    onChange={(event) => {
                      void stageEvidenceFiles(event.target.files);
                      event.target.value = "";
                    }}
                  />
                </label>
              </div>
            </div>
            {stagedEvidence.length > 0 && (
              <div className="staged-evidence" aria-label="Evidence waiting for analysis">
                <strong>Waiting for analysis</strong>
                {stagedEvidence.map((item) => (
                  <span key={item.id}>
                    <FileText size={14} />
                    <b>{item.label}</b>
                    <button
                      type="button"
                      aria-label={`Remove ${item.label}`}
                      disabled={analyzing}
                      onClick={() =>
                        setStagedEvidence((current) =>
                          current.filter((candidate) => candidate.id !== item.id),
                        )
                      }
                    >
                      <X size={13} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            {analyzing && (
              <ProfileAnalysisStatus
                workspace={workspace}
                sourceStarting={sourceStarting}
                pendingSourceName={pendingSourceName}
              />
            )}
            {!analyzing && (!basicReady || evidenceNeedsAnalysis) && (
              <div className="wizard-action">
                <span>
                  {!basicReady
                    ? "Complete full name and email first."
                    : "New or changed evidence is ready to be analyzed."}
                </span>
                {evidenceNeedsAnalysis && (
                  <button
                    className="primary"
                    disabled={busy || !basicReady}
                    onClick={() => void analyzeEvidenceBatch()}
                  >
                    <Sparkles size={15} />
                    {hasStagedEvidence
                      ? `Analyze batch${stagedEvidence.length ? ` (${stagedEvidence.length})` : ""}`
                      : "Analyze evidence"}
                  </button>
                )}
              </div>
            )}
          </section>
          <EvidenceLedger
            workspace={workspace}
            canonicalEvidence={canonicalEvidence}
            disabled={busy || analyzing}
            onRemove={(sourceId) => {
              if (
                window.confirm(
                  "Remove this evidence source and rebuild the complete candidate evidence ledger?",
                )
              )
                void act(() => removeSource(sourceId));
            }}
          />
        </div>
      )}

      {highestStep >= 3 && (
        <div className="wizard-step-stack">
          <PreferencesSection
            workspace={workspace}
            unanswered={unanswered}
            busy={busy}
            act={act}
          />
          {unanswered.length === 0 && workspace.discoveryNeedsRun && (
            <section className="setup-nudge complete">
              <div>
                <CheckCircle2 size={20} />
                <span>
                  <strong>Job information is complete</strong>
                  <small>
                    Continue to the final step and start Discovery when ready.
                  </small>
                </span>
              </div>
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  void act(
                    async () => {
                      await finishIntake();
                      return prepareApplications();
                    },
                    "discovery",
                    "job-search",
                  )
                }
              >
                Continue to Discovery <ChevronRight size={16} />
              </button>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function WizardHeading({
  number,
  label,
  title,
  children,
}: {
  number: number;
  label: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="wizard-heading">
      <span className="wizard-number">{number}</span>
      <div>
        <span className="section-label">{label}</span>
        <h2>{title}</h2>
        <p>{children}</p>
      </div>
    </div>
  );
}

function ProfileAnalysisStatus({
  workspace,
  sourceStarting,
  pendingSourceName,
}: {
  workspace: JobSearchWorkspace;
  sourceStarting: boolean;
  pendingSourceName: string;
}) {
  const progress = workspace.intelligence.progress;
  const progressPercent =
    progress?.stage === "synthesizing"
      ? 92
      : progress?.total
        ? Math.max(4, Math.round((progress.completed / progress.total) * 85))
        : 4;
  return (
    <div className="analysis-progress" role="status" aria-live="polite">
      <LoaderCircle className="spin" size={21} />
      <div>
        <strong>
          {sourceStarting
            ? `Opening ${pendingSourceName || "candidate source"}`
            : progress?.stage === "reading"
              ? `Reading ${progress.sourceName || "candidate source"}`
              : progress?.stage === "synthesizing"
                ? "Consolidating and deduplicating evidence"
                : "Preparing full evidence analysis"}
        </strong>
        <span>
          {progress?.stage === "reading"
            ? `${progress.completed} of ${progress.total} chunks read. Every eligible source is reread before the evidence ledger is rebuilt.`
            : progress?.stage === "synthesizing"
              ? `All ${progress.total} chunks are read. Rebuilding detailed knowledge and the deduplicated evidence index used for matching.`
              : "Starting the complete reread, consolidation, and deduplication pass."}
        </span>
        <small className="analysis-disclaimer">
          Please be patient. We are composing detailed, source-backed
          knowledge about your experience. This can take a while, but it gives
          job search and matching much stronger evidence.
        </small>
        <div
          className="progress-track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progressPercent}
        >
          <i style={{ width: `${progressPercent}%` }} />
        </div>
      </div>
    </div>
  );
}

function EvidenceLedger({
  workspace,
  canonicalEvidence,
  disabled,
  onRemove,
}: {
  workspace: JobSearchWorkspace;
  canonicalEvidence?: CanonicalEvidenceModel;
  disabled: boolean;
  onRemove: (sourceId: string) => void;
}) {
  if (workspace.sources.length === 0) return null;
  return (
    <section className="band evidence-ledger">
      <div className="subsection-heading">
        <span className="section-label">Candidate evidence</span>
        <strong>Evidence found and considered in job search</strong>
        <small>
          Codex reasons across these source-backed facts when ranking jobs.
        </small>
      </div>
      {workspace.intelligence.evidenceRun && (
        <div
          className={`canonical-evidence-readiness ${
            workspace.intelligence.evidenceRun.readyForSearch ? "ready" : "blocked"
          }`}
        >
          <strong>
            {workspace.intelligence.evidenceRun.readyForSearch
              ? "Canonical evidence is ready for search"
              : "Canonical evidence needs review"}
          </strong>
          <span>
            {workspace.intelligence.evidenceRun.counts.supportedClaims} supported claims ·{" "}
            {workspace.intelligence.evidenceRun.counts.capabilities} capabilities ·{" "}
            {workspace.intelligence.evidenceRun.counts.roleFamilies} role families
          </span>
          {workspace.intelligence.evidenceRun.blockers.map((blocker) => (
            <small key={blocker}>{blocker}</small>
          ))}
          {workspace.intelligence.evidenceRun.warnings.map((warning) => (
            <small key={warning}>{warning}</small>
          ))}
          {canonicalEvidence && (
            <details className="canonical-evidence-review">
              <summary>Review canonical claims and search roles</summary>
              <div className="canonical-evidence-columns">
                <section>
                  <strong>Atomic claims</strong>
                  <ul>
                    {canonicalEvidence.claims.map((claim) => (
                      <li key={claim.claimId}>
                        <span>{claim.action}</span>
                        <small>
                          {claim.capability} · {claim.supportStatus} ·{" "}
                          {Math.round(claim.confidence * 100)}%
                        </small>
                        {claim.sourceRefs.map((ref) => (
                          <small key={`${ref.sourceVersionId}:${ref.locator}`}>
                            {ref.locator}: “{ref.quote}”
                          </small>
                        ))}
                      </li>
                    ))}
                  </ul>
                </section>
                <section>
                  <strong>Role hypotheses</strong>
                  <ul>
                    {canonicalEvidence.roleFamilies.map((role) => (
                      <li key={role.roleFamilyId}>
                        <span>{role.canonicalTitle}</span>
                        <small>{role.roleClass} · {Math.round(role.confidence * 100)}%</small>
                      </li>
                    ))}
                  </ul>
                  {canonicalEvidence.unknowns.length > 0 && (
                    <>
                      <strong>Material unknowns</strong>
                      <ul>
                        {canonicalEvidence.unknowns.map((unknown) => (
                          <li key={unknown.unknownId}>
                            <span>{unknown.field}</span>
                            <small>{unknown.reason}</small>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </section>
              </div>
            </details>
          )}
        </div>
      )}
      <div className="evidence-sources">
        {workspace.sources.map((source) => (
          <section className="evidence-source" key={source.id}>
            <header>
              <span className="file-icon">
                {source.url ? <Globe2 size={15} /> : <FileText size={15} />}
              </span>
              <div>
                <small>
                  {source.profileField ? "Profile evidence" : "Source"} · {source.kind}
                </small>
                <strong>{source.name}</strong>
              </div>
              <span className="evidence-source-actions">
                {source.status === "processing" ? (
                  <LoaderCircle size={16} className="spin" />
                ) : source.status === "analysis_failed" ||
                  source.status === "needs_review" ? (
                  <AlertTriangle size={16} className="amber" />
                ) : (
                  <CheckCircle2 size={16} className="green" />
                )}
                <button
                  type="button"
                  disabled={disabled}
                  title={`Remove ${source.name} and rebuild evidence`}
                  aria-label={`Remove ${source.name}`}
                  onClick={() => onRemove(source.id)}
                >
                  <X size={13} />
                </button>
              </span>
            </header>
            {source.status === "processing" && (
              <p className="evidence-pending">Extracting evidence...</p>
            )}
            {source.error && <p className="source-error">{source.error}</p>}
            {source.insights.length > 0 && (
              <ul>
                {source.insights.map((insight) => (
                  <li key={insight.id}>
                    <strong>{insight.title}</strong>
                    <span>{insight.summary}</span>
                    {insight.skills.length > 0 && (
                      <small>{insight.skills.join(" · ")}</small>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {source.status === "ready" && source.insights.length === 0 && (
              <p className="no-insights">
                No job-relevant evidence was identified in this source.
              </p>
            )}
          </section>
        ))}
      </div>
    </section>
  );
}

function ProfileBasics({
  workspace,
  act,
  disabled = false,
  evidenceLinks,
  onEvidenceLinksChange,
}: ViewProps & {
  disabled?: boolean;
  evidenceLinks?: EvidenceLinkDraft;
  onEvidenceLinksChange?: (value: EvidenceLinkDraft) => void;
}) {
  const initialValue = {
    name: workspace.profile.name,
    email: workspace.profile.email,
    phone: workspace.profile.phone,
    linkedin: workspace.profile.linkedin,
    github: workspace.profile.github,
    website: workspace.profile.website,
    workAuthorization: workspace.profile.workAuthorization,
  };
  const [value, setValue] = useState(initialValue);
  const saved = {
    name: workspace.profile.name,
    email: workspace.profile.email,
    phone: workspace.profile.phone,
    linkedin: workspace.profile.linkedin,
    github: workspace.profile.github,
    website: workspace.profile.website,
    workAuthorization: workspace.profile.workAuthorization,
  };
  const previousSavedRef = useRef(initialValue);
  const saveRef = useRef(
    (profile: typeof value) => void act(() => updateCandidateProfile(profile)),
  );
  saveRef.current = (profile) =>
    void act(() => updateCandidateProfile(profile));
  const serialized = JSON.stringify(value);
  const savedSerialized = JSON.stringify(saved);
  useEffect(() => {
    const previous = previousSavedRef.current;
    setValue((current) => {
      const next = { ...current };
      for (const key of Object.keys(next) as Array<keyof typeof next>)
        if (current[key] === previous[key]) next[key] = saved[key];
      return next;
    });
    previousSavedRef.current = saved;
  }, [savedSerialized]);
  useEffect(() => {
    if (serialized === savedSerialized) return;
    const timer = window.setTimeout(
      () => saveRef.current(JSON.parse(serialized) as typeof value),
      500,
    );
    return () => window.clearTimeout(timer);
  }, [serialized, savedSerialized]);
  const nameReady = Boolean(value.name.trim());
  const emailReady = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email.trim());
  const displayedEvidenceLinks = evidenceLinks ?? {
    linkedin: value.linkedin,
    github: value.github,
    website: value.website,
  };
  const setDisplayedEvidenceLinks = (next: EvidenceLinkDraft) => {
    if (onEvidenceLinksChange) onEvidenceLinksChange(next);
    else setValue((current) => ({ ...current, ...next }));
  };
  const displayedWebsiteAddress = websiteAddressPart(
    displayedEvidenceLinks.website,
  );
  const websiteProtocol = websiteProtocolPart(displayedEvidenceLinks.website);
  return (
    <div className="profile-basics">
      <div className="subsection-heading">
        <span className="section-label">Basic information</span>
        <strong>Confirm the details found in your CV</strong>
        <small>
          Full name and email are required. Workplace and willing-work locations
          are configured separately below.
        </small>
      </div>
      <div className="basic-fields">
        <label className={nameReady ? "field-complete" : "field-required"}>
          Full name
          <input
            disabled={disabled}
            value={value.name}
            placeholder="Required"
            onChange={(event) =>
              setValue({ ...value, name: event.target.value })
            }
          />
        </label>
        <label className={emailReady ? "field-complete" : "field-required"}>
          Email
          <input
            disabled={disabled}
            type="email"
            value={value.email}
            placeholder="Required"
            onChange={(event) =>
              setValue({ ...value, email: event.target.value })
            }
          />
        </label>
      </div>
      <div className="optional-evidence-fields">
        <div className="subsection-heading">
          <span className="section-label">Optional evidence</span>
          <strong>The more you provide, the better the search results</strong>
          <small>
            LinkedIn, GitHub, and your personal website are optional. Any link
            you add is read as candidate evidence.
          </small>
        </div>
        <div className="evidence-link-fields">
        <label className={displayedEvidenceLinks.linkedin.trim() ? "field-complete" : ""}>
          <span className="profile-field-label">
            LinkedIn <small>Optional</small>
          </span>
          <input
            disabled={disabled}
            type="url"
            value={displayedEvidenceLinks.linkedin}
            placeholder="https://linkedin.com/in/..."
            onChange={(event) =>
              setDisplayedEvidenceLinks({
                ...displayedEvidenceLinks,
                linkedin: event.target.value,
              })
            }
          />
        </label>
        <label className={displayedEvidenceLinks.github.trim() ? "field-complete" : ""}>
          <span className="profile-field-label">
            GitHub <small>Optional</small>
          </span>
          <input
            disabled={disabled}
            type="url"
            value={displayedEvidenceLinks.github}
            placeholder="https://github.com/..."
            onChange={(event) =>
              setDisplayedEvidenceLinks({
                ...displayedEvidenceLinks,
                github: event.target.value,
              })
            }
          />
        </label>
        <label className={displayedWebsiteAddress.trim() ? "field-complete" : ""}>
          <span className="profile-field-label">
            Personal website <small>Optional</small>
          </span>
          <span className="url-prefix-input">
            <b>{websiteProtocol}</b>
            <input
              disabled={disabled}
              type="text"
              inputMode="url"
              value={displayedWebsiteAddress}
              placeholder="your-website.com"
              onChange={(event) => {
                const next = parseWebsiteInput(
                  event.target.value,
                  websiteProtocol,
                );
                setDisplayedEvidenceLinks({
                  ...displayedEvidenceLinks,
                  website: next,
                });
              }}
            />
          </span>
        </label>
        </div>
      </div>
    </div>
  );
}

function websiteProtocolPart(value: string) {
  return value.trim().toLowerCase().startsWith("https://")
    ? "https://"
    : "http://";
}

function websiteAddressPart(value: string) {
  return value.trim().replace(/^https?:\/\//i, "");
}

function parseWebsiteInput(value: string, fallbackProtocol: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const pastedProtocol = trimmed.match(/^https?:\/\//i)?.[0].toLowerCase();
  const address = websiteAddressPart(trimmed);
  return address ? `${pastedProtocol ?? fallbackProtocol}${address}` : "";
}

function PreferencesSection({
  workspace,
  unanswered,
  busy,
  act,
}: ViewProps & { unanswered: JobSearchWorkspace["questions"] }) {
  return (
    <section className="band questions" id="job-search-preferences">
      <div className="section-head">
        <div>
          <span className="section-label">Job preferences</span>
          <h2>Information needed for job search</h2>
          <p className="autosave-note">
            Changes save automatically. Compensation is optional.
          </p>
        </div>
        <span className="count">{unanswered.length} open</span>
      </div>
      {workspace.questions.map((question) => (
        <Question
          key={`${workspace.candidateId}-${question.id}`}
          question={question}
          busy={busy}
          act={act}
        />
      ))}
      <div className="footer-action">
        <span>
          <ShieldCheck size={16} /> Required answers gate job search and prevent
          fabricated form values.
        </span>
      </div>
    </section>
  );
}

function Question({
  question,
  busy,
  act,
}: {
  question: JobSearchWorkspace["questions"][number];
  busy: boolean;
  act: ViewProps["act"];
}) {
  const save = (answer: string) =>
    void act(() => answerQuestion(question.id, answer));
  if (question.id === "salary")
    return <SalaryQuestion question={question} busy={busy} save={save} />;
  if (question.id === "locations")
    return <WorkLocationQuestion question={question} busy={busy} save={save} />;
  if (question.id === "employment")
    return <EmploymentQuestion question={question} busy={busy} save={save} />;
  if (question.id === "start")
    return <StartDateQuestion question={question} busy={busy} save={save} />;
  return <LanguageQuestion question={question} busy={busy} save={save} />;
}

type PreferenceQuestionProps = {
  question: JobSearchWorkspace["questions"][number];
  busy: boolean;
  save: (answer: string) => void;
};
function PreferenceQuestion({
  question,
  complete = Boolean(question.answer),
  children,
}: {
  question: PreferenceQuestionProps["question"];
  complete?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`question preference-question ${complete ? "answered" : question.required ? "needs-answer" : "optional-empty"} ${question.required ? "required" : "optional"}`}
    >
      <span className="question-status">
        {complete ? <Check size={15} /> : <Inbox size={15} />}
      </span>
      <div>
        <strong>
          {question.prompt}
          {!question.required && <em>Optional</em>}
        </strong>
        <small>{question.rationale}</small>
        {children}
      </div>
    </div>
  );
}

function useAutoSaveAnswer(
  answer: string,
  savedAnswer: string,
  valid: boolean,
  save: (answer: string) => void,
) {
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    if (!valid || answer === savedAnswer) return;
    const timer = window.setTimeout(() => saveRef.current(answer), 450);
    return () => window.clearTimeout(timer);
  }, [answer, savedAnswer, valid]);
}

function SalaryQuestion({ question, busy, save }: PreferenceQuestionProps) {
  const parsed = question.answer.match(
    /^([A-Z]{3})\s+(?:(\d+)(?:\s+-\s+(\d+))?|up to\s+(\d+))\s+per year$/,
  );
  const [currency, setCurrency] = useState(parsed?.[1] || "EUR");
  const [minimum, setMinimum] = useState(parsed?.[2] || "");
  const answer = minimum ? `${currency} ${minimum} per year` : "";
  useAutoSaveAnswer(answer, question.answer, true, save);
  return (
    <PreferenceQuestion question={question} complete={Boolean(answer)}>
      <div className="salary-controls">
        <label>
          Currency
          <select
            disabled={busy}
            value={currency}
            onChange={(event) => setCurrency(event.target.value)}
          >
            {["EUR", "USD", "GBP", "CHF", "CZK", "PLN", "CAD", "AUD"].map(
              (item) => (
                <option key={item}>{item}</option>
              ),
            )}
          </select>
        </label>
        <label className="salary-minimum">
          Minimum
          <span className="amount-with-unit">
            <input
              aria-label="Minimum annual compensation"
              type="number"
              min="0"
              step="1000"
              disabled={busy}
              value={minimum}
              onChange={(event) => setMinimum(event.target.value)}
              placeholder="60000"
            />
            <span>/ year</span>
          </span>
        </label>
      </div>
    </PreferenceQuestion>
  );
}

function EmploymentQuestion({ question, busy, save }: PreferenceQuestionProps) {
  const options = ["Full-time", "Contract", "Part-time", "Freelance"];
  const [selected, setSelected] = useState(() =>
    options.filter((item) => question.answer.includes(item)),
  );
  const toggle = (item: string) =>
    setSelected((items) =>
      items.includes(item)
        ? items.filter((value) => value !== item)
        : [...items, item],
    );
  const answer = selected.join(", ");
  useAutoSaveAnswer(answer, question.answer, true, save);
  return (
    <PreferenceQuestion question={question} complete={selected.length > 0}>
      <div className="choice-grid">
        {options.map((item) => (
          <label
            key={item}
            className={selected.includes(item) ? "selected" : ""}
          >
            <input
              type="checkbox"
              disabled={busy}
              checked={selected.includes(item)}
              onChange={() => toggle(item)}
            />{" "}
            {item}
          </label>
        ))}
      </div>
    </PreferenceQuestion>
  );
}

function WorkLocationQuestion({
  question,
  busy,
  save,
}: PreferenceQuestionProps) {
  const [modes, setModes] = useState(() =>
    ["Remote", "Hybrid", "On-site"].filter((item) =>
      question.answer.includes(item),
    ),
  );
  const locationPart = question.answer.includes(":")
    ? question.answer.split(":").slice(1).join(":").trim()
    : "";
  const [locations, setLocations] = useState(() =>
    locationPart
      ? locationPart
          .split("|")
          .map((item) => item.trim())
          .filter(Boolean)
      : [],
  );
  const [query, setQuery] = useState("");
  const suggestions = LOCATION_OPTIONS.filter(
    (item) =>
      !item.startsWith("Remote") &&
      item !== "Hybrid" &&
      item.toLowerCase().includes(query.toLowerCase()) &&
      !locations.includes(item),
  ).slice(0, 6);
  const toggleMode = (mode: string) =>
    setModes((items) =>
      items.includes(mode)
        ? items.filter((item) => item !== mode)
        : [...items, mode],
    );
  const addLocation = (value: string) => {
    const location = value.trim();
    if (location && !locations.includes(location))
      setLocations([...locations, location]);
    setQuery("");
  };
  const needsLocation = modes.some((mode) => mode !== "Remote");
  const answer = modes.length
    ? `${modes.join(", ")}${needsLocation && locations.length ? `: ${locations.join(" | ")}` : ""}`
    : "";
  const complete = modes.length > 0 && (!needsLocation || locations.length > 0);
  useAutoSaveAnswer(
    answer,
    question.answer,
    complete || modes.length === 0,
    save,
  );
  return (
    <PreferenceQuestion question={question} complete={complete}>
      <div className="choice-grid work-modes">
        {["Remote", "Hybrid", "On-site"].map((mode) => (
          <label key={mode} className={modes.includes(mode) ? "selected" : ""}>
            <input
              type="checkbox"
              disabled={busy}
              checked={modes.includes(mode)}
              onChange={() => toggleMode(mode)}
            />{" "}
            {mode}
          </label>
        ))}
      </div>
      {needsLocation && (
        <div className="location-picker">
          <div className="selected-locations">
            {locations.map((location) => (
              <span key={location}>
                {location}
                <button
                  disabled={busy}
                  title={`Remove ${location}`}
                  onClick={() =>
                    setLocations(locations.filter((item) => item !== location))
                  }
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
          <input
            disabled={busy}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addLocation(query);
              }
            }}
            placeholder="Type a city, country, or region"
          />
          {query && (
            <div className="location-results">
              {suggestions.map((location) => (
                <button key={location} onClick={() => addLocation(location)}>
                  {location}
                </button>
              ))}
              <button onClick={() => addLocation(query)}>Use “{query}”</button>
            </div>
          )}
        </div>
      )}
      {needsLocation && locations.length === 0 && (
        <span className="field-warning">
          Add at least one city, country, or region for hybrid and on-site work.
        </span>
      )}
    </PreferenceQuestion>
  );
}

function StartDateQuestion({ question, busy, save }: PreferenceQuestionProps) {
  const [immediately, setImmediately] = useState(
    question.answer === "Immediately",
  );
  const [date, setDate] = useState(
    /^\d{4}-\d{2}-\d{2}$/.test(question.answer) ? question.answer : "",
  );
  const answer = immediately ? "Immediately" : date;
  useAutoSaveAnswer(answer, question.answer, true, save);
  return (
    <PreferenceQuestion question={question} complete={Boolean(answer)}>
      <div className="start-controls">
        <label className="inline-check">
          <input
            type="checkbox"
            disabled={busy}
            checked={immediately}
            onChange={(event) => setImmediately(event.target.checked)}
          />{" "}
          Immediately
        </label>
        <span>or</span>
        <label>
          Available from
          <input
            type="date"
            disabled={busy || immediately}
            min={new Date().toISOString().slice(0, 10)}
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
        </label>
      </div>
    </PreferenceQuestion>
  );
}

function LanguageQuestion({ question, busy, save }: PreferenceQuestionProps) {
  const parse = (value: string) =>
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const match = item.match(/^(.*?)\s*\((.*?)\)$/);
        return {
          language: match?.[1] || item,
          level: match?.[2] || "Professional",
        };
      });
  const [items, setItems] = useState(() => parse(question.answer));
  const commit = (nextItems: typeof items) => {
    setItems(nextItems);
    save(
      nextItems
        .map((item) => `${item.language} (${item.level})`)
        .join(", "),
    );
  };
  const add = (language: string) => {
    if (!language || items.some((item) => item.language === language)) return;
    commit([...items, { language, level: "Professional" }]);
  };
  return (
    <PreferenceQuestion question={question} complete={items.length > 0}>
      <div className="language-controls">
        <select
          aria-label="Add language"
          disabled={busy}
          value=""
          onChange={(event) => add(event.target.value)}
        >
          <option value="" disabled>
            Select a language to add
          </option>
          {LANGUAGE_OPTIONS.filter(
            (item) => !items.some((selected) => selected.language === item),
          ).map((item) => (
            <option key={item}>{item}</option>
          ))}
        </select>
      </div>
      <div className="selected-languages">
        {items.map((item) => (
          <div key={item.language} className="selected-language">
            <strong>{item.language}</strong>
            <select
              aria-label={`${item.language} proficiency`}
              disabled={busy}
              value={item.level}
              onChange={(event) =>
                commit(
                  items.map((value) =>
                    value.language === item.language
                      ? { ...value, level: event.target.value }
                      : value,
                  ),
                )
              }
            >
              {["Native", "Fluent", "Professional", "Conversational", "Basic"].map(
                (level) => (
                  <option key={level}>{level}</option>
                ),
              )}
            </select>
            <button
              title={`Remove ${item.language}`}
              disabled={busy}
              onClick={() =>
                commit(items.filter((value) => value.language !== item.language))
              }
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
    </PreferenceQuestion>
  );
}

function DiscoveryView({
  workspace,
  busy,
  act,
  onContinue,
}: ViewProps & { onContinue: () => void }) {
  const progress = workspace.searchProgress;
  const running =
    progress?.stage === "looking" ||
    progress?.stage === "verifying" ||
    progress?.stage === "filling";
  const prepared = preparedVerifiedApplications(workspace);
  const allPipelineItems = cumulativePipelineItems(workspace);
  const currentItemIds = new Set(
    (progress?.items ?? []).map((item) => item.id),
  );
  const preparedPipelineItems = preparedVerifiedItemsFrom(
    workspace,
    allPipelineItems,
  );
  const currentPreparedItems = preparedPipelineItems.filter((item) =>
    currentItemIds.has(item.id),
  );
  const hasDiscoveryData =
    Boolean(progress) ||
    workspace.opportunities.length > 0 ||
    workspace.searchReadyOpportunities.length > 0 ||
    workspace.applications.length > 0 ||
    workspace.rejectedOpportunities.length > 0 ||
    workspace.searchValidationIssues.length > 0 ||
    workspace.jobHistory.length > 0 ||
    workspace.seenJobUrls.length > 0;
  const applicationJobIds = new Set(
    workspace.applications.map((application) => application.jobId),
  );
  const bench = workspace.opportunities
    .filter((job) => !applicationJobIds.has(job.id))
    .sort((a, b) => b.fit - a.fit);
  const readyForMatching = workspace.searchReadyOpportunities ?? [];
  const promote = (jobId: string) =>
    void act(
      () => promoteOpportunity(jobId),
      "applications",
      "application-preparation",
    );
  if (!candidateDiscoveryReady(workspace))
    return (
      <section className="discovery-blocked" role="status">
        <LoaderCircle className="spin" size={24} />
        <div>
          <strong>Updating profile evidence, please wait</strong>
          <span>
            Discovery is paused while the candidate knowledge and evidence
            index are rebuilt.
          </span>
        </div>
      </section>
    );
  return (
    <div className="discovery-view">
      <section className="application-overview-toolbar discovery-toolbar">
        <div>
          <strong>{progress ? "Discover another batch" : "Start job discovery"}</strong>
          <span>
            Live vacancies are verified, matched to evidence, and prepared
            before they reach Applications.
          </span>
        </div>
        <div className="search-pool-controls">
          <label>
            Discover
            <input
              aria-label="Jobs to discover per search"
              type="number"
              min={5}
              max={50}
              value={workspace.searchConfig.discoveryTarget}
              disabled={busy || running}
              onChange={(event) =>
                void act(() =>
                  updateSearchConfig({
                    ...workspace.searchConfig,
                    discoveryTarget: Number(event.target.value),
                  }),
                )
              }
            />
          </label>
          <button
            className="queue-find"
            disabled={busy || running}
            onClick={() =>
              void act(
                progress ? findMoreApplications : prepareApplications,
                undefined,
                "job-search",
              )
            }
          >
            {running ? (
              <LoaderCircle className="spin" size={14} />
            ) : (
              <Search size={14} />
            )}
            {progress
              ? `Prepare next ${workspace.searchConfig.applicationTarget}`
              : "Start discovery"}
          </button>
          <button
            type="button"
            className="reset-discovery"
            disabled={busy || running || !hasDiscoveryData}
            title={
              running
                ? "Stop the active discovery run before resetting it."
                : "Clear all discovery results while keeping the candidate profile and evidence."
            }
            onClick={() => {
              if (
                window.confirm(
                  "Reset discovery? This removes all discovered jobs, matches, rejected jobs, and prepared applications. Candidate profile and evidence will be kept.",
                )
              )
                void act(resetJobList, "discovery");
            }}
          >
            <RefreshCw size={13} />
            Reset discovery
          </button>
        </div>
      </section>
      {progress ? (
        <FindApplicationsProgress
          progress={progress}
          allItems={allPipelineItems}
          preparedItems={preparedPipelineItems}
          currentItemIds={currentItemIds}
        />
      ) : (
        <section className="discovery-empty">
          <Search size={25} />
          <strong>Candidate evidence is ready</strong>
          <span>Start Discovery to find the first grounded applications.</span>
        </section>
      )}
      {prepared.length > 0 && (
        <section className="discovery-continue">
          <div>
            <CheckCircle2 size={18} />
            <span>
              <strong>
                {currentPreparedItems.length} new applications prepared
              </strong>
              <small>
                {prepared.length} total in Applications; some may need your input.
              </small>
            </span>
          </div>
          <button className="primary" onClick={onContinue}>
            Continue to applications <ChevronRight size={15} />
          </button>
        </section>
      )}
      {readyForMatching.length > 0 && !running && (
        <section className="discovery-continue">
          <div>
            <CheckCircle2 size={18} />
            <span>
              <strong>{readyForMatching.length} vacancies passed search verification</strong>
              <small>Run evidence matching, then prepare forms for feasible matches.</small>
            </span>
          </div>
          <button
            className="primary"
            onClick={() =>
              void act(
                prepareSearchReadyApplications,
                undefined,
                "application-preparation",
              )
            }
          >
            Match and prepare {readyForMatching.length} <ChevronRight size={15} />
          </button>
        </section>
      )}
      {progress && (
        <>
          <PipelinePool
            title={readyForMatching.length
              ? `Ready for matching · ${readyForMatching.length}`
              : `Verified bench · ${bench.length}`}
            detail={readyForMatching.length
              ? "Live, eligible vacancies that passed search verification; no matching decision is implied yet."
              : "Passing jobs ranked by evidence match and reconsidered on the next discovery run."}
            jobs={readyForMatching.length ? readyForMatching : bench}
            showFit={!readyForMatching.length}
            busy={busy || running}
            onPromote={promote}
          />
          <ValidationIssuePool
            failures={workspace.searchValidationIssues}
            busy={busy || running}
            onPromote={promote}
          />
          <RejectedPool
            failures={workspace.rejectedOpportunities}
            busy={busy || running}
            onPromote={promote}
          />
        </>
      )}
    </div>
  );
}
const APPLICATION_GROUPS = [
  {
    key: "open",
    label: "Open",
    detail: "Ready to send or waiting for your input",
  },
  {
    key: "applied_waiting",
    label: "Applied · waiting",
    detail: "Submitted and awaiting an employer response",
  },
  {
    key: "rejected_by_user",
    label: "Rejected by user",
    detail: "Roles you decided not to pursue",
  },
  {
    key: "unsuccessful",
    label: "Unsuccessful",
    detail: "Applications closed without an offer",
  },
] as const;

type ApplicationGroupKey = (typeof APPLICATION_GROUPS)[number]["key"];

function applicationGroupKey(application: ApplicationDraft): ApplicationGroupKey {
  return application.outcome ?? "open";
}

function ApplicationsOverview({
  workspace,
  onOpen,
}: {
  workspace: JobSearchWorkspace;
  onOpen: (id: string) => void;
}) {
  const preparedApplications = preparedVerifiedApplications(workspace);
  const currentJobIds = new Set(
    (workspace.searchProgress?.items ?? []).map((item) => item.id),
  );
  return (
    <div className="application-overview">
      <div className="application-groups">
        {APPLICATION_GROUPS.map((group) => {
          const applications = preparedApplications.filter(
            (application) => applicationGroupKey(application) === group.key,
          );
          const newest = applications.filter((application) =>
            currentJobIds.has(application.jobId),
          );
          const older = applications.filter(
            (application) => !currentJobIds.has(application.jobId),
          );
          return (
            <section
              className={`application-group group-${group.key}`}
              key={group.key}
            >
              <header>
                <div>
                  <strong>{group.label}</strong>
                  <span>{group.detail}</span>
                </div>
                <b>{applications.length}</b>
              </header>
              {applications.length ? (
                <div className="application-group-cards">
                  {newest.length > 0 && (
                    <section className="newest-batch-list">
                      <span className="newest-batch-label">Newest run</span>
                      {newest.map((application) => (
                        <ApplicationOverviewCard
                          application={application}
                          workspace={workspace}
                          onOpen={onOpen}
                          key={application.id}
                        />
                      ))}
                    </section>
                  )}
                  {older.map((application) => (
                    <ApplicationOverviewCard
                      application={application}
                      workspace={workspace}
                      onOpen={onOpen}
                      key={application.id}
                    />
                  ))}
                </div>
              ) : (
                <div className="application-group-empty">
                  No applications in this state.
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function ApplicationOverviewCard({
  application,
  workspace,
  onOpen,
}: {
  application: ApplicationDraft;
  workspace: JobSearchWorkspace;
  onOpen: (id: string) => void;
}) {
  const job = workspace.opportunities.find(
    (item) => item.id === application.jobId,
  );
  if (!job) return null;
  return (
    <article
      className={`job-row application-overview-card state-${applicationGroupKey(application)}`}
    >
      <div className="job-rank">{jobNumberLabel(job.jobNumber)}</div>
      <div className="job-main">
        <div className="job-title">
          <span className="company-mark">{job.company.charAt(0)}</span>
          <div>
            <strong>{job.title}</strong>
            <span>{job.company} · {job.location}</span>
          </div>
          <span
            className={`application-card-status status-${applicationGroupKey(application)}`}
          >
            {applicationStatusLabel(application)}
          </span>
        </div>
        <p>{job.summary}</p>
        <RequirementBreakdown job={job} />
      </div>
      <div className="job-side">
        <div
          className="score-ring"
          style={{ "--score": `${job.fit * 3.6}deg` } as React.CSSProperties}
        >
          <span>{job.fit}%</span>
        </div>
        <small className="fit-label">evidence match</small>
        <small>{compactCompensation(job.compensation)}</small>
        <button onClick={() => onOpen(application.id)}>
          Open application <ChevronRight size={15} />
        </button>
      </div>
    </article>
  );
}

function PipelinePool({
  title,
  detail,
  jobs,
  showFit = true,
  busy = false,
  onPromote,
}: {
  title: string;
  detail: string;
  jobs: JobSearchWorkspace["opportunities"];
  showFit?: boolean;
  busy?: boolean;
  onPromote?: (jobId: string) => void;
}) {
  return (
    <section className="pipeline-pool">
      <header>
        <div><strong>{title}</strong><span>{detail}</span></div>
      </header>
      {jobs.length ? jobs.map((job) => (
        <article className="pipeline-pool-row" key={job.id}>
          <div>
            <strong><span className="inline-job-number">{jobNumberLabel(job.jobNumber)}</span>{job.title}</strong>
            <span>{job.company} · {job.location}</span>
          </div>
          {showFit && <b>{job.fit}%</b>}
          <div className="pipeline-pool-actions">
            <a href={job.sourceUrl} target="_blank" rel="noreferrer">View job</a>
            {onPromote && (
              <button
                type="button"
                disabled={busy}
                onClick={() => onPromote(job.id)}
              >
                <Plus size={12} /> Add to applications
              </button>
            )}
          </div>
        </article>
      )) : <div className="application-group-empty">No verified jobs waiting on the bench.</div>}
    </section>
  );
}

function RejectedPool({
  failures,
  busy,
  onPromote,
}: {
  failures: JobSearchWorkspace["rejectedOpportunities"];
  busy: boolean;
  onPromote: (jobId: string) => void;
}) {
  return (
    <details className="pipeline-pool rejected-pool">
      <summary>
        <strong>Confirmed rejections · {failures.length}</strong>
        <span>Only confirmed closed vacancies and hard candidate constraints are rejected before matching.</span>
      </summary>
      {failures.length ? failures.map((failure) => (
        <article className="pipeline-pool-row" key={failure.id}>
          <div>
            <strong><span className="inline-job-number">{jobNumberLabel(failure.jobNumber)}</span>{failure.title}</strong>
            <span>{failure.company} · {failure.stage.replace(/_/g, " ")}</span>
            <small>{failure.reason}</small>
          </div>
          <div className="pipeline-pool-actions">
            <a href={failure.sourceUrl} target="_blank" rel="noreferrer">View source</a>
            <button type="button" disabled={busy} onClick={() => onPromote(failure.id)}>
              <Plus size={12} /> Add manually
            </button>
          </div>
        </article>
      )) : <div className="application-group-empty">No rejected jobs recorded.</div>}
    </details>
  );
}

function ValidationIssuePool({
  failures,
  busy,
  onPromote,
}: {
  failures: JobSearchWorkspace["searchValidationIssues"];
  busy: boolean;
  onPromote: (jobId: string) => void;
}) {
  return (
    <details className="pipeline-pool rejected-pool review-pool" open>
      <summary>
        <strong>Needs review or retry · {failures.length}</strong>
        <span>Access restrictions, technical failures, source pages, and duplicates do not enter matching and are not confirmed rejections.</span>
      </summary>
      {failures.length ? failures.map((failure) => (
        <article className="pipeline-pool-row" key={failure.id}>
          <div>
            <strong><span className="inline-job-number">{jobNumberLabel(failure.jobNumber)}</span>{failure.title}</strong>
            <span>{failure.company} · {(failure.disposition ?? "unresolved").replace(/_/g, " ")}</span>
            <small>{failure.reason}</small>
          </div>
          <div className="pipeline-pool-actions">
            <a href={failure.sourceUrl} target="_blank" rel="noreferrer">
              {failure.disposition === "manual_review" ? "Check manually" : "View source"}
            </a>
            <button type="button" disabled={busy} onClick={() => onPromote(failure.id)}>
              <Plus size={12} /> Add manually
            </button>
          </div>
        </article>
      )) : <div className="application-group-empty">No validation records need manual review or retry.</div>}
    </details>
  );
}

function FindApplicationsProgress({
  progress,
  allItems,
  preparedItems,
  currentItemIds,
  compact = false,
}: {
  progress: JobSearchWorkspace["searchProgress"];
  allItems: JobSearchWorkspace["jobHistory"];
  preparedItems: JobSearchWorkspace["jobHistory"];
  currentItemIds: Set<string>;
  compact?: boolean;
}) {
  if (!progress) return null;
  if (compact)
    return (
      <div className={`find-progress ${progress.stage}`} role="status" aria-live="polite">
        <span className="active">
          {progress.stage === "ready" ? <CheckCircle2 size={14} /> : <LoaderCircle className="spin" size={14} />}
          {progress.activity ?? "Processing the job pipeline"}
        </span>
        <small>{progress.found} of {progress.target} in the current stage</small>
        {progress.error && <small>{progress.error}</small>}
      </div>
    );
  const items = progress.items ?? [];
  const running = progress.stage === "looking" || progress.stage === "verifying" || progress.stage === "filling";
  const discoverySlots = Math.max(
    0,
    (progress.stage === "looking" ? progress.target : items.length) - items.length,
  );
  const allValidItems = allItems.filter(
    (item) => item.validation === "passed" || item.match !== "waiting",
  );
  const newValidCount = allValidItems.filter((item) =>
    currentItemIds.has(item.id),
  ).length;
  const newPreparedCount = preparedItems.filter((item) =>
    currentItemIds.has(item.id),
  ).length;
  const activity =
    progress.stage === "ready"
      ? `${newPreparedCount} new applications are prepared and independently verified. Some may still need candidate information before submission.`
      : progress.activity ?? "Job pipeline";
  return (
    <section className={`search-pipeline ${progress.stage}`} role="status" aria-live="polite">
      <header className="pipeline-activity">
        <span className={`pipeline-live-dot ${running ? "running" : ""}`} />
        <div>
          <strong>{activity}</strong>
          <PipelineElapsedTime progress={progress} running={running} />
        </div>
        <b>{items.length} jobs</b>
      </header>
      <div className="pipeline-board">
        <PipelineColumn
          step="1"
          title="Discover & verify"
          count={`${allItems.length} total · ${items.length} current`}
          items={allItems}
          currentItemIds={currentItemIds}
          phase="validation"
          placeholders={discoverySlots}
        />
        <span className="pipeline-arrow" aria-hidden="true">→</span>
        <PipelineColumn
          step="2"
          title="Match & rank"
          count={`${allValidItems.length} total · ${newValidCount} current`}
          items={[...allValidItems].sort((a, b) => (b.fit ?? -1) - (a.fit ?? -1))}
          currentItemIds={currentItemIds}
          phase="match"
        />
        <span className="pipeline-arrow" aria-hidden="true">→</span>
        <PipelineColumn
          step="3"
          title="Prepared & verified"
          count={`${preparedItems.length} total · ${newPreparedCount} current`}
          items={preparedItems}
          currentItemIds={currentItemIds}
          phase="prepared_verified"
        />
      </div>
      {!!progress.events?.length && (
        <div className="pipeline-events">
          {[...progress.events].slice(-4).reverse().map((event) => (
            <span key={event.id}>
              <time>{new Date(event.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
              {event.message}
            </span>
          ))}
        </div>
      )}
      {progress.error && <div className="pipeline-error">{progress.error}</div>}
    </section>
  );
}

function PipelineElapsedTime({
  progress,
  running,
}: {
  progress: NonNullable<JobSearchWorkspace["searchProgress"]>;
  running: boolean;
}) {
  const inferredStart =
    progress.events?.[0]?.createdAt ?? progress.updatedAt ?? new Date().toISOString();
  const startedAtRef = useRef(inferredStart);
  const wasRunningRef = useRef(running);
  if (running && !wasRunningRef.current) startedAtRef.current = inferredStart;
  wasRunningRef.current = running;

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  const start = Date.parse(startedAtRef.current);
  const stoppedAt = Date.parse(progress.updatedAt ?? startedAtRef.current);
  const end = running ? now : stoppedAt;
  const elapsed = formatElapsedTime(
    Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0,
  );
  const label = running
    ? "Live agent activity"
    : progress.stage === "ready"
      ? "Completed in"
      : "Stopped after";

  return (
    <small>
      {label}
      <span className="pipeline-elapsed" aria-live="off"> · {elapsed}</span>
    </small>
  );
}

function formatElapsedTime(milliseconds: number) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const paddedMinutes = String(minutes).padStart(2, "0");
  const paddedSeconds = String(seconds).padStart(2, "0");
  return hours > 0
    ? `${hours}:${paddedMinutes}:${paddedSeconds}`
    : `${paddedMinutes}:${paddedSeconds}`;
}

type PipelinePhase =
  | "validation"
  | "match"
  | "application"
  | "application_verification"
  | "prepared_verified";

function PipelineColumn({
  step,
  title,
  count,
  items,
  currentItemIds,
  phase,
  placeholders = 0,
}: {
  step: string;
  title: string;
  count: string;
  items: NonNullable<NonNullable<JobSearchWorkspace["searchProgress"]>["items"]>;
  currentItemIds: Set<string>;
  phase: PipelinePhase;
  placeholders?: number;
}) {
  const newest = items.filter((item) => currentItemIds.has(item.id));
  const older = items.filter((item) => !currentItemIds.has(item.id));
  const renderItem = (
    item: NonNullable<
      NonNullable<JobSearchWorkspace["searchProgress"]>["items"]
    >[number],
  ) => {
    const state = pipelineItemState(item, phase);
    return (
      <article className={`pipeline-job state-${state}`} key={`${phase}-${item.id}`} title={item.reason}>
        <span className="pipeline-state-icon">
          {state === "running" ? <LoaderCircle className="spin" size={13} /> : state === "passed" ? <Check size={13} /> : state === "failed" ? <X size={13} /> : state === "bench" ? <Clock3 size={13} /> : state === "selected" ? <ChevronRight size={13} /> : <span />}
        </span>
        <a href={item.sourceUrl || undefined} target="_blank" rel="noreferrer">
          <strong>
            <span className="inline-job-number">{jobNumberLabel(item.jobNumber)}</span>
            {item.title || "Vacancy"}
          </strong>
          <span>{item.company || "Source pending"}</span>
          {phase === "match" && typeof item.fit === "number" && <em>{item.fit}% match</em>}
          {phase === "validation" && item.validationDisposition && (
            <em>{item.validationDisposition.replace(/_/g, " ")}</em>
          )}
          {item.reason && state === "failed" && <small>{item.reason}</small>}
        </a>
      </article>
    );
  };
  return (
    <section className="pipeline-column">
      <header>
        <b>{step}</b>
        <div><strong>{title}</strong><span>{count}</span></div>
      </header>
      <div className="pipeline-column-scroll">
        <section className="newest-batch-list pipeline-newest-batch">
          <span className="newest-batch-label">Current run</span>
          {newest.length > 0 || placeholders > 0 ? (
            <>
            {newest.map(renderItem)}
            {Array.from({ length: placeholders }, (_, index) => (
              <article className="pipeline-job pipeline-placeholder" key={`slot-${index}`}>
                <span>{String(newest.length + index + 1).padStart(2, "0")}</span>
                <div><i /><i /></div>
              </article>
            ))}
            </>
          ) : (
            <span className="pipeline-area-empty">No job is at this stage in the current run.</span>
          )}
        </section>
        <section className="pipeline-previous-batches">
          <span className="pipeline-previous-label">Previous runs</span>
          {older.length > 0 ? (
            older.map(renderItem)
          ) : (
            <span className="pipeline-area-empty">No previous jobs at this stage.</span>
          )}
        </section>
      </div>
    </section>
  );
}

function pipelineItemState(
  item: NonNullable<NonNullable<JobSearchWorkspace["searchProgress"]>["items"]>[number],
  phase: PipelinePhase,
) {
  if (phase === "prepared_verified") return "passed";
  if (phase === "application_verification") return item.applicationVerification;
  return item[phase];
}

function RequirementBreakdown({
  job,
}: {
  job: JobSearchWorkspace["opportunities"][number];
}) {
  const matches = job.requirementMatches ?? [];
  if (matches.length === 0)
    return (
      <div className="requirement-empty">
        No agent-generated requirement assessment is available for this result.
      </div>
    );
  const requiredMatches = matches.filter((item) => item.kind === "required");
  const preferredMatches = matches.filter(
    (item) => item.kind === "preferred",
  );
  const responsibilities = matches.filter(
    (item) => item.category === "responsibility",
  );
  const mandatory = matches.filter(
    (item) =>
      item.category === "mandatory" ||
      (!item.category && item.kind === "required"),
  );
  const constraints = matches.filter((item) => item.category === "constraint");
  return (
    <details className="requirement-breakdown">
      <summary>
        <span>Requirement evidence</span>
        <span className="requirement-group-counts">
          <RequirementStatusCounts
            label="Required"
            items={requiredMatches}
          />
          <RequirementStatusCounts
            label="Preferred"
            items={preferredMatches}
          />
        </span>
      </summary>
      <div className="fit-basis">
        Match score: mandatory qualifications weigh 3, core responsibilities 2,
        and preferred qualifications 1. Explicit, strong-adjacent, and
        weak-adjacent evidence receive different credit, adjusted by match and
        claim confidence. Opportunity confidence and hard feasibility are kept
        separate from fit.
        {(job.portfolioCategory || typeof job.opportunityConfidence === "number") && (
          <span>
            {job.portfolioCategory
              ? ` Portfolio: ${job.portfolioCategory.replace(/_/g, " ")}.`
              : ""}
            {typeof job.opportunityConfidence === "number"
              ? ` Opportunity confidence: ${Math.round(job.opportunityConfidence * 100)}%.`
              : ""}
          </span>
        )}
      </div>
      <div className="requirement-sections">
        <RequirementSection
          title="Core responsibilities"
          items={responsibilities}
        />
        <RequirementSection
          title="Mandatory qualifications"
          items={mandatory}
        />
        <RequirementSection
          title="Preferred / nice-to-have qualifications"
          items={preferredMatches}
        />
        <RequirementSection title="Constraints" items={constraints} />
      </div>
    </details>
  );
}

function RequirementSection({
  title,
  items,
}: {
  title: string;
  items: JobSearchWorkspace["opportunities"][number]["requirementMatches"];
}) {
  if (items.length === 0) return null;
  return (
    <section className="requirement-section">
      <header>
        <strong>{title}</strong>
        <RequirementStatusCounts items={items} />
      </header>
      <div className="requirement-list">
        {items.map((item) => (
          <div
            className={`requirement-row requirement-${item.status}`}
            key={item.id}
          >
            <div className="requirement-status-icon" aria-hidden="true">
              {item.status === "matched" ? (
                <CheckCircle2 size={17} />
              ) : item.status === "partial" ? (
                <CircleHelp size={17} />
              ) : (
                <X size={17} />
              )}
            </div>
            <div className="requirement-content">
              <div className="requirement-heading">
                <strong>{item.requirement}</strong>
                <span>
                  {(item.matchClass || item.status).replace(/_/g, " ")}
                  {item.gapSeverity && item.gapSeverity !== "none"
                    ? ` · ${item.gapSeverity} gap`
                    : ""}
                </span>
              </div>
              <p>{item.explanation}</p>
              {item.evidence.length > 0 && (
                <details className="requirement-citations">
                  <summary>
                    {item.evidence.length} grounded citation
                    {item.evidence.length === 1 ? "" : "s"}
                  </summary>
                  <ul>
                    {item.evidence.map((evidence, evidenceIndex) => (
                      <li
                        key={`${item.id}-${evidence.claimId || evidence.sourceId}-${evidenceIndex}`}
                      >
                        <span>
                          {evidence.sourceName}
                          {evidence.locator ? ` · ${evidence.locator}` : ""}
                        </span>
                        <q>{evidence.excerpt}</q>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function RequirementStatusCounts({
  label,
  items,
}: {
  label?: string;
  items: JobSearchWorkspace["opportunities"][number]["requirementMatches"];
}) {
  const matched = items.filter((item) => item.status === "matched").length;
  const partial = items.filter((item) => item.status === "partial").length;
  const missing = items.filter((item) => item.status === "missing").length;
  return (
    <span className="requirement-status-counts">
      {label && <em>{label}</em>}
      <b className="matched">{matched} matched</b>
      <b className="partial">{partial} partial</b>
      <b className="missing">{missing} missing</b>
    </span>
  );
}

function jobNumberLabel(jobNumber?: number) {
  return jobNumber ? `#${jobNumber}` : "#—";
}

function compactCompensation(value: string): string {
  const normalized = value.replace(/[\u00a0\u202f]/g, " ");
  const currency = "[$€£]|EUR|USD|GBP|CHF|CZK|PLN|CAD|AUD";
  const amount = "\\d(?:[\\d .,]*\\d)?";
  const range = normalized.match(
    new RegExp(
      `(${currency})?\\s*(${amount})\\s*([kK])?\\s*(?:-|–|—|to)\\s*(${currency})?\\s*(${amount})\\s*([kK])?\\s*(${currency})?\\s*(\\/\\s*(?:hr|hour)|per\\s+hour)?`,
      "i",
    ),
  );
  if (range) {
    const token = range[1] || range[4] || range[7] || "";
    const minimum = formatCompensationAmount(range[2], range[3]);
    const maximum = formatCompensationAmount(range[5], range[6]);
    const period = range[8] ? "/hr" : "";
    const prefix = compactCurrency(token);
    return `${prefix}${minimum}–${prefix}${maximum}${period}`;
  }
  const prefixed = normalized.match(
    new RegExp(`(${currency})\\s*(${amount})\\s*([kK])?`, "i"),
  );
  const suffixed = normalized.match(
    new RegExp(`(${amount})\\s*([kK])?\\s*(${currency})`, "i"),
  );
  if (prefixed)
    return `${compactCurrency(prefixed[1])}${formatCompensationAmount(prefixed[2], prefixed[3])}`;
  if (suffixed)
    return `${compactCurrency(suffixed[3])}${formatCompensationAmount(suffixed[1], suffixed[2])}`;
  return "Not disclosed";
}

function compactCurrency(value: string) {
  const token = value.toUpperCase();
  if (token === "EUR" || value === "€") return "€";
  if (token === "USD" || value === "$") return "$";
  if (token === "GBP" || value === "£") return "£";
  return token ? `${token} ` : "";
}

function formatCompensationAmount(value: string, suffix = "") {
  const compact = value.replace(/\s/g, "");
  const decimalComma = /,\d{1,2}$/.test(compact);
  const parsed = Number(
    decimalComma
      ? compact.replace(/\./g, "").replace(",", ".")
      : compact.replace(/,/g, ""),
  );
  if (!Number.isFinite(parsed)) return `${compact}${suffix || ""}`;
  return `${parsed.toLocaleString("en-US", { maximumFractionDigits: 2 })}${suffix?.toUpperCase() || ""}`;
}

function ApplicationsView({
  workspace,
  selectedId,
  setSelectedId,
  act,
  busy,
  onPrepareNext,
}: ViewProps & {
  selectedId?: string;
  setSelectedId: (id?: string) => void;
  onPrepareNext: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const applications = preparedVerifiedApplications(workspace);
  const currentApplicationJobIds = new Set(
    (workspace.searchProgress?.items ?? []).map((item) => item.id),
  );
  const newestApplications = applications.filter((application) =>
    currentApplicationJobIds.has(application.jobId),
  );
  const olderApplications = applications.filter(
    (application) => !currentApplicationJobIds.has(application.jobId),
  );
  const selected = selectedId
    ? applications.find((x) => x.id === selectedId)
    : undefined;
  const findProgress = workspace.searchProgress;
  const findingMore =
    findProgress?.stage === "looking" ||
    findProgress?.stage === "verifying" ||
    findProgress?.stage === "filling";
  const waitingCount = applications.filter(
    (application) => application.outcome === "applied_waiting",
  ).length;
  const openCount = applications.filter(
    (application) => !application.outcome,
  ).length;
  const closedCount = applications.filter(
    (application) =>
      application.outcome === "rejected_by_user" ||
      application.outcome === "unsuccessful",
  ).length;
  const header = (
    <>
      <div className="results-bar">
        <div>
          <strong>{applications.length} applications</strong>
          <span>
            {openCount} open · {waitingCount} applied · waiting · {closedCount}{" "}
            closed
          </span>
        </div>
        <div className="results-actions">
          <button
            className="queue-find"
            disabled={busy || findingMore}
            onClick={onPrepareNext}
          >
            {findingMore ? (
              <LoaderCircle className="spin" size={14} />
            ) : (
              <Search size={14} />
            )}
            Prepare next {workspace.searchConfig.applicationTarget}
          </button>
          <button
            className="primary"
            onClick={() => setAdding((value) => !value)}
          >
            <Plus size={15} /> Add application
          </button>
        </div>
      </div>
      {adding && (
        <AddApplicationForm
          busy={busy}
          onCancel={() => setAdding(false)}
          onAdd={(value) =>
            void act(() => addOpportunity(value)).then(() => setAdding(false))
          }
        />
      )}
    </>
  );
  if (!applications.length)
    return (
      <div className="stack">
        {header}
        <Empty
          icon={BriefcaseBusiness}
          title="No prepared applications yet"
          action="Return to discovery"
          disabled={busy || findingMore}
          onAction={onPrepareNext}
        />
      </div>
    );
  if (!selected)
    return (
      <div className="stack">
        {header}
        <ApplicationsOverview
          workspace={workspace}
          onOpen={(id) => {
            setSelectedId(id);
            window.requestAnimationFrame(() =>
              window.scrollTo({ top: 0, behavior: "smooth" }),
            );
          }}
        />
      </div>
    );
  const job = workspace.opportunities.find((x) => x.id === selected.jobId)!;
  const renderApplicationListEntry = (app: ApplicationDraft) => {
    const item = workspace.opportunities.find((x) => x.id === app.jobId)!;
    return (
      <button
        key={app.id}
        className={`application-list-entry ${app.id === selected.id ? "active" : ""} ${app.outcome ? `outcome-${app.outcome}` : ""}`}
        onClick={() => setSelectedId(app.id)}
      >
        <span className="company-mark">{item.company.charAt(0)}</span>
        <div>
          <strong>{item.title}</strong>
          <small>{jobNumberLabel(item.jobNumber)} · {applicationStatusLabel(app)}</small>
        </div>
        {app.outcome === "applied_waiting" ? (
          <Clock3 size={16} className="amber" />
        ) : app.outcome === "rejected_by_user" ? (
          <X size={16} />
        ) : app.outcome === "unsuccessful" ? (
          <AlertTriangle size={16} className="red" />
        ) : app.status === "ready_to_send" ? (
          <CheckCircle2 size={16} className="green" />
        ) : (
          <CircleHelp size={16} />
        )}
      </button>
    );
  };
  return (
    <div className="stack">
      {header}
      <div className="applications-layout">
        <aside className="application-list">
          <div className="list-title">
            <button
              className="queue-back"
              onClick={() => setSelectedId(undefined)}
            >
              <ChevronLeft size={14} /> All applications
            </button>
            <div className="queue-title-actions">
              <strong>{applications.length}</strong>
              <button
                className="queue-find"
                disabled={busy || findingMore}
                onClick={onPrepareNext}
              >
                {findingMore ? (
                  <LoaderCircle className="spin" size={13} />
                ) : (
                  <Search size={13} />
                )}
                Prepare next {workspace.searchConfig.applicationTarget}
              </button>
            </div>
          </div>
          {newestApplications.length > 0 && (
            <section className="newest-batch-list application-list-newest">
              <span className="newest-batch-label">Newest run</span>
              {newestApplications.map(renderApplicationListEntry)}
            </section>
          )}
          {olderApplications.map(renderApplicationListEntry)}
        </aside>
        <ApplicationEditor
          key={selected.id}
          app={selected}
          job={job}
          busy={busy}
          act={act}
        />
      </div>
    </div>
  );
}

function ApplicationEditor({
  app,
  job,
  busy,
  act,
}: {
  app: ApplicationDraft;
  job: JobSearchWorkspace["opportunities"][number];
  busy: boolean;
  act: ViewProps["act"];
}) {
  const [coverLetter, setCoverLetter] = useState(app.coverLetter);
  const [coverLetterMessage, setCoverLetterMessage] = useState("");
  const [refiningCoverLetter, setRefiningCoverLetter] = useState(false);
  const [cvDownloadError, setCvDownloadError] = useState("");
  const [tailoringCv, setTailoringCv] = useState(false);
  const [showEmployerForm, setShowEmployerForm] = useState(false);
  const [employerFormOpened, setEmployerFormOpened] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>(() =>
    Object.fromEntries(app.formFields.map((f) => [f.id, f.value])),
  );
  const coverLetterField = app.formFields.find(
    (field) => field.canonicalKey === "cover_letter" || field.id === "cover",
  );
  const pendingFields = coverLetterField
    ? { ...fields, [coverLetterField.id]: coverLetter }
    : fields;
  useEffect(() => setCoverLetter(app.coverLetter), [app.coverLetter]);
  const changed =
    coverLetter !== app.coverLetter ||
    app.formFields.some((f) => pendingFields[f.id] !== f.value);
  const verified = app.outcome === "applied_waiting";
  const trackedClosed =
    app.outcome === "rejected_by_user" || app.outcome === "unsuccessful";
  const missingRequiredFields = app.formFields.filter(
    (field) => field.required && !pendingFields[field.id]?.trim(),
  );
  const formNeedsManualReview = !app.liveFormValidated;
  const canReturnToEmployer = employerFormOpened;
  const openEmployerForm = async () => {
    if (changed) {
      const result = await act(() =>
        updateApplication(app.id, { coverLetter, fields: pendingFields }),
      );
      if (!result) return;
    }
    setEmployerFormOpened(true);
    setShowEmployerForm(true);
  };
  const refine = async () => {
    const message = coverLetterMessage.trim();
    if (!message) return;
    setRefiningCoverLetter(true);
    setCoverLetterMessage("");
    try {
      await act(() => refineCoverLetter(app.id, message));
    } finally {
      setRefiningCoverLetter(false);
    }
  };
  const refineField = async (fieldId: string, instruction: string) => {
    const message = instruction.trim();
    if (!message) return;
    if (changed) {
      const saved = await act(() =>
        updateApplication(app.id, { coverLetter, fields: pendingFields }),
      );
      if (!saved) return;
    }
    const result = await act(() =>
      refineApplicationField(app.id, fieldId, message),
    );
    const updated = result?.applications.find((item) => item.id === app.id);
    if (!updated) return;
    setFields(
      Object.fromEntries(
        updated.formFields.map((field) => [field.id, field.value]),
      ),
    );
    setCoverLetter(updated.coverLetter);
  };
  const requestTailoredCv = async () => {
    setTailoringCv(true);
    try {
      await act(() => tailorApplicationCv(app.id));
    } finally {
      setTailoringCv(false);
    }
  };
  if (showEmployerForm)
    return (
      <section className="application-editor embedded-employer">
        <div className="employer-browser-toolbar">
          <button
            className="secondary"
            onClick={() => setShowEmployerForm(false)}
          >
            <ChevronLeft size={16} /> Back to RolegAIn
          </button>
          <span>
            <strong>{job.company}</strong>
            <small>{jobNumberLabel(job.jobNumber)} · {job.title} · employer application</small>
          </span>
          <span className="embedded-browser-status">
            <ShieldCheck size={15} /> Agent-prefilled browser
          </span>
        </div>
        <iframe
          className="employer-browser-frame"
          src={employerProxyUrl(job.applyUrl)}
          title={`${job.company} application form`}
        />
      </section>
    );

  return (
    <section className="application-editor">
      <div className="application-heading">
        <div>
          <div className="breadcrumbs">
            <span>{jobNumberLabel(job.jobNumber)}</span>
            <ChevronRight size={13} />
            <span>{job.company}</span>
            <ChevronRight size={13} />
            <span>Application review</span>
          </div>
          <h2>{job.title}</h2>
          <span className="application-job-number">Job {jobNumberLabel(job.jobNumber)}</span>
          <div className="job-meta">
            <span>
              <MapPin size={14} /> {job.location}
            </span>
            <span>{compactCompensation(job.compensation)}</span>
          </div>
        </div>
        <div className="application-actions">
          <a
            className="secondary"
            href={job.sourceUrl}
            target="_blank"
            rel="noreferrer"
          >
            <Globe2 size={15} /> View job <ArrowUpRight size={14} />
          </a>
          <button
            disabled={!changed || busy || verified}
            className="secondary"
            onClick={() =>
              void act(() =>
                updateApplication(app.id, {
                  coverLetter,
                  fields: pendingFields,
                }),
              )
            }
          >
            <FileCheck2 size={15} /> Save review
          </button>
          {trackedClosed ? (
            <button
              className="secondary"
              disabled={busy}
              onClick={() => void act(() => setApplicationOutcome(app.id))}
            >
              <RefreshCw size={15} /> Restore to queue
            </button>
          ) : (
            <>
              {app.outcome === "applied_waiting" ? (
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => void act(() => setApplicationOutcome(app.id))}
                >
                  <RefreshCw size={15} /> Restore to queue
                </button>
              ) : (
                <>
                  <button
                    className="secondary tracking-applied"
                    disabled={busy}
                    onClick={() =>
                      void act(() =>
                        setApplicationOutcome(app.id, "applied_waiting"),
                      )
                    }
                  >
                    <CheckCircle2 size={15} /> Mark applied · waiting
                  </button>
                  <button
                    className="secondary tracking-reject"
                    disabled={busy}
                    onClick={() =>
                      void act(() =>
                        setApplicationOutcome(app.id, "rejected_by_user"),
                      )
                    }
                  >
                    <X size={15} /> Reject by me
                  </button>
                </>
              )}
              <button
                className="secondary tracking-unsuccessful"
                disabled={busy}
                onClick={() =>
                  void act(() =>
                    setApplicationOutcome(app.id, "unsuccessful"),
                  )
                }
              >
                <AlertTriangle size={15} /> Mark unsuccessful
              </button>
            </>
          )}
        </div>
      </div>
      <div className={`readiness ${verified ? "verified" : ""}`}>
        <div>
          {verified ? <ShieldCheck size={18} /> : <CheckCircle2 size={18} />}
          <span>
            <strong>{applicationStatusTitle(app)}</strong>
            <small>
              {app.outcome === "rejected_by_user"
                ? "Manually rejected by you. Restore it if you want to reconsider."
                : app.outcome === "unsuccessful"
                  ? "Manually marked unsuccessful for application tracking."
                : app.outcome === "applied_waiting"
                    ? "Manually marked as applied and waiting for the employer's response."
                    : "Application status changes only when you mark it manually."}
            </small>
          </span>
        </div>
        <span className="status-chip">
          {verified
            ? applicationStatusLabel(app)
            : `${app.formFields.filter((f) => f.value).length}/${app.formFields.length} fields mapped`}
        </span>
      </div>
      <div className="application-intelligence">
        <section className="company-research-card">
          <div className="application-feature-heading">
            <span className="application-feature-icon">
              <Building2 size={17} />
            </span>
            <span>
              <strong>Company context</strong>
              <small>Researched automatically for this application</small>
            </span>
          </div>
          {app.companyResearch?.status === "ready" ? (
            <>
              <p>{app.companyResearch.overview}</p>
              {app.companyResearch.productsAndServices.length > 0 && (
                <div className="company-research-block">
                  <strong>What it does</strong>
                  <ul>
                    {app.companyResearch.productsAndServices.map(
                      (item, index) => (
                        <li key={`${item}-${index}`}>{item}</li>
                      ),
                    )}
                  </ul>
                </div>
              )}
              {app.companyResearch.tailoringAngles.length > 0 && (
                <div className="company-research-block">
                  <strong>Useful application angles</strong>
                  <ul>
                    {app.companyResearch.tailoringAngles.map((item, index) => (
                      <li key={`${item}-${index}`}>{item}</li>
                    ))}
                  </ul>
                </div>
              )}
              {(app.companyResearch.customersAndMarkets.length > 0 ||
                app.companyResearch.businessModel ||
                app.companyResearch.cultureAndValues.length > 0 ||
                app.companyResearch.recentSignals.length > 0) && (
                <details className="company-research-more">
                  <summary>More company details</summary>
                  {app.companyResearch.customersAndMarkets.length > 0 && (
                    <div className="company-research-block">
                      <strong>Customers and markets</strong>
                      <ul>
                        {app.companyResearch.customersAndMarkets.map(
                          (item, index) => (
                            <li key={`${item}-${index}`}>{item}</li>
                          ),
                        )}
                      </ul>
                    </div>
                  )}
                  {app.companyResearch.businessModel && (
                    <div className="company-research-block">
                      <strong>Business model</strong>
                      <p>{app.companyResearch.businessModel}</p>
                    </div>
                  )}
                  {app.companyResearch.cultureAndValues.length > 0 && (
                    <div className="company-research-block">
                      <strong>Culture and values</strong>
                      <ul>
                        {app.companyResearch.cultureAndValues.map(
                          (item, index) => (
                            <li key={`${item}-${index}`}>{item}</li>
                          ),
                        )}
                      </ul>
                    </div>
                  )}
                  {app.companyResearch.recentSignals.length > 0 && (
                    <div className="company-research-block">
                      <strong>Recent signals</strong>
                      <ul>
                        {app.companyResearch.recentSignals.map(
                          (item, index) => (
                            <li key={`${item}-${index}`}>{item}</li>
                          ),
                        )}
                      </ul>
                    </div>
                  )}
                </details>
              )}
              <div className="company-research-sources">
                {app.companyResearch.sources.map((source) => (
                  <a
                    href={source.url}
                    key={source.url}
                    rel="noreferrer"
                    target="_blank"
                    title={source.evidence}
                  >
                    {source.title} <ArrowUpRight size={12} />
                  </a>
                ))}
              </div>
            </>
          ) : app.companyResearch?.status === "failed" ? (
            <p className="application-feature-error">
              Company research was unavailable. The application remains based
              on the verified vacancy and candidate evidence.
            </p>
          ) : (
            <p>Company research will run when this application is prepared.</p>
          )}
        </section>
        <section className="tailored-cv-card">
          <div className="application-feature-heading">
            <span className="application-feature-icon">
              <FileText size={17} />
            </span>
            <span>
              <strong>Tailored CV</strong>
              <small>Generated only when you request it</small>
            </span>
          </div>
          <p>
            Reorders and rewrites your existing CV for this role without adding
            unsupported experience.
          </p>
          {app.tailoredCv?.status === "ready" && (
            <>
              {app.tailoredCv.changeSummary.length > 0 && (
                <ul className="tailored-cv-changes">
                  {app.tailoredCv.changeSummary.map((item, index) => (
                    <li key={`${item}-${index}`}>{item}</li>
                  ))}
                </ul>
              )}
              <button
                className="secondary"
                disabled={busy}
                onClick={() => {
                  setCvDownloadError("");
                  void downloadTailoredCv(
                    app.id,
                    app.tailoredCv!.fileName,
                  ).catch((cause) =>
                    setCvDownloadError(
                      cause instanceof Error ? cause.message : String(cause),
                    ),
                  );
                }}
              >
                <Download size={15} /> Download DOCX
              </button>
            </>
          )}
          {app.tailoredCv?.status === "failed" && (
            <p className="application-feature-error">
              {app.tailoredCv.error || "CV tailoring failed. You can retry it."}
            </p>
          )}
          {cvDownloadError && (
            <p className="application-feature-error">{cvDownloadError}</p>
          )}
          <button
            className="secondary tailored-cv-generate"
            disabled={
              busy ||
              verified ||
              tailoringCv ||
              app.tailoredCv?.status === "processing"
            }
            onClick={() => void requestTailoredCv()}
          >
            {tailoringCv || app.tailoredCv?.status === "processing" ? (
              <LoaderCircle className="spin" size={15} />
            ) : (
              <Sparkles size={15} />
            )}
            {tailoringCv || app.tailoredCv?.status === "processing"
              ? "Tailoring CV"
              : app.tailoredCv?.status === "ready"
                ? "Regenerate tailored CV"
                : "Generate tailored CV"}
          </button>
        </section>
      </div>
      <div className="application-section-summary">
        {coverLetterField ? (
          <button
            onClick={() =>
              document
                .getElementById(`application-field-${coverLetterField.id}`)
                ?.scrollIntoView({ behavior: "smooth", block: "start" })
            }
          >
            <FileText size={18} />
            <span>
              <strong>Cover letter</strong>
              <small>
                {coverLetter.split(/\s+/).filter(Boolean).length} words ·{" "}
                {coverLetterField.required ? "Required" : "Included"}
              </small>
            </span>
            <ChevronRight size={16} />
          </button>
        ) : (
          <span>
            <FileText size={17} /> Employer form does not request a cover letter
          </span>
        )}
      </div>
      <div className="application-columns">
        <div className="form-studio">
          <div className="panel-head">
            <div>
              <span className="section-label">Form studio</span>
              <h3>Mapped application fields</h3>
            </div>
            <span className="adapter">
              <Code2 size={14} /> {app.adapter}
            </span>
          </div>
          <details className="gap-box job-description-box">
            <summary>
              <span>
                <strong>Live job description</strong>
                <small>
                  {job.requirements.length} captured requirements · expand to
                  review
                </small>
              </span>
              <ChevronRight size={16} />
            </summary>
            <div className="job-description-content">
              <p>{job.summary}</p>
              {job.requirements.map((requirement) => (
                <p key={requirement}>{requirement}</p>
              ))}
              {job.description && (
                <details>
                  <summary>Read full captured description</summary>
                  <p className="full-job-description">{job.description}</p>
                </details>
              )}
            </div>
          </details>
          {app.formFields.map((field) => {
              const isCoverLetter =
                field.canonicalKey === "cover_letter" || field.id === "cover";
              const fieldValue = isCoverLetter
                ? coverLetter
                : fields[field.id] ?? "";
              const needsInput = field.required && !fieldValue.trim();
              const isNarrative =
                field.type === "textarea" ||
                (field.type === "text" &&
                  field.source === "generated" &&
                  fieldValue.length >= 80);

              if (isCoverLetter)
                return (
                  <div
                    id={`application-field-${field.id}`}
                    className={`form-field narrative-field cover-letter-field ${needsInput ? "needs-input" : ""}`}
                    key={field.id}
                  >
                    <div className="form-field-label">
                      <span>
                        {field.label}
                        {field.required && <b>*</b>}
                      </span>
                      {needsInput && (
                        <em className="needs-input-badge">
                          <Inbox size={11} /> Needs input
                        </em>
                      )}
                      <small>
                        {field.source} · {field.confidence}%
                      </small>
                    </div>
                    <CoverLetterFieldEditor
                      app={app}
                      busy={busy}
                      changed={changed}
                      coverLetter={coverLetter}
                      fieldId={field.id}
                      message={coverLetterMessage}
                      refining={refiningCoverLetter}
                      verified={verified}
                      onChange={setCoverLetter}
                      onMessageChange={setCoverLetterMessage}
                      onRefine={refine}
                    />
                  </div>
                );

              return (
              <div
                className={`form-field ${isNarrative ? "narrative-field" : ""} ${needsInput ? "needs-input" : ""}`}
                key={field.id}
              >
                <div className="form-field-label">
                  <span>
                    {field.label}
                    {field.required && <b>*</b>}
                  </span>
                  {needsInput && (
                    <em className="needs-input-badge">
                      <Inbox size={11} /> Needs input
                    </em>
                  )}
                  <small>
                    {field.source} · {field.confidence}%
                  </small>
                </div>
                <div className="form-control-stack">
                {isNarrative ? (
                  <>
                    <textarea
                      aria-label={field.label}
                      className="narrative-editor"
                      data-application-field={field.id}
                      disabled={verified}
                      rows={5}
                      value={fields[field.id]}
                      onChange={(e) =>
                        setFields({ ...fields, [field.id]: e.target.value })
                      }
                    />
                    <ApplicationAnswerAdjuster
                      busy={busy}
                      disabled={verified}
                      label={field.label}
                      onRefine={(instruction) =>
                        refineField(field.id, instruction)
                      }
                    />
                  </>
                ) : field.type === "file" ? (
                  <div className="file-value">
                    <Paperclip size={15} />
                    <span>{fields[field.id]}</span>
                    <button type="button" disabled={verified}>
                      Replace
                    </button>
                  </div>
                ) : field.type === "select" ? (
                  <select
                    aria-label={field.label}
                    data-application-field={field.id}
                    disabled={verified}
                    value={fields[field.id]}
                    onChange={(e) =>
                      setFields({ ...fields, [field.id]: e.target.value })
                    }
                  >
                    <option value="">Select an answer</option>
                    {(field.options || []).map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                ) : field.type === "checkbox" ? (
                  <input
                    aria-label={field.label}
                    data-application-field={field.id}
                    type="checkbox"
                    disabled={verified}
                    checked={fields[field.id] === "Yes"}
                    onChange={(e) =>
                      setFields({
                        ...fields,
                        [field.id]: e.target.checked ? "Yes" : "",
                      })
                    }
                  />
                ) : (
                  <input
                    aria-label={field.label}
                    data-application-field={field.id}
                    type={field.type === "date" ? "date" : field.type}
                    disabled={verified}
                    value={fields[field.id]}
                    onChange={(e) =>
                      setFields({ ...fields, [field.id]: e.target.value })
                    }
                  />
                )}
                {needsInput && (
                  <span className="field-warning">
                    Required before this application is ready.
                  </span>
                )}
                {field.evidence && (
                  <span className="field-evidence">
                    <strong>Evidence:</strong> {field.evidence}
                  </span>
                )}
                </div>
              </div>
              );
            })}
        </div>
        <div className="application-review-footer">
          <div className="gap-box">
            <strong>Evidence gaps kept visible</strong>
            {job.gaps.map((gap) => (
              <p key={gap}>
                <CircleHelp size={14} /> {gap}
              </p>
            ))}
          </div>
          <div
            className={`send-boundary ${missingRequiredFields.length || formNeedsManualReview ? "incomplete" : ""}`}
          >
            <div>
              {missingRequiredFields.length || formNeedsManualReview ? (
                <AlertTriangle size={19} />
              ) : (
                <ShieldCheck size={19} />
              )}
              <span>
                <strong>
                  {formNeedsManualReview
                    ? "Employer form needs manual review"
                    : missingRequiredFields.length
                    ? `${missingRequiredFields.length} ${missingRequiredFields.length === 1 ? "field will" : "fields will"} remain blank`
                    : "Ready for employer review"}
                </strong>
                <small>
                  {formNeedsManualReview
                    ? "The vacancy is verified, but this form could not be mapped automatically. Open it here and complete protected, sign-in, CAPTCHA, or unsupported controls manually."
                    : missingRequiredFields.length
                    ? `The employer form will still open. Complete ${missingRequiredFields.map((field) => field.label).join(", ")} there if the employer requires it.`
                    : changed
                      ? "Your latest edits will be saved automatically before the employer form opens."
                      : "The embedded application browser prefills the employer form. After submitting there, mark the application as applied manually."}
                </small>
              </span>
            </div>
            <button
              data-testid={`send-${app.id}`}
              disabled={busy}
              className="send"
              onClick={() => void openEmployerForm()}
            >
              {canReturnToEmployer ? (
                <ArrowUpRight size={16} />
              ) : (
                <Send size={16} />
              )}{" "}
              {canReturnToEmployer
                  ? "Return to employer form"
                  : "Open employer form"}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function CoverLetterFieldEditor({
  app,
  busy,
  changed,
  coverLetter,
  fieldId,
  message,
  refining,
  verified,
  onChange,
  onMessageChange,
  onRefine,
}: {
  app: ApplicationDraft;
  busy: boolean;
  changed: boolean;
  coverLetter: string;
  fieldId: string;
  message: string;
  refining: boolean;
  verified: boolean;
  onChange: (value: string) => void;
  onMessageChange: (value: string) => void;
  onRefine: () => Promise<void>;
}) {
  return (
    <div className="form-control-stack">
      <div className="long-form-meta">
        <span>{coverLetter.split(/\s+/).filter(Boolean).length} words</span>
      </div>
      <textarea
        aria-label="Cover Letter"
        className="cover-editor"
        data-application-field={fieldId}
        disabled={verified || refining}
        rows={26}
        value={coverLetter}
        onChange={(event) => onChange(event.target.value)}
      />
      <div className="cover-letter-chat">
        <div className="cover-chat-heading">
          <span className="cover-chat-icon">
            <Sparkles size={15} />
          </span>
          <span>
            <strong>Adjust with AI</strong>
            <small>
              Ask for a different tone, length, emphasis, or closer requirement
              mapping. Candidate evidence remains the factual boundary.
            </small>
          </span>
        </div>
        {app.coverLetterChat.length > 0 && (
          <div className="cover-chat-messages" aria-live="polite">
            {app.coverLetterChat.map((chatMessage) => (
              <div
                className={`cover-chat-message ${chatMessage.role}`}
                key={chatMessage.id}
              >
                <strong>{chatMessage.role === "user" ? "You" : "AI"}</strong>
                <span>{chatMessage.content}</span>
              </div>
            ))}
          </div>
        )}
        <div className="cover-chat-input">
          <textarea
            aria-label="Cover letter adjustment"
            disabled={verified || refining || busy}
            value={message}
            placeholder="For example: Make it more formal and map the three most important requirements directly to my experience."
            onChange={(event) => onMessageChange(event.target.value)}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter")
                void onRefine();
            }}
          />
          <button
            className="secondary"
            disabled={verified || refining || busy || changed || !message.trim()}
            onClick={() => void onRefine()}
          >
            {refining ? (
              <LoaderCircle className="spin" size={15} />
            ) : (
              <Sparkles size={15} />
            )}
            Adjust cover letter
          </button>
        </div>
        {changed && (
          <span className="cover-chat-warning">
            Save your manual edits and form changes before asking AI to revise
            the letter.
          </span>
        )}
      </div>
    </div>
  );
}

function ApplicationAnswerAdjuster({
  busy,
  disabled,
  label,
  onRefine,
}: {
  busy: boolean;
  disabled: boolean;
  label: string;
  onRefine: (instruction: string) => Promise<void>;
}) {
  const [instruction, setInstruction] = useState("");
  const [refining, setRefining] = useState(false);
  const submit = async () => {
    if (!instruction.trim()) return;
    setRefining(true);
    try {
      await onRefine(instruction);
      setInstruction("");
    } finally {
      setRefining(false);
    }
  };
  return (
    <div className="field-ai-adjuster">
      <div className="field-ai-heading">
        <span className="cover-chat-icon">
          <Sparkles size={15} />
        </span>
        <span>
          <strong>Adjust with AI</strong>
          <small>
            Revise this answer using only the candidate evidence attached to the
            application.
          </small>
        </span>
      </div>
      <div className="field-ai-input">
        <textarea
          aria-label={`Adjust ${label} with AI`}
          disabled={disabled || refining || busy}
          value={instruction}
          placeholder="For example: Make this more concise and emphasize the most relevant experience."
          onChange={(event) => setInstruction(event.target.value)}
        />
        <button
          className="secondary"
          disabled={disabled || refining || busy || !instruction.trim()}
          onClick={() => void submit()}
        >
          {refining ? (
            <LoaderCircle className="spin" size={15} />
          ) : (
            <Sparkles size={15} />
          )}
          Adjust answer
        </button>
      </div>
    </div>
  );
}

function employerProxyUrl(applyUrl: string) {
  const employer = new URL(applyUrl);
  const port = window.location.port ? `:${window.location.port}` : "";
  return `${window.location.protocol}//${employer.hostname}.localhost${port}${employer.pathname}${employer.search}${employer.hash}`;
}

function AddApplicationForm({
  busy,
  onCancel,
  onAdd,
}: {
  busy: boolean;
  onCancel: () => void;
  onAdd: (value: { company: string; title: string; applyUrl: string }) => void;
}) {
  const [value, setValue] = useState({ company: "", title: "", applyUrl: "" });
  return (
    <section className="band add-application">
      <div className="section-head">
        <div>
          <span className="section-label">New opportunity</span>
          <h2>Add application</h2>
        </div>
        <button className="icon-btn" onClick={onCancel}>
          <X size={15} />
        </button>
      </div>
      <div className="add-grid">
        <label>
          Company
          <input
            data-testid="new-company"
            value={value.company}
            onChange={(e) => setValue({ ...value, company: e.target.value })}
          />
        </label>
        <label>
          Position title
          <input
            data-testid="new-title"
            value={value.title}
            onChange={(e) => setValue({ ...value, title: e.target.value })}
          />
        </label>
        <label>
          Application URL
          <input
            data-testid="new-url"
            value={value.applyUrl}
            onChange={(e) => setValue({ ...value, applyUrl: e.target.value })}
          />
        </label>
        <button
          data-testid="save-application"
          className="primary"
          disabled={busy || !value.company || !value.title || !value.applyUrl}
          onClick={() => onAdd(value)}
        >
          <Plus size={15} /> Prepare application
        </button>
      </div>
    </section>
  );
}

function NavButton({
  icon: Icon,
  label,
  active,
  badge,
  onClick,
}: {
  icon: typeof UserRound;
  label: string;
  active: boolean;
  badge?: string;
  onClick: () => void;
}) {
  return (
    <button className={`nav-btn ${active ? "active" : ""}`} onClick={onClick}>
      <Icon size={17} />
      <span>{label}</span>
      {badge && <small>{badge}</small>}
    </button>
  );
}
function Empty({
  icon: Icon,
  title,
  action,
  onAction,
  disabled = false,
}: {
  icon: typeof Search;
  title: string;
  action: string;
  onAction: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="empty">
      <Icon size={30} />
      <h2>{title}</h2>
      <button className="primary" onClick={onAction} disabled={disabled}>
        {action}
      </button>
    </div>
  );
}
function phaseLabel(phase: string) {
  return (
    {
      intake: "Candidate intelligence",
      search: "Opportunity research",
      applications: "Application control center",
    }[phase] ?? phase
  );
}
function title(view: View) {
  return {
    profile: "Candidate profile",
    discovery: "Discovery",
    applications: "Applications",
  }[view];
}
function statusLabel(status: ApplicationDraft["status"]) {
  return {
    needs_input: "Needs input",
    ready_to_send: "Ready to send",
  }[status];
}
function applicationStatusLabel(application: ApplicationDraft) {
  if (application.outcome === "rejected_by_user") return "Rejected by user";
  if (application.outcome === "unsuccessful") return "Unsuccessful";
  if (application.outcome === "applied_waiting") return "Applied · waiting";
  return statusLabel(application.status);
}
function statusTitle(status: ApplicationDraft["status"]) {
  return {
    needs_input: "Missing required information",
    ready_to_send: "Ready for final review",
  }[status];
}
function applicationStatusTitle(application: ApplicationDraft) {
  if (application.outcome === "rejected_by_user") return "Rejected by you";
  if (application.outcome === "unsuccessful") return "Application unsuccessful";
  if (application.outcome === "applied_waiting") return "Applied · waiting";
  return statusTitle(application.status);
}
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(reader.error ?? new Error("Could not read the file"));
    reader.onload = () =>
      resolve(String(reader.result).split(",").at(-1) || "");
    reader.readAsDataURL(file);
  });
}

const ACCEPTED_CV_EXTENSIONS = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".txt",
  ".md",
  ".markdown",
  ".rtf",
  ".html",
  ".htm",
]);
const MAX_CV_FILE_BYTES = 15 * 1024 * 1024;

function validateCvFile(file: File) {
  const extension = file.name.includes(".")
    ? `.${file.name.split(".").at(-1)!.toLowerCase()}`
    : "";
  if (!ACCEPTED_CV_EXTENSIONS.has(extension))
    throw new Error(
      "CV could not be opened: use PDF, DOC, DOCX, TXT, Markdown, RTF, or HTML.",
    );
  if (file.size === 0)
    throw new Error("CV could not be opened: the selected file is empty.");
  if (file.size > MAX_CV_FILE_BYTES)
    throw new Error("CV could not be opened: files larger than 15 MB are not supported.");
}

function parseSourceUrl(value: string): URL | undefined {
  const candidate = /^https?:\/\//i.test(value)
    ? value
    : /^(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:[/?#].*)?$/i.test(value)
      ? `https://${value}`
      : "";
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}
