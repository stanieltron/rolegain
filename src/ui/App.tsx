import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  Award,
  BellRing,
  BriefcaseBusiness,
  Building2,
  Check,
  CheckCircle2,
  ChevronDown,
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
  LogOut,
  MapPin,
  Paperclip,
  Pencil,
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
import {
  addOpportunity,
  addSource,
  analyzeCandidate,
  answerQuestion,
  continueBackgroundWork,
  createEmployerProxySession,
  downloadTailoredCv,
  finishIntake,
  findMoreApplications,
  getBetaStatus,
  getCanonicalEvidence,
  getServiceStatus,
  getWorkspace,
  enableReleaseUpdates,
  exploreProfileEvidence,
  prepareApplications,
  prepareSearchReadyApplications,
  promoteOpportunity,
  removeSource,
  resetUser,
  refineApplicationField,
  refineCoverLetter,
  reviewEvidenceClaim,
  reviewEvidenceContradiction,
  setApplicationOutcome,
  stopBackgroundWork,
  streamWorkflowProgress,
  tailorApplicationCv,
  trackAnalyticsEvent,
  updateApplication,
  updateCandidateProfile,
  updateSearchConfig,
} from "./api.js";
import { useAuthActions } from "./auth.js";
import {
  applicationOutcomeState,
  coalescePipelineItems,
  deriveCurrentRunItemIds,
  isApplicationAttempt,
  isLowMatchPipelineItem,
  isManualReviewPipelineItem,
  pipelineDisplayStage,
  pipelineItemVisible,
  settlePipelineItemForDisplay,
  sortPipelineRows,
} from "./pipeline-items.js";
import type {
  BetaStatus,
  CanonicalEvidenceModel,
  ServiceStatus,
  WorkflowProgressEvent,
} from "./api.js";

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

function isEvidenceChunkLimitError(value?: string) {
  return Boolean(
    value?.includes("the run reached its configured limit") ||
      (value?.includes("Evidence analysis needs") &&
        value.includes("exceeding the configured maximum")),
  );
}

function cumulativePipelineItems(workspace: JobSearchWorkspace) {
  return coalescePipelineItems([
    ...workspace.jobHistory,
    ...(workspace.searchProgress?.items ?? []),
  ]);
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

function applicationReadinessCounts(applications: ApplicationDraft[]) {
  return {
    ready: applications.filter(
      (application) => application.status === "ready_to_send" && !application.outcome,
    ).length,
    needsInput: applications.filter(
      (application) => application.status === "needs_input" && !application.outcome,
    ).length,
  };
}

function marketplaceSourceGroups(
  items: JobSearchWorkspace["jobHistory"],
  currentItemIds: ReadonlySet<string>,
) {
  const groups = new Map<
    string,
    {
      source: NonNullable<JobSearchWorkspace["jobHistory"][number]["sourceGroup"]>;
      items: JobSearchWorkspace["jobHistory"];
      current: boolean;
    }
  >();
  for (const item of items) {
    if (!item.sourceGroup) continue;
    const existing = groups.get(item.sourceGroup.id) ?? {
      source: item.sourceGroup,
      items: [],
      current: false,
    };
    existing.items.push(item);
    existing.current ||= currentItemIds.has(item.id);
    groups.set(item.sourceGroup.id, existing);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      items: [...group.items].sort(
        (left, right) =>
          (left.jobNumber ?? Number.MAX_SAFE_INTEGER) -
          (right.jobNumber ?? Number.MAX_SAFE_INTEGER),
      ),
    }))
    .sort((left, right) => {
      if (left.current !== right.current) return left.current ? -1 : 1;
      return (
        (left.items[0]?.jobNumber ?? Number.MAX_SAFE_INTEGER) -
        (right.items[0]?.jobNumber ?? Number.MAX_SAFE_INTEGER)
      );
    });
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

type PreferenceSaveState = "idle" | "saving" | "saved" | "error";

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
  const authActions = useAuthActions();
  const [workspace, setWorkspace] = useState<JobSearchWorkspace>();
  const [beta, setBeta] = useState<BetaStatus>();
  const [serviceStatus, setServiceStatus] = useState<ServiceStatus>();
  const [liveProgressEvents, setLiveProgressEvents] = useState<WorkflowProgressEvent[]>([]);
  const [view, setView] = useState<View>("profile");
  const [selectedId, setSelectedId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [preferenceSaveState, setPreferenceSaveState] =
    useState<PreferenceSaveState>("idle");
  const preferenceSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const pendingPreferenceSaves = useRef(0);
  const preferenceSaveFailed = useRef(false);
  const latestPreferenceAnswers = useRef(new Map<string, string>());
  const preferenceSavedTimer = useRef<number | undefined>(undefined);
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

  useEffect(
    () => () => {
      if (preferenceSavedTimer.current)
        window.clearTimeout(preferenceSavedTimer.current);
    },
    [],
  );

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
    void Promise.all([getWorkspace(), getBetaStatus(), getServiceStatus()])
      .then(([w, betaStatus, currentServiceStatus]) => {
        setWorkspace(w);
        setBeta(betaStatus);
        setServiceStatus(currentServiceStatus);
        if (preparedVerifiedApplications(w).length > 0)
          setView("applications");
        else if (candidateDiscoveryReady(w) && w.phase !== "intake")
          setView("discovery");
      })
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : String(cause))
      );
  }, []);
  useEffect(() => {
    const timer = window.setInterval(
      () =>
        void getServiceStatus()
          .then(setServiceStatus)
          .catch(() => undefined),
      10_000,
    );
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    void trackAnalyticsEvent(
      view === "profile"
        ? "view_profile"
        : view === "discovery"
          ? "view_discovery"
          : "view_applications",
    );
  }, [view]);
  const executionStopped =
    workspace?.backgroundExecution?.state === "stopped";
  const analysisClaimsWork =
    workspace?.intelligence.status === "analyzing" ||
    (workspace?.sources.some((source) => source.status === "processing") ??
      false);
  const searchClaimsWork =
    workspace?.searchProgress?.stage === "looking" ||
    workspace?.searchProgress?.stage === "verifying" ||
    workspace?.searchProgress?.stage === "filling";
  const failedSearchWork =
    workspace?.workflowExecution?.status === "failed" &&
    (workspace.workflowExecution.type === "prepare" ||
      workspace.workflowExecution.type === "prepare-search-ready" ||
      workspace.workflowExecution.type === "find-more") &&
    workspace.searchProgress?.stage === "failed";
  const resumableSavedWork =
    analysisClaimsWork || searchClaimsWork || failedSearchWork;
  const workflowQueueManaged = Boolean(workspace?.workflowExecution);
  const workflowActive =
    (workspace?.workflowExecution?.status === "queued" ||
      workspace?.workflowExecution?.status === "running") &&
    !workspace?.workflowExecution?.cancellationRequestedAt;
  const interruptedWork =
    !executionStopped &&
    workflowQueueManaged &&
    resumableSavedWork &&
    !workflowActive;
  const hasPausedWork =
    (executionStopped &&
      Boolean(
        workspace?.backgroundExecution?.resumeCandidateAnalysis ||
          workspace?.backgroundExecution?.resumeProfileSourceSync ||
          workspace?.backgroundExecution?.resumeSearch,
      )) ||
    interruptedWork;
  const monitoring =
    !executionStopped &&
    (workflowQueueManaged
      ? workflowActive
      : resumableSavedWork ||
        (workspace?.applications.some(
          (application) => application.tailoredCv?.status === "processing",
        ) ??
          false));
  useEffect(() => {
    if (!monitoring) return;
    const controller = new AbortController();
    setLiveProgressEvents([]);
    void streamWorkflowProgress((event) => {
      setLiveProgressEvents((current) => [...current, event].slice(-30));
    }, controller.signal);
    return () => controller.abort();
  }, [monitoring, workspace?.workflowExecution?.id]);
  useEffect(() => {
    if (!monitoring) return;
    const timer = window.setInterval(
      () =>
        void Promise.all([getWorkspace(), getBetaStatus()]).then(
          ([nextWorkspace, betaStatus]) => {
            setWorkspace(nextWorkspace);
            setBeta(betaStatus);
          },
        ),
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
      void getBetaStatus().then(setBeta).catch(() => undefined);
      void getServiceStatus().then(setServiceStatus).catch(() => undefined);
      if (next) setView(next);
      return value;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const saveSearchSettings = (
    patch: Partial<
      Pick<
        JobSearchWorkspace["searchConfig"],
        "minimumMatchScore" | "developerMode"
      >
    >,
  ) => {
    if (!workspace) return;
    void act(() =>
      updateSearchConfig({
        discoveryTarget: workspace.searchConfig.discoveryTarget,
        applicationTarget: workspace.searchConfig.applicationTarget,
        minimumMatchScore:
          patch.minimumMatchScore ??
          workspace.searchConfig.minimumMatchScore ??
          35,
        developerMode:
          patch.developerMode ?? workspace.searchConfig.developerMode ?? false,
      }),
    );
  };

  const savePreference = (questionId: string, answer: string) => {
    if (latestPreferenceAnswers.current.get(questionId) === answer) return;
    latestPreferenceAnswers.current.set(questionId, answer);
    if (pendingPreferenceSaves.current === 0)
      preferenceSaveFailed.current = false;
    pendingPreferenceSaves.current += 1;
    if (preferenceSavedTimer.current)
      window.clearTimeout(preferenceSavedTimer.current);
    setPreferenceSaveState("saving");

    const save = preferenceSaveQueue.current.then(async () => {
      try {
        const value = await answerQuestion(questionId, answer);
        setWorkspace(value);
        if (latestPreferenceAnswers.current.get(questionId) === answer)
          latestPreferenceAnswers.current.delete(questionId);
      } catch (cause) {
        preferenceSaveFailed.current = true;
        if (latestPreferenceAnswers.current.get(questionId) === answer)
          latestPreferenceAnswers.current.delete(questionId);
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        pendingPreferenceSaves.current -= 1;
        if (pendingPreferenceSaves.current === 0) {
          if (preferenceSaveFailed.current) setPreferenceSaveState("error");
          else {
            setPreferenceSaveState("saved");
            preferenceSavedTimer.current = window.setTimeout(
              () => setPreferenceSaveState("idle"),
              1_600,
            );
          }
        }
      }
    });
    preferenceSaveQueue.current = save.catch(() => undefined);
  };

  if (!workspace || !beta || !serviceStatus)
    return (
      <div className="boot">
        {error ? <CircleHelp /> : <LoaderCircle className="spin" />}
        <span>{error || "Opening job-search workspace"}</span>
      </div>
    );
  if (!serviceStatus.codexEnabled)
    return (
      <MaintenanceMode
        message={serviceStatus.maintenanceMessage}
        onRetry={() =>
          void getServiceStatus().then(setServiceStatus).catch(() => undefined)
        }
      />
    );
  const readyCount = workspace.applications.filter(
    (a) => a.status === "ready_to_send" && !a.outcome,
  ).length;
  const appliedCount = workspace.applications.filter(
    (a) => a.outcome === "applied_waiting",
  ).length;
  const discoveryReady = candidateDiscoveryReady(workspace);
  const preparedApplications = preparedVerifiedApplications(workspace);
  const applicationsReady =
    discoveryReady &&
    (workspace.phase === "applications" || preparedApplications.length > 0);
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
        <NavButton
          icon={Search}
          label="Discovery"
          active={view === "discovery"}
          badge={discoveryReady ? String(workspace.searchProgress?.items?.length ?? 0) : "Locked"}
          disabled={!discoveryReady}
          lockedReason="Complete your profile and evidence to unlock Discovery"
          onClick={() => setView("discovery")}
        />
        <NavButton
          icon={BriefcaseBusiness}
          label="Applications"
          active={view === "applications"}
          badge={applicationsReady ? String(preparedApplications.length) : "Locked"}
          disabled={!applicationsReady}
          lockedReason={
            discoveryReady
              ? "Prepare an application in Discovery to unlock Applications"
              : "Complete your profile and evidence to unlock Applications"
          }
          onClick={() => {
            setSelectedId(undefined);
            setView("applications");
          }}
        />
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
              <section className="settings-section" aria-label="Pipeline settings">
                <label className="settings-toggle">
                  <span>
                    <strong>Developer mode</strong>
                    <small>Show failed jobs, benches, and diagnostic event history.</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={workspace.searchConfig.developerMode ?? false}
                    disabled={busy}
                    onChange={(event) =>
                      saveSearchSettings({ developerMode: event.target.checked })
                    }
                  />
                </label>
                <label className="settings-threshold">
                  <span>
                    <strong>Minimum match for applications</strong>
                    <small>Lower-ranked jobs remain available for manual promotion.</small>
                  </span>
                  <select
                    aria-label="Minimum match for applications"
                    value={workspace.searchConfig.minimumMatchScore ?? 35}
                    disabled={busy}
                    onChange={(event) =>
                      saveSearchSettings({
                        minimumMatchScore: Number(event.target.value),
                      })
                    }
                  >
                    {Array.from({ length: 21 }, (_, index) => index * 5).map(
                      (score) => (
                        <option value={score} key={score}>{score}%</option>
                      ),
                    )}
                  </select>
                </label>
              </section>
              <button
                className="reset-user-action"
                type="button"
                role="menuitem"
                disabled={busy}
                title={
                  beta.remainingApplications <= 0
                    ? "Resetting deletes user data but does not renew the beta allowance."
                    : undefined
                }
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
              {authActions && (
                <button
                  className="settings-sign-out-action"
                  type="button"
                  role="menuitem"
                  onClick={() => authActions.signOut()}
                >
                  <LogOut size={15} />
                  Sign out
                </button>
              )}
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
            {(monitoring || hasPausedWork) && (
              <div
                className={`execution-controls ${hasPausedWork ? "stopped" : ""}`}
                aria-label="Background execution controls"
              >
                {monitoring && (
                  <button
                    type="button"
                    className="stop-execution"
                    disabled={busy}
                    onClick={() => void act(stopBackgroundWork)}
                  >
                    <Square size={12} fill="currentColor" /> Stop
                  </button>
                )}
                {hasPausedWork && (
                  <button
                    type="button"
                    className="continue-execution"
                    disabled={busy}
                    onClick={() => void act(continueBackgroundWork)}
                  >
                    <Play size={13} fill="currentColor" /> Continue
                  </button>
                )}
              </div>
            )}
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
            <BetaLimitCard beta={beta} onEnabled={setBeta} />
          )}
          {view === "profile" && (
            <ProfileView
              workspace={workspace}
              busy={busy}
              act={act}
              preferenceSaveState={preferenceSaveState}
              savePreference={savePreference}
            />
          )}
          {view === "discovery" && (
            <DiscoveryView
              workspace={workspace}
              beta={beta}
              onBetaChange={setBeta}
              busy={busy}
              act={act}
              liveEvents={liveProgressEvents}
              onContinue={() => {
                setSelectedId(undefined);
                setView("applications");
              }}
              onOpenApplication={(applicationId) => {
                setSelectedId(applicationId);
                setView("applications");
                window.requestAnimationFrame(() =>
                  window.scrollTo({ top: 0, behavior: "smooth" }),
                );
              }}
            />
          )}
          {view === "applications" && (
            <ApplicationsView
              workspace={workspace}
              beta={beta}
              onBetaChange={setBeta}
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

function MaintenanceMode({
  message,
  onRetry,
}: {
  message?: string;
  onRetry: () => void;
}) {
  return (
    <main className="maintenance-shell">
      <section className="maintenance-card">
        <span className="maintenance-icon">
          <Settings size={24} />
        </span>
        <span className="section-label">Closed beta maintenance</span>
        <h1>Rolegain is temporarily paused</h1>
        <p>
          {message ||
            "Your profile and prepared applications remain safe. Please try again shortly."}
        </p>
        <button className="primary" type="button" onClick={onRetry}>
          <RefreshCw size={15} /> Check again
        </button>
      </section>
    </main>
  );
}

function BetaLimitCard({
  beta,
  onEnabled,
}: {
  beta: BetaStatus;
  onEnabled: (next: BetaStatus) => void;
}) {
  if (beta.canStartBatch) return null;
  return (
    <section className="beta-limit-card" role="status">
      <span className="beta-limit-icon">
        <Sparkles size={20} />
      </span>
      <div>
        <span className="section-label">Closed beta allowance complete</span>
        <h2>You have completed your two application batches</h2>
        <p>
          This beta includes up to ten prepared applications. Your profile and
          existing applications remain available while we prepare the next
          release.
        </p>
      </div>
      <button
        className={beta.releaseUpdates ? "secondary" : "primary"}
        type="button"
        disabled={beta.releaseUpdates}
        onClick={() => void enableReleaseUpdates().then(onEnabled)}
      >
        <BellRing size={15} />
        {beta.releaseUpdates ? "Release updates enabled" : "Keep me informed"}
      </button>
    </section>
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
          title: "Building your candidate knowledge base",
          detail:
            "We read every source in full, extract and cross-check claims, resolve duplicates and contradictions, then build reusable knowledge for search, matching, cover letters, answers and tailored CVs.",
        }
      : activity === "application-preparation"
        ? {
            title: "Matching, ranking and preparing selected applications",
            detail:
              "Jobs stay in Match & rank while we prevalidate the application route and compare requirements with your evidence. Only the selected ranked jobs proceed to full form inspection, grounded drafting and verification.",
          }
        : {
            title: "Running a verified job search",
            detail:
              "We search across the public web, reopen each vacancy to confirm it is live, filter constraints, and match requirements against your candidate knowledge rather than relying on titles or keywords.",
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
            {copy.detail} This is intentionally more thorough than a simple CV
            read, keyword search or generic autofill, so it can take several
            minutes. You can switch to something else while it runs. Enable
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

function ProfileView({
  workspace,
  busy,
  act,
  preferenceSaveState,
  savePreference,
}: ViewProps & {
  preferenceSaveState: PreferenceSaveState;
  savePreference: (questionId: string, answer: string) => void;
}) {
  const [evidence, setEvidence] = useState("");
  const [includeGitHubContributions, setIncludeGitHubContributions] =
    useState(false);
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
  const parsedEvidenceUrl = parseSourceUrl(evidence.trim());
  const githubRepository = isGitHubRepositoryUrl(parsedEvidenceUrl);
  const githubContributor = githubProfileUsername(evidenceLinks.github);
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
  const hasStagedEvidence = stagedEvidence.length > 0;
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
  const wasAnalyzing = useRef(analyzing);

  useEffect(() => {
    const started = analyzing && !wasAnalyzing.current;
    wasAnalyzing.current = analyzing;
    if (!started) return;
    window.requestAnimationFrame(() =>
      document.getElementById("profile-analysis-status")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      }),
    );
  }, [analyzing]);

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
    const repository = isGitHubRepositoryUrl(parsed);
    const source: Parameters<typeof addSource>[0] = parsed
      ? {
          kind: repository ? "repository" : "webpage",
          name: repository
            ? parsed.pathname.split("/").filter(Boolean).slice(0, 2).join("/")
            : parsed.hostname,
          url: parsed.href,
          includeGitHubContributions:
            repository && includeGitHubContributions,
        }
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
    setIncludeGitHubContributions(false);
  };

  const stageEvidenceFiles = async (
    files: FileList | null,
    labelPrefix = "",
  ) => {
    if (!files?.length) return;
    const additions = await Promise.all(
      [...files].map(async (file) => ({
        id: crypto.randomUUID(),
        label: labelPrefix ? `${labelPrefix} · ${file.name}` : file.name,
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

  const saveEvidenceLinkDrafts = () =>
    updateCandidateProfile({
      name: workspace.profile.name,
      email: workspace.profile.email,
      phone: workspace.profile.phone,
      linkedin: evidenceLinks.linkedin,
      github: evidenceLinks.github,
      website: evidenceLinks.website,
      workAuthorization: workspace.profile.workAuthorization,
      deferEvidenceAnalysis: true,
    });

  const exploreEvidenceLink = (field: "github" | "website") =>
    void act(
      async () => {
        await saveEvidenceLinkDrafts();
        return exploreProfileEvidence(field);
      },
      undefined,
      "candidate-analysis",
    );

  const saveLinkedInLink = () => {
    if (evidenceLinks.linkedin === workspace.profile.linkedin) return;
    void act(() =>
      updateCandidateProfile({
        name: workspace.profile.name,
        email: workspace.profile.email,
        phone: workspace.profile.phone,
        linkedin: evidenceLinks.linkedin,
        github: workspace.profile.github,
        website: workspace.profile.website,
        workAuthorization: workspace.profile.workAuthorization,
        deferEvidenceAnalysis: true,
      }),
    );
  };

  const refreshCanonicalEvidence = async () => {
    setCanonicalEvidence(await getCanonicalEvidence(workspace.candidateId));
  };

  const reviewClaim = async (
    claimId: string,
    decision: "candidate_confirmed" | "keep_weak" | "remove",
  ) => {
    const result = await act(() => reviewEvidenceClaim(claimId, decision));
    if (result) await refreshCanonicalEvidence();
  };

  const reviewContradiction = async (
    contradictionId: string,
    decision: "use_value" | "both_valid" | "keep_unresolved",
    selectedValue?: string,
  ) => {
    const result = await act(() =>
      reviewEvidenceContradiction(
        contradictionId,
        decision,
        selectedValue,
      ),
    );
    if (result) await refreshCanonicalEvidence();
  };

  return (
    <div className="profile-wizard">
      {analyzing && (
        <ProfileAnalysisStatus
          workspace={workspace}
          sourceStarting={sourceStarting}
          pendingSourceName={pendingSourceName}
        />
      )}
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
                ) : cvSource.status === "analysis_failed" ||
                  cvSource.status === "needs_review" ? (
                  <AlertTriangle size={18} />
                ) : (
                  <CheckCircle2 size={18} />
                )}
              </span>
              <div className="cv-source-copy">
                <strong>
                  {cvAnalyzing
                    ? "Reading CV evidence"
                    : cvSource.status === "analysis_failed" ||
                        cvSource.status === "needs_review"
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
              <div className="cv-source-actions">
                {cvSource.status === "analysis_failed" ||
                isEvidenceChunkLimitError(cvSource.error) ? (
                  <button
                    className="cv-update"
                    disabled={busy || analyzing}
                    type="button"
                    onClick={() =>
                      void act(
                        () => analyzeCandidate(),
                        undefined,
                        "candidate-analysis",
                      )
                    }
                  >
                    <RefreshCw size={14} /> Retry analysis
                  </button>
                ) : null}
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
      </section>

      {!analyzing && highestStep >= 2 && (
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
              onExploreEvidence={exploreEvidenceLink}
              onSaveLinkedIn={saveLinkedInLink}
            />
            <div className="experience-input">
              <label htmlFor="experience-evidence">
                Anything else that shows your experience?
              </label>
              <span>
                Add a certificate, publication, repository, relevant webpage,
                or a short description of an achievement.
              </span>
              <p className="experience-evidence-guidance">
                Everything you add may be considered when describing your
                experience. For coauthored papers, shared repositories, or team
                projects, state exactly what you contributed—do not rely on the
                source to imply ownership of the whole work. You can remove a
                source later through <strong>Edit evidence</strong>.
              </p>
              <textarea
                id="experience-evidence"
                disabled={analyzing}
                value={evidence}
                onChange={(event) => setEvidence(event.target.value)}
                placeholder="Paste a link or describe your exact contribution, certificate, project, publication, or achievement..."
              />
              {githubRepository && (
                <label className="github-contributions-option">
                  <input
                    type="checkbox"
                    checked={includeGitHubContributions}
                    disabled={!githubContributor || analyzing}
                    onChange={(event) =>
                      setIncludeGitHubContributions(event.target.checked)
                    }
                  />
                  <span>
                    <strong>Find my contributions in other public repositories</strong>
                    <small>
                      {githubContributor
                        ? `Search public commits attributed by GitHub to @${githubContributor}. Private, squashed, and older contributions may be missing.`
                        : "Add your GitHub profile above to identify which contributions are yours."}
                    </small>
                  </span>
                </label>
              )}
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
                <label className={`secondary file-action certificate-action ${busy || analyzing ? "disabled" : ""}`}>
                  <Award size={15} /> Add certificate
                  <input
                    type="file"
                    multiple
                    disabled={busy || analyzing}
                    accept=".pdf,.doc,.docx,.txt,.md,.markdown,.rtf,.html,.htm"
                    onChange={(event) => {
                      void stageEvidenceFiles(event.target.files, "Certificate");
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
          {highestStep >= 3 && (
            <>
              <PreferencesSection
                workspace={workspace}
                unanswered={unanswered}
                busy={busy}
                saveState={preferenceSaveState}
                savePreference={savePreference}
              />
              {unanswered.length === 0 && workspace.discoveryNeedsRun && (
                <section className="setup-nudge complete">
                  <div>
                    <CheckCircle2 size={20} />
                    <span>
                      <strong>Job information is complete</strong>
                      <small>
                        Start Discovery now, or review and edit your evidence below.
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
            </>
          )}
          <EvidenceLedger
            workspace={workspace}
            canonicalEvidence={canonicalEvidence}
            disabled={busy || analyzing}
            onRetry={() =>
              void act(
                () => analyzeCandidate(),
                undefined,
                "candidate-analysis",
              )
            }
            onReviewClaim={(claimId, decision) =>
              void reviewClaim(claimId, decision)
            }
            onReviewContradiction={(contradictionId, decision, value) =>
              void reviewContradiction(contradictionId, decision, value)
            }
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
    <div
      id="profile-analysis-status"
      className="analysis-progress analysis-progress-primary"
      role="status"
      aria-live="polite"
    >
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
            ? progress.limitReached
              ? `${progress.completed} of ${progress.total} chunks read; this run will stop at the configured limit of ${progress.limit}. Completed evidence will still be kept.`
              : `${progress.completed} of ${progress.total} chunks read. Every eligible source is reread before the evidence ledger is rebuilt.`
            : progress?.stage === "synthesizing"
              ? progress.limitReached
                ? `${progress.completed} of ${progress.total} chunks were read before the configured limit of ${progress.limit}. Consolidating completed evidence so you can continue.`
                : `All ${progress.total} chunks are read. Rebuilding detailed knowledge and the deduplicated evidence index used for matching.`
              : "Starting the complete reread, consolidation, and deduplication pass."}
        </span>
        <small className="analysis-disclaimer">
          This is more than a CV read. We are building a reusable,
          source-backed AI knowledge base of your experience for stronger job
          discovery, requirement matching, application answers, cover letters
          and tailored CVs. The deeper pass can take several minutes.
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
  onRetry,
  onRemove,
  onReviewClaim,
  onReviewContradiction,
}: {
  workspace: JobSearchWorkspace;
  canonicalEvidence?: CanonicalEvidenceModel;
  disabled: boolean;
  onRetry: () => void;
  onRemove: (sourceId: string) => void;
  onReviewClaim: (
    claimId: string,
    decision: "candidate_confirmed" | "keep_weak" | "remove",
  ) => void;
  onReviewContradiction: (
    contradictionId: string,
    decision: "use_value" | "both_valid" | "keep_unresolved",
    selectedValue?: string,
  ) => void;
}) {
  const [editingSources, setEditingSources] = useState(false);
  if (workspace.sources.length === 0) return null;
  const reviewedClaimIds = new Set(
    (workspace.intelligence.evidenceReview?.claims ?? []).map(
      (review) => review.claimId,
    ),
  );
  const weakClaims = (canonicalEvidence?.claims ?? []).filter(
    (claim) =>
      claim.supportStatus !== "supported" &&
      !claim.review &&
      !reviewedClaimIds.has(claim.claimId),
  );
  const contradictions = canonicalEvidence?.contradictions ?? [];
  const hasReviewItems = weakClaims.length > 0 || contradictions.length > 0;
  return (
    <section className="band evidence-ledger">
      <div className="subsection-heading">
        <span className="section-label">Candidate evidence</span>
        <strong>Evidence found and considered in job search</strong>
        <small>
          Codex reasons across these source-backed facts when ranking jobs.
        </small>
        <button
          className={`evidence-edit-toggle ${editingSources ? "active" : ""}`}
          type="button"
          disabled={disabled}
          onClick={() => setEditingSources((editing) => !editing)}
        >
          {editingSources ? <Check size={14} /> : <Pencil size={14} />}
          {editingSources ? "Done editing" : "Edit evidence"}
        </button>
      </div>
      {editingSources && (
        <p className="evidence-edit-notice">
          Removing a source deletes its extracted facts and rebuilds the
          candidate evidence used by search and applications.
        </p>
      )}
      {hasReviewItems && (
        <section className="evidence-review-queue" aria-label="Evidence review">
          <header>
            <div>
              <span className="section-label">Your judgment</span>
              <strong>Evidence review</strong>
            </div>
            <small>
              These items need context only you can provide. They do not block job search.
            </small>
          </header>
          {weakClaims.map((claim) => (
            <article className="evidence-review-card" key={claim.claimId}>
              <div>
                <small>
                  Weakly supported claim · {Math.round(claim.confidence * 100)}%
                </small>
                <strong>{claim.action} {claim.capability}</strong>
                {claim.sourceRefs[0] && (
                  <p>
                    {claim.sourceRefs[0].locator}: “{claim.sourceRefs[0].quote}”
                  </p>
                )}
                {claim.limitations[0] && <p>{claim.limitations[0]}</p>}
              </div>
              <div className="evidence-review-actions">
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onReviewClaim(claim.claimId, "candidate_confirmed")}
                >
                  Confirm personally
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={disabled}
                  onClick={() => onReviewClaim(claim.claimId, "keep_weak")}
                >
                  Keep as weak
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={disabled}
                  onClick={() =>
                    document.getElementById("experience-evidence")?.focus()
                  }
                >
                  Add evidence
                </button>
                <button
                  type="button"
                  className="secondary evidence-review-remove"
                  disabled={disabled}
                  onClick={() => onReviewClaim(claim.claimId, "remove")}
                >
                  Remove
                </button>
              </div>
            </article>
          ))}
          {contradictions.map((contradiction) => (
            <article
              className="evidence-review-card"
              key={contradiction.contradictionId}
            >
              <div>
                <small>Conflicting evidence · {contradiction.field}</small>
                <strong>{contradiction.explanation}</strong>
              </div>
              <div className="evidence-review-values">
                {contradiction.values.map((entry) => (
                  <button
                    type="button"
                    disabled={disabled}
                    key={`${entry.sourceId}:${entry.value}`}
                    onClick={() =>
                      onReviewContradiction(
                        contradiction.contradictionId,
                        "use_value",
                        entry.value,
                      )
                    }
                  >
                    Use “{entry.value}”
                  </button>
                ))}
                <button
                  type="button"
                  className="secondary"
                  disabled={disabled}
                  onClick={() =>
                    onReviewContradiction(
                      contradiction.contradictionId,
                      "both_valid",
                    )
                  }
                >
                  Both are valid variants
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={disabled}
                  onClick={() =>
                    onReviewContradiction(
                      contradiction.contradictionId,
                      "keep_unresolved",
                    )
                  }
                >
                  Decide later
                </button>
              </div>
            </article>
          ))}
        </section>
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
                {editingSources && (
                  <button
                    type="button"
                    disabled={disabled}
                    title={`Remove ${source.name} and rebuild evidence`}
                    aria-label={`Remove ${source.name}`}
                    onClick={() => onRemove(source.id)}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </span>
            </header>
            {source.status === "processing" && (
              <p className="evidence-pending">Extracting evidence...</p>
            )}
            {source.error && <p className="source-error">{source.error}</p>}
            {isEvidenceChunkLimitError(source.error) && (
              <button
                className="evidence-limit-retry"
                type="button"
                disabled={disabled}
                onClick={onRetry}
              >
                <RefreshCw size={13} /> Retry with the current admin limit
              </button>
            )}
            {source.insights.length > 0 && (
              <ul>
                {source.insights.map((insight, insightIndex) => (
                  <li key={`${source.id}:${insight.id}:${insightIndex}`}>
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
  onExploreEvidence,
  onSaveLinkedIn,
}: ViewProps & {
  disabled?: boolean;
  evidenceLinks?: EvidenceLinkDraft;
  onEvidenceLinksChange?: (value: EvidenceLinkDraft) => void;
  onExploreEvidence?: (field: "github" | "website") => void;
  onSaveLinkedIn?: () => void;
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
  const githubStatus = profileEvidenceDisplayStatus(
    workspace,
    "github",
    displayedEvidenceLinks.github,
  );
  const websiteStatus = profileEvidenceDisplayStatus(
    workspace,
    "website",
    displayedEvidenceLinks.website,
  );
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
            LinkedIn is saved for applications. GitHub and personal websites
            found in your CV are explored automatically; links you enter here
            are explored only when you ask.
          </small>
        </div>
        <div className="evidence-link-fields">
        <div className="evidence-link-field">
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
            onBlur={onSaveLinkedIn}
          />
        </label>
        </div>
        <div className="evidence-link-field">
        <label className={displayedEvidenceLinks.github.trim() ? "field-complete" : ""}>
          <span className="profile-field-label">
            GitHub <small>Optional</small>
            <ProfileEvidenceStatus status={githubStatus} />
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
        {githubStatus?.tone === "missing" && (
          <button
            type="button"
            className="secondary explore-evidence-button"
            disabled={disabled || !displayedEvidenceLinks.github.trim()}
            onClick={() => onExploreEvidence?.("github")}
          >
            <Search size={13} /> Explore for evidence
          </button>
        )}
        </div>
        <div className="evidence-link-field">
        <label className={displayedWebsiteAddress.trim() ? "field-complete" : ""}>
          <span className="profile-field-label">
            Personal website <small>Optional</small>
            <ProfileEvidenceStatus status={websiteStatus} />
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
        {websiteStatus?.tone === "missing" && (
          <button
            type="button"
            className="secondary explore-evidence-button"
            disabled={disabled || !displayedEvidenceLinks.website.trim()}
            onClick={() => onExploreEvidence?.("website")}
          >
            <Search size={13} /> Explore for evidence
          </button>
        )}
        </div>
        </div>
      </div>
    </div>
  );
}

type ProfileEvidenceDisplayStatus =
  | { label: "Evidence explored"; tone: "ready" }
  | { label: "Exploring evidence"; tone: "processing" }
  | { label: "Not explored"; tone: "missing" }
  | undefined;

function ProfileEvidenceStatus({
  status,
}: {
  status: ProfileEvidenceDisplayStatus;
}) {
  if (!status) return null;
  return (
    <span className={`profile-evidence-status status-${status.tone}`}>
      {status.tone === "processing" && (
        <LoaderCircle className="spin" size={10} />
      )}
      {status.label}
    </span>
  );
}

function profileEvidenceDisplayStatus(
  workspace: JobSearchWorkspace,
  field: "linkedin" | "github" | "website",
  displayedValue: string,
): ProfileEvidenceDisplayStatus {
  const displayed = comparableEvidenceUrl(displayedValue);
  if (!displayed) return undefined;
  const saved = comparableEvidenceUrl(workspace.profile[field]);
  if (!saved || saved !== displayed)
    return { label: "Not explored", tone: "missing" };
  const source = workspace.sources.find(
    (candidate) =>
      candidate.profileField === field ||
      comparableEvidenceUrl(candidate.url || "") === saved,
  );
  if (!source) return { label: "Not explored", tone: "missing" };
  if (source.status === "processing")
    return { label: "Exploring evidence", tone: "processing" };
  if (source.status === "ready" && Boolean(source.content?.trim()))
    return { label: "Evidence explored", tone: "ready" };
  return { label: "Not explored", tone: "missing" };
}

function comparableEvidenceUrl(value: string) {
  const parsed = parseSourceUrl(value);
  if (!parsed) return "";
  return `${parsed.hostname.toLowerCase().replace(/^www\./, "")}${parsed.pathname.replace(/\/+$/, "")}${parsed.search}`;
}

function isGitHubRepositoryUrl(value?: URL) {
  if (!value) return false;
  return (
    value.hostname.toLowerCase().replace(/^www\./, "") === "github.com" &&
    value.pathname.split("/").filter(Boolean).length >= 2
  );
}

function githubProfileUsername(value: string) {
  const parsed = parseSourceUrl(value);
  if (
    !parsed ||
    parsed.hostname.toLowerCase().replace(/^www\./, "") !== "github.com"
  )
    return "";
  return parsed.pathname.split("/").filter(Boolean)[0] || "";
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
  saveState,
  savePreference,
}: {
  workspace: JobSearchWorkspace;
  unanswered: JobSearchWorkspace["questions"];
  busy: boolean;
  saveState: PreferenceSaveState;
  savePreference: (questionId: string, answer: string) => void;
}) {
  return (
    <section className="band questions" id="job-search-preferences">
      <div className="section-head">
        <div className="preferences-step-heading">
          <span className="wizard-number">3</span>
          <div>
            <span className="section-label">Job preferences</span>
            <h2>Information needed for job search</h2>
            <p className={`autosave-note ${saveState}`} aria-live="polite">
              {saveState === "saving" && <LoaderCircle className="spin" size={12} />}
              {saveState === "saved" && <Check size={12} />}
              {saveState === "error" && <AlertTriangle size={12} />}
              <span>
                {saveState === "saving"
                  ? "Saving changes…"
                  : saveState === "saved"
                    ? "Changes saved"
                    : saveState === "error"
                      ? "Could not save changes"
                      : "Changes save automatically. Compensation is optional."}
              </span>
            </p>
          </div>
        </div>
        <span className="count">{unanswered.length} open</span>
      </div>
      {workspace.questions.map((question) => (
        <Question
          key={`${workspace.candidateId}-${question.id}`}
          question={question}
          busy={busy}
          savePreference={savePreference}
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
  savePreference,
}: {
  question: JobSearchWorkspace["questions"][number];
  busy: boolean;
  savePreference: (questionId: string, answer: string) => void;
}) {
  const save = (answer: string) =>
    savePreference(question.id, answer);
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
  beta,
  busy,
  act,
  onContinue,
  onBetaChange,
  onOpenApplication,
  liveEvents,
}: ViewProps & {
  beta: BetaStatus;
  onContinue: () => void;
  onBetaChange: (next: BetaStatus) => void;
  onOpenApplication: (applicationId: string) => void;
  liveEvents: WorkflowProgressEvent[];
}) {
  const [selectedPipelineId, setSelectedPipelineId] = useState<string>();
  const progress = workspace.searchProgress;
  const running =
    progress?.stage === "looking" ||
    progress?.stage === "verifying" ||
    progress?.stage === "filling";
  const prepared = preparedVerifiedApplications(workspace);
  const preparedReadiness = applicationReadinessCounts(prepared);
  const allPipelineItems = cumulativePipelineItems(workspace);
  const preparedPipelineItems = preparedVerifiedItemsFrom(
    workspace,
    allPipelineItems,
  );
  const currentItemIds = deriveCurrentRunItemIds({
    progressItems: progress?.items ?? [],
    historyItems: workspace.jobHistory,
    baselineApplicationJobIds: progress?.baselineApplicationJobIds,
    preparedApplicationJobIds: preparedPipelineItems.map((item) => item.id),
    terminal:
      progress?.stage === "ready" ||
      progress?.stage === "failed" ||
      progress?.stage === "stopped",
  });
  const currentPreparedItems = preparedPipelineItems.filter((item) =>
    currentItemIds.has(item.id),
  );
  const applicationJobIds = new Set(
    workspace.applications.map((application) => application.jobId),
  );
  const bench = workspace.opportunities
    .filter((job) => !applicationJobIds.has(job.id))
    .sort((a, b) => b.fit - a.fit);
  const readyForMatching = (workspace.searchReadyOpportunities ?? []).filter(
    (job) => !applicationJobIds.has(job.id),
  );
  const developerMode = workspace.searchConfig.developerMode ?? false;
  const minimumMatchScore = workspace.searchConfig.minimumMatchScore ?? 35;
  const selectedPipelineItem = selectedPipelineId
    ? allPipelineItems.find((item) => item.id === selectedPipelineId)
    : undefined;
  const selectedPipelineOpportunity = selectedPipelineItem
    ? [...workspace.opportunities, ...workspace.searchReadyOpportunities].find(
        (job) => job.id === selectedPipelineItem.id,
      )
    : undefined;
  const promote = (jobId: string) => {
    void act(() => promoteOpportunity(jobId)).then((next) => {
      const application = next?.applications.find(
        (candidate) => candidate.jobId === jobId,
      );
      if (application) onOpenApplication(application.id);
    });
  };
  const openPipelineItem = (
    item: JobSearchWorkspace["jobHistory"][number],
    stage: "validation" | "match" | "application",
  ) => {
    if (stage === "application") {
      const application = workspace.applications.find(
        (candidate) => candidate.jobId === item.id,
      );
      if (application) {
        onOpenApplication(application.id);
        return;
      }
    }
    setSelectedPipelineId(item.id);
  };
  if (!candidateDiscoveryReady(workspace))
    return (
      <section className="discovery-blocked" role="status">
        <LoaderCircle className="spin" size={24} />
        <div>
          <strong>Updating profile evidence, please wait</strong>
          <span>
            Discovery is paused while RolegAIn rereads the sources and rebuilds
            the evidence-grounded knowledge used for search, matching and
            application customization.
          </span>
        </div>
      </section>
    );
  return (
    <div className="discovery-view">
      <BetaLimitCard beta={beta} onEnabled={onBetaChange} />
      {prepared.length > 0 && (
        <section className="discovery-continue discovery-continue-top">
          <div>
            <CheckCircle2 size={18} />
            <span>
              <strong>
                {preparedReadiness.ready} ready · {preparedReadiness.needsInput} need input
              </strong>
            </span>
          </div>
          <button className="primary" onClick={onContinue}>
            Continue to applications <ChevronRight size={15} />
          </button>
        </section>
      )}
      <section className="application-overview-toolbar discovery-toolbar">
        <div>
          <strong>{progress ? "Discover another batch" : "Start job discovery"}</strong>
          <span>
            Live vacancies are verified, prevalidated and evidence-matched in
            Match & rank. Only the selected ranked jobs enter Application preparation.
          </span>
        </div>
        <div className="search-pool-controls">
          <button
            className="queue-find"
            disabled={busy || running || !beta.canStartBatch}
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
              ? "Prepare next 5"
              : "Start discovery"}
          </button>
        </div>
      </section>
      {progress ? (
        <FindApplicationsProgress
          progress={progress}
          allItems={allPipelineItems}
          preparedItems={preparedPipelineItems}
          currentItemIds={currentItemIds}
          applicationTarget={workspace.searchConfig.applicationTarget}
          applicationReadiness={preparedReadiness}
          developerMode={developerMode}
          minimumMatchScore={minimumMatchScore}
          promotionBusy={busy || running}
          onPromote={promote}
          onOpenItem={openPipelineItem}
          liveEvents={liveEvents}
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
            disabled={!beta.canStartBatch}
            onClick={() =>
              void act(
                prepareSearchReadyApplications,
                undefined,
                "application-preparation",
              )
            }
          >
            Match and prepare up to 5 <ChevronRight size={15} />
          </button>
        </section>
      )}
      {progress && (
        <>
          {readyForMatching.length > 0 && (
            <PipelinePool
              title={`Ready for matching · ${readyForMatching.length}`}
              detail="Live, eligible vacancies that passed search verification; no matching decision is implied yet."
              jobs={readyForMatching}
              showFit={false}
              busy={busy || running}
              onPromote={promote}
            />
          )}
          {developerMode && (
            <>
              <PipelinePool
                title={`Developer bench · ${bench.length}`}
                detail="All scored jobs outside Applications, including automatic replacements and below-threshold matches."
                jobs={bench}
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
        </>
      )}
      {selectedPipelineItem && (
        <PipelineJobDetails
          item={selectedPipelineItem}
          job={selectedPipelineOpportunity}
          minimumMatchScore={minimumMatchScore}
          busy={busy || running}
          onClose={() => setSelectedPipelineId(undefined)}
          onMoveToApplications={() => promote(selectedPipelineItem.id)}
        />
      )}
    </div>
  );
}

function PipelineJobDetails({
  item,
  job,
  minimumMatchScore,
  busy,
  onClose,
  onMoveToApplications,
}: {
  item: JobSearchWorkspace["jobHistory"][number];
  job?: JobSearchWorkspace["opportunities"][number];
  minimumMatchScore: number;
  busy: boolean;
  onClose: () => void;
  onMoveToApplications: () => void;
}) {
  const manualReview = isManualReviewPipelineItem(item);
  const lowMatch = isLowMatchPipelineItem(item, minimumMatchScore);
  return (
    <div className="pipeline-details-backdrop" role="presentation" onClick={onClose}>
      <section
        className="pipeline-details-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pipeline-job-details-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="pipeline-details-toolbar">
          <a
            href={item.sourceUrl}
            target="_blank"
            rel="noreferrer"
            onClick={() =>
              void trackAnalyticsEvent("job_source_opened", {
                jobId: item.id,
                stage: "pipeline_details",
              })
            }
          >
            <Globe2 size={15} /> Open original listing <ArrowUpRight size={14} />
          </a>
          <button type="button" aria-label="Close job details" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="pipeline-details-heading">
          <span>{jobNumberLabel(item.jobNumber)}</span>
          <div>
            <small>{item.company}</small>
            <h2 id="pipeline-job-details-title">{item.title}</h2>
            {job && (
              <div className="job-meta">
                <span><MapPin size={14} /> {job.location}</span>
                <span>{compactCompensation(job.compensation)}</span>
                <span>{job.fit}% evidence match</span>
              </div>
            )}
          </div>
        </div>
        {manualReview && (
          <div className="pipeline-details-warning">
            <AlertTriangle size={18} />
            <span>
              <strong>Unable to verify automatically</strong>
              <small>
                {item.applicationRouteStatus === "manual_review"
                  ? "The vacancy was evidence-matched, but RolegAIn could not verify an employer form. Review and apply manually if appropriate."
                  : "RolegAIn could not confirm this page. Review the original listing manually before applying."}
              </small>
            </span>
          </div>
        )}
        {lowMatch && (
          <div className="pipeline-details-warning low-match">
            <CircleHelp size={18} />
            <span>
              <strong>Below your {minimumMatchScore}% automatic threshold</strong>
              <small>
                The role remains available for manual review and application
                tracking despite its lower evidence score.
              </small>
            </span>
          </div>
        )}
        {(item.applicationRouteReason || item.reason) && (
          <p className="pipeline-details-reason">
            {item.applicationRouteReason || item.reason}
          </p>
        )}
        {job?.summary && <p className="pipeline-details-summary">{job.summary}</p>}
        {job && <RequirementBreakdown job={job} />}
        {job?.description && (
          <details className="pipeline-details-description">
            <summary>Full job description</summary>
            <p>{job.description}</p>
          </details>
        )}
        {(manualReview || lowMatch) && (
          <div className="pipeline-details-actions">
            <span>
              Move this job into Applications to apply manually and track its
              outcome in RolegAIn.
            </span>
            <button
              className="primary"
              type="button"
              disabled={busy}
              onClick={onMoveToApplications}
            >
              <Plus size={14} /> Move to applications
            </button>
          </div>
        )}
      </section>
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
      <div className="application-match-details">
        <RequirementBreakdown job={job} />
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
            <a
              href={job.sourceUrl}
              target="_blank"
              rel="noreferrer"
              onClick={() =>
                void trackAnalyticsEvent("job_source_opened", {
                  jobId: job.id,
                  stage: "verified_pool",
                })
              }
            >
              View job
            </a>
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
            <a
              href={failure.sourceUrl}
              target="_blank"
              rel="noreferrer"
              onClick={() =>
                void trackAnalyticsEvent("job_source_opened", {
                  jobId: failure.id,
                  stage: "rejected",
                })
              }
            >
              View source
            </a>
            <button type="button" disabled={busy} onClick={() => onPromote(failure.id)}>
              <Plus size={12} /> Add manually
            </button>
          </div>
        </article>
      )) : <div className="application-group-empty">No rejected jobs recorded.</div>}
    </details>
  );
}

function FindApplicationsProgress({
  progress,
  allItems,
  preparedItems,
  currentItemIds,
  applicationTarget,
  applicationReadiness,
  developerMode,
  minimumMatchScore,
  promotionBusy,
  onPromote,
  onOpenItem,
  liveEvents,
  compact = false,
}: {
  progress: JobSearchWorkspace["searchProgress"];
  allItems: JobSearchWorkspace["jobHistory"];
  preparedItems: JobSearchWorkspace["jobHistory"];
  currentItemIds: Set<string>;
  applicationTarget: number;
  applicationReadiness: { ready: number; needsInput: number };
  developerMode: boolean;
  minimumMatchScore: number;
  promotionBusy: boolean;
  onPromote: (jobId: string) => void;
  onOpenItem: (
    item: JobSearchWorkspace["jobHistory"][number],
    stage: "validation" | "match" | "application",
  ) => void;
  liveEvents: WorkflowProgressEvent[];
  compact?: boolean;
}) {
  if (!progress) return null;
  const running =
    progress.stage === "looking" ||
    progress.stage === "verifying" ||
    progress.stage === "filling";
  if (compact)
    return (
      <div className={`find-progress ${progress.stage}`} role="status" aria-live="polite">
        <span className="active">
          {progress.stage === "ready" ? <CheckCircle2 size={14} /> : <LoaderCircle className="spin" size={14} />}
          {progress.activity ?? "Processing the job pipeline"}
        </span>
        <small>{progress.found} of {progress.target} in the current stage</small>
        {running && <PipelineDepthNote stage={progress.stage} compact />}
        {progress.error && <small>{progress.error}</small>}
      </div>
    );
  const items = progress.items ?? [];
  const activityEvents = [...(progress.events ?? []), ...liveEvents]
    .filter((event, index, events) =>
      events.findIndex((candidate) => candidate.id === event.id) === index,
    )
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
    .slice(-12);
  const discoverySlots = Math.max(
    0,
    (progress.stage === "looking" ? progress.target : items.length) - items.length,
  );
  const displayItems = allItems.map((item) =>
    settlePipelineItemForDisplay(
      item,
      progress.stage === "ready" || progress.stage === "failed",
    ),
  );
  const discoveryOnlyItems = displayItems.filter(
    (item) =>
      pipelineDisplayStage(item) === "validation" &&
      item.validationDisposition !== "source_page" &&
      pipelineItemVisible(
        item,
        "validation",
        developerMode,
        minimumMatchScore,
      ),
  );
  const matchOnlyItems = displayItems.filter(
    (item) =>
      pipelineDisplayStage(item) === "match" &&
      pipelineItemVisible(item, "match", developerMode, minimumMatchScore),
  );
  const applicationAttemptItems = displayItems.filter(
    (item) =>
      pipelineDisplayStage(item) === "application" &&
      pipelineItemVisible(
        item,
        "application",
        developerMode,
        minimumMatchScore,
      ),
  );
  const sourceGroups = developerMode
    ? marketplaceSourceGroups(displayItems, currentItemIds)
    : [];
  const newPreparedCount = preparedItems.filter((item) =>
    currentItemIds.has(item.id),
  ).length;
  const failedApplicationCount = applicationAttemptItems.filter(
    (item) => applicationOutcomeState(item) === "failed",
  ).length;
  const activeApplicationCount = applicationAttemptItems.filter((item) => {
    const state = applicationOutcomeState(item);
    return state === "running" || state === "selected";
  }).length;
  const discoveryInProgressCount =
    discoverySlots +
    discoveryOnlyItems.filter(
      (item) => item.validation === "waiting" || item.validation === "running",
    ).length;
  const matchingInProgressCount = matchOnlyItems.filter(
    (item) => item.match === "waiting" || item.match === "running",
  ).length;
  const currentRunItems = items.filter((item) => currentItemIds.has(item.id));
  const concreteReviewedCount = currentRunItems.filter(
    (item) => item.validationDisposition !== "source_page",
  ).length;
  const liveVacancyCount = currentRunItems.filter(
    (item) => item.validation === "passed",
  ).length;
  const excludedVacancyCount = currentRunItems.filter(
    (item) => item.validation === "failed",
  ).length;
  const matchedVacancyCount = currentRunItems.filter(
    (item) => item.match === "passed",
  ).length;
  const manualRouteMatchCount = currentRunItems.filter(
    (item) =>
      item.match === "passed" &&
      item.applicationRouteStatus === "manual_review",
  ).length;
  const enteredApplicationCount = currentRunItems.filter(isApplicationAttempt).length;
  const pendingMatchCount = currentRunItems.filter(
    (item) => item.match === "waiting" || item.match === "running",
  ).length;
  const selectedApplicationCount = Math.min(
    applicationTarget,
    currentRunItems.length,
  );
  const preparedCurrentRunEmptyMessage =
    progress.stage === "verifying" && pendingMatchCount > 0
      ? `Waiting for ${pendingMatchCount} more ${pendingMatchCount === 1 ? "job" : "jobs"} to finish full evidence matching before selecting the top ${selectedApplicationCount} for application preparation.`
      : undefined;
  const activity =
    running && liveEvents.at(-1)?.message
      ? liveEvents.at(-1)!.message
      : progress.stage === "ready"
      ? progress.activity?.startsWith("Validation replay complete:")
        ? progress.activity
        : `${newPreparedCount} new applications are prepared and independently verified. Some may still need candidate information before submission.`
      : progress.activity ?? "Job pipeline";
  return (
    <section className={`search-pipeline ${progress.stage}`} role="status" aria-live="polite">
      <header className="pipeline-activity">
        <span className={`pipeline-live-dot ${running ? "running" : ""}`} />
        <div>
          <strong>{activity}</strong>
          <PipelineElapsedTime progress={progress} running={running} />
          <small className="pipeline-funnel-summary">
            {concreteReviewedCount} concrete reviewed · {liveVacancyCount} live ·{" "}
            {matchedVacancyCount} matched · {enteredApplicationCount} entered applications
            {excludedVacancyCount ? ` · ${excludedVacancyCount} excluded before matching` : ""}
            {manualRouteMatchCount ? ` · ${manualRouteMatchCount} matched for manual application` : ""}
          </small>
        </div>
        <b>
          {developerMode
            ? `${items.length} jobs`
            : `${discoveryOnlyItems.length + matchOnlyItems.length + applicationAttemptItems.length} shown`}
        </b>
      </header>
      {running && <PipelineDepthNote stage={progress.stage} />}
      <div className="pipeline-board">
        <PipelineColumn
          step="1"
          title="Discover & verify"
          count={`${discoveryInProgressCount} in search · ${discoveryOnlyItems.length} shown`}
          items={discoveryOnlyItems}
          currentItemIds={currentItemIds}
          phase="validation"
          placeholders={discoverySlots}
          sourceGroups={sourceGroups}
          minimumMatchScore={minimumMatchScore}
          promotionBusy={promotionBusy}
          onPromote={onPromote}
          onOpenItem={onOpenItem}
        />
        <span className="pipeline-arrow" aria-hidden="true">→</span>
        <PipelineColumn
          step="2"
          title="Match & rank"
          count={`${matchingInProgressCount} matching · ${matchOnlyItems.length} shown`}
          items={matchOnlyItems}
          currentItemIds={currentItemIds}
          phase="match"
          minimumMatchScore={minimumMatchScore}
          promotionBusy={promotionBusy}
          onPromote={onPromote}
          onOpenItem={onOpenItem}
        />
        <span className="pipeline-arrow" aria-hidden="true">→</span>
        <PipelineColumn
          step="3"
          title="Application preparation"
          count={`${applicationReadiness.ready} ready · ${applicationReadiness.needsInput} need input · ${activeApplicationCount} checking${developerMode && failedApplicationCount ? ` · ${failedApplicationCount} failed` : ""}`}
          items={applicationAttemptItems}
          currentItemIds={currentItemIds}
          phase="application_outcome"
          currentRunEmptyMessage={preparedCurrentRunEmptyMessage}
          minimumMatchScore={minimumMatchScore}
          promotionBusy={promotionBusy}
          onPromote={onPromote}
          onOpenItem={onOpenItem}
        />
      </div>
      {developerMode && activityEvents.length > 0 && (
        <div className="pipeline-events">
          {[...activityEvents].reverse().map((event) => (
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

function PipelineDepthNote({
  stage,
  compact = false,
}: {
  stage: NonNullable<JobSearchWorkspace["searchProgress"]>["stage"];
  compact?: boolean;
}) {
  const detail =
    stage === "looking"
      ? "RolegAIn is running multiple evidence-guided searches and collecting concrete vacancies from the public web—not returning a quick title or keyword list."
      : stage === "verifying"
        ? "Every vacancy is reopened and checked for availability, role details and constraints. Jobs with verified employer forms are matched first; unverified routes are retained and matched later for possible manual application."
        : "Only selected ranked jobs enter this stage. Each is handled independently through full form inspection and mapping, company research, grounded drafting and verification before the application is marked ready.";
  return (
    <div className={`pipeline-depth-note ${compact ? "compact" : ""}`}>
      <Sparkles size={15} />
      <span>
        <strong>Why this takes time</strong>
        <small>
          {detail} This deeper process is designed to produce better matches
          and more specific applications than simple search or autofill. You
          can leave it running; notifications will alert you if enabled.
        </small>
      </span>
    </div>
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
  | "application_outcome"
  | "prepared_verified";

function PipelineColumn({
  step,
  title,
  count,
  items,
  currentItemIds,
  phase,
  placeholders = 0,
  currentRunEmptyMessage,
  sourceGroups = [],
  minimumMatchScore,
  promotionBusy,
  onPromote,
  onOpenItem,
}: {
  step: string;
  title: string;
  count: string;
  items: NonNullable<NonNullable<JobSearchWorkspace["searchProgress"]>["items"]>;
  currentItemIds: Set<string>;
  phase: PipelinePhase;
  placeholders?: number;
  currentRunEmptyMessage?: string;
  sourceGroups?: ReturnType<typeof marketplaceSourceGroups>;
  minimumMatchScore: number;
  promotionBusy: boolean;
  onPromote: (jobId: string) => void;
  onOpenItem: (
    item: JobSearchWorkspace["jobHistory"][number],
    stage: "validation" | "match" | "application",
  ) => void;
}) {
  const displayStage =
    phase === "validation"
      ? "validation"
      : phase === "match"
        ? "match"
        : "application";
  const sortedItems = sortPipelineRows(items, currentItemIds, displayStage);
  const newest = sortedItems.filter((item) => currentItemIds.has(item.id));
  const older = sortedItems.filter((item) => !currentItemIds.has(item.id));
  const renderItem = (
    item: NonNullable<
      NonNullable<JobSearchWorkspace["searchProgress"]>["items"]
    >[number],
  ) => {
    const state = pipelineItemState(item, phase);
    const manualReview =
      displayStage !== "application" && isManualReviewPipelineItem(item);
    const lowMatch =
      displayStage === "match" &&
      isLowMatchPipelineItem(item, minimumMatchScore);
    const promotable = manualReview || lowMatch;
    const activeLabel =
      state === "running"
        ? displayStage === "validation"
          ? "Searching / verifying"
          : displayStage === "match"
            ? "Matching"
            : "Application checking"
        : state === "selected"
          ? "Queued for application checking"
          : state === "waiting" && displayStage === "validation"
            ? "Queued for search"
            : state === "waiting" && displayStage === "match"
              ? "Queued for matching"
              : undefined;
    return (
      <article className={`pipeline-job state-${state}`} key={`${phase}-${item.id}`} title={item.reason}>
        <span className="pipeline-state-icon">
          {state === "running" ? <LoaderCircle className="spin" size={13} /> : state === "passed" ? <Check size={13} /> : state === "failed" ? <X size={13} /> : state === "bench" ? <Clock3 size={13} /> : state === "selected" ? <ChevronRight size={13} /> : <span />}
        </span>
        <button
          className="pipeline-job-open"
          type="button"
          onClick={() => onOpenItem(item, displayStage)}
        >
          <strong>
            <span className="inline-job-number">{jobNumberLabel(item.jobNumber)}</span>
            {item.title || "Vacancy"}
          </strong>
          <span>{item.company || "Source pending"}</span>
          {phase === "match" && typeof item.fit === "number" && <em>{item.fit}% match</em>}
          {manualReview ? (
            <em className="pipeline-unable-status">
              {item.applicationRouteStatus === "manual_review"
                ? "Application form unverified · manual apply"
                : "Unable to verify"}
            </em>
          ) : activeLabel ? (
            <em>{activeLabel}</em>
          ) : phase === "validation" && item.validationDisposition ? (
            <em>{item.validationDisposition.replace(/_/g, " ")}</em>
          ) : null}
          {(item.applicationRouteReason || item.reason) &&
            (state === "failed" || promotable) && (
              <small>{item.applicationRouteReason || item.reason}</small>
            )}
          {manualReview && (
            <small className="pipeline-action-reason">
              {item.applicationRouteStatus === "manual_review"
                ? "This job was matched after the automatic application slots; apply manually if desired."
                : "Try reviewing the original listing manually."}
            </small>
          )}
          {lowMatch && (
            <small className="pipeline-action-reason">
              Below your {minimumMatchScore}% automatic application threshold
            </small>
          )}
        </button>
        {promotable && (
          <button
            className="pipeline-promote-action"
            type="button"
            disabled={promotionBusy}
            onClick={() => onPromote(item.id)}
          >
            <Plus size={11} /> Move to applications
          </button>
        )}
      </article>
    );
  };
  return (
    <section className={`pipeline-column pipeline-column-${phase}`}>
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
            <span className="pipeline-area-empty">
              {currentRunEmptyMessage ??
                "No job is at this stage in the current run."}
            </span>
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
        {sourceGroups.length > 0 && (
          <section className="pipeline-source-groups">
            <span className="pipeline-previous-label">Job marketplaces</span>
            {sourceGroups.map((group) => (
              <section className="pipeline-source-group" key={group.source.id}>
                <article className="pipeline-job pipeline-source-parent">
                  <span className="pipeline-state-icon"><Globe2 size={13} /></span>
                  <a href={group.source.url} target="_blank" rel="noreferrer">
                    <strong>{group.source.name}</strong>
                    <span>{group.items.length} concrete vacancies found</span>
                  </a>
                </article>
                {group.items.map((item) => (
                  <article className="pipeline-job pipeline-source-child" key={`${group.source.id}-${item.id}`}>
                    <span className="pipeline-source-branch" aria-hidden="true">↳</span>
                    <a href={item.sourceUrl || undefined} target="_blank" rel="noreferrer">
                      <strong>
                        <span className="inline-job-number">{jobNumberLabel(item.jobNumber)}</span>
                        {item.title || "Vacancy"}
                      </strong>
                      <span>{item.company || "Employer pending"}</span>
                    </a>
                  </article>
                ))}
              </section>
            ))}
          </section>
        )}
      </div>
    </section>
  );
}

function pipelineItemState(
  item: NonNullable<NonNullable<JobSearchWorkspace["searchProgress"]>["items"]>[number],
  phase: PipelinePhase,
) {
  if (phase === "application_outcome") return applicationOutcomeState(item);
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
        <span className="match-details-heading">
          <span>
            <strong>View match details</strong>
            <small>See how your evidence supports this score</small>
          </span>
          <ChevronDown
            aria-hidden="true"
            className="match-details-chevron"
            size={17}
          />
        </span>
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
        Overall match is a fixed calibration of the underlying evidence score,
        so job ordering remains unchanged while ordinary requirement-list
        inflation is not presented as candidate failure. Mandatory
        qualifications weigh 3, core responsibilities 2, and preferred
        qualifications 0.5. Explicit, strong-adjacent, and weak-adjacent
        evidence receive 100%, 85%, and 55% credit. Repeated capability themes
        are capped, and verified-evidence confidence only fine-tunes the result.
        {typeof job.scoreBreakdown?.rawEvidenceFit === "number" && (
          <span>
            {` Evidence score: ${job.scoreBreakdown.rawEvidenceFit}%; calibrated match: ${job.fit}%.`}
          </span>
        )}
        Opportunity confidence and hard feasibility remain separate.
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
  beta,
  selectedId,
  setSelectedId,
  act,
  busy,
  onPrepareNext,
  onBetaChange,
}: ViewProps & {
  beta: BetaStatus;
  selectedId?: string;
  setSelectedId: (id?: string) => void;
  onPrepareNext: () => void;
  onBetaChange: (next: BetaStatus) => void;
}) {
  const [adding, setAdding] = useState(false);
  const applications = preparedVerifiedApplications(workspace);
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
      <BetaLimitCard beta={beta} onEnabled={onBetaChange} />
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
            disabled={busy || findingMore || !beta.canStartBatch}
            onClick={onPrepareNext}
          >
            {findingMore ? (
              <LoaderCircle className="spin" size={14} />
            ) : (
              <Search size={14} />
            )}
            Prepare next 5
          </button>
          <button
            className="primary"
            disabled={busy}
            onClick={() => setAdding((value) => !value)}
          >
            <Plus size={15} /> Add application
          </button>
        </div>
      </div>
      {findingMore && findProgress && (
        <PipelineDepthNote stage={findProgress.stage} compact />
      )}
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
          disabled={busy || findingMore || !beta.canStartBatch}
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
            void trackAnalyticsEvent("application_opened", {
              applicationId: id,
            });
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
        onClick={() => {
          void trackAnalyticsEvent("application_opened", {
            applicationId: app.id,
          });
          setSelectedId(app.id);
        }}
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
                disabled={busy || findingMore || !beta.canStartBatch}
                onClick={onPrepareNext}
              >
                {findingMore ? (
                  <LoaderCircle className="spin" size={13} />
                ) : (
                  <Search size={13} />
                )}
                Prepare next 5
              </button>
            </div>
          </div>
          <div className="application-list-groups">
            {APPLICATION_GROUPS.map((group) => {
              const groupedApplications = applications.filter(
                (application) => applicationGroupKey(application) === group.key,
              );
              if (groupedApplications.length === 0) return null;
              return (
                <section
                  className={`application-list-group group-${group.key}`}
                  key={group.key}
                >
                  <header>
                    <span>{group.label}</span>
                    <b>{groupedApplications.length}</b>
                  </header>
                  {groupedApplications.map(renderApplicationListEntry)}
                </section>
              );
            })}
          </div>
        </aside>
        <ApplicationEditor
          key={selected.id}
          app={selected}
          job={job}
          busy={busy}
          llmBlocked={beta.remainingApplications <= 0}
          act={act}
        />
      </div>
    </div>
  );
}

function ApplicationReviewDetails({
  job,
}: {
  job: JobSearchWorkspace["opportunities"][number];
}) {
  return (
    <section className="application-review-details">
      <div className="application-review-details-heading">
        <span className="application-feature-icon">
          <BriefcaseBusiness size={17} />
        </span>
        <span>
          <strong>Vacancy and evidence match</strong>
          <small>Complete job context and the evidence behind this match</small>
        </span>
        <b>{job.fit}% match</b>
      </div>
      {job.summary && <p className="application-vacancy-summary">{job.summary}</p>}
      <RequirementBreakdown job={job} />
      {(job.description || job.requirements.length > 0) && (
        <details className="application-vacancy-details">
          <summary>
            <span>
              <strong>Full vacancy details</strong>
              <small>
                {job.requirements.length} captured requirements and the complete
                job description
              </small>
            </span>
            <ChevronDown size={17} />
          </summary>
          <div>
            {job.requirements.length > 0 && (
              <section>
                <strong>Captured requirements</strong>
                <ul>
                  {job.requirements.map((requirement) => (
                    <li key={requirement}>{requirement}</li>
                  ))}
                </ul>
              </section>
            )}
            {job.description && (
              <section>
                <strong>Full captured description</strong>
                <p>{job.description}</p>
              </section>
            )}
          </div>
        </details>
      )}
    </section>
  );
}

function ApplicationEditor({
  app,
  job,
  busy,
  llmBlocked,
  act,
}: {
  app: ApplicationDraft;
  job: JobSearchWorkspace["opportunities"][number];
  busy: boolean;
  llmBlocked: boolean;
  act: ViewProps["act"];
}) {
  const [coverLetter, setCoverLetter] = useState(app.coverLetter);
  const [coverLetterMessage, setCoverLetterMessage] = useState("");
  const [refiningCoverLetter, setRefiningCoverLetter] = useState(false);
  const [cvDownloadError, setCvDownloadError] = useState("");
  const [tailoringCv, setTailoringCv] = useState(false);
  const [showEmployerForm, setShowEmployerForm] = useState(false);
  const [employerFormOpened, setEmployerFormOpened] = useState(false);
  const [employerFormUrl, setEmployerFormUrl] = useState("");
  const [employerFormError, setEmployerFormError] = useState("");
  const [openingEmployerForm, setOpeningEmployerForm] = useState(false);
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
    setOpeningEmployerForm(true);
    setEmployerFormError("");
    try {
      const session = await createEmployerProxySession(app.id);
      setEmployerFormUrl(session.url);
      setEmployerFormOpened(true);
      setShowEmployerForm(true);
      void trackAnalyticsEvent("employer_form_opened", {
        applicationId: app.id,
        jobId: job.id,
      });
    } catch (error) {
      setEmployerFormError(
        error instanceof Error
          ? error.message
          : "The employer form could not be opened.",
      );
    } finally {
      setOpeningEmployerForm(false);
    }
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
            {app.liveFormValidated ? (
              <><ShieldCheck size={15} /> Agent-prefilled browser</>
            ) : (
              <><Globe2 size={15} /> Manual application page</>
            )}
          </span>
        </div>
        <iframe
          className="employer-browser-frame"
          src={employerFormUrl}
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
            onClick={() =>
              void trackAnalyticsEvent("job_source_opened", {
                jobId: job.id,
                stage: "application",
              })
            }
          >
            <Globe2 size={15} /> Open original job <ArrowUpRight size={14} />
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
            : !app.liveFormValidated && app.formFields.length === 0
              ? "Form not found"
            : `${app.formFields.filter((f) => f.value).length}/${app.formFields.length} fields mapped`}
        </span>
      </div>
      <ApplicationReviewDetails job={job} />
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
          {(tailoringCv || app.tailoredCv?.status === "processing") && (
            <div className="application-depth-note" role="status">
              <Sparkles size={15} />
              <span>
                <strong>Building a job-specific CV</strong>
                <small>
                  RolegAIn is comparing the vacancy requirement by requirement
                  with your canonical evidence, selecting the most relevant
                  supported experience and checking that the revision stays
                  truthful. This is deeper than keyword replacement, so it can
                  take a few minutes.
                </small>
              </span>
            </div>
          )}
          <button
            className="secondary tailored-cv-generate"
            disabled={
              busy ||
              verified ||
              llmBlocked ||
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
        ) : !app.liveFormValidated && app.formFields.length === 0 ? (
          <span>
            <AlertTriangle size={17} /> Employer form not found · try manually
          </span>
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
          {!app.liveFormValidated && app.formFields.length === 0 && (
            <div className="application-group-empty">
              No employer form was observed, so RolegAIn has not invented any
              application fields. Open the original application page and try
              completing it manually.
            </div>
          )}
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
                      llmBlocked={llmBlocked}
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
                      disabled={verified || llmBlocked}
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
                    ? app.addedBy === "user"
                      ? app.formFields.length === 0
                        ? "Employer form not found"
                        : "Manual application tracking"
                      : "Employer form needs manual review"
                    : missingRequiredFields.length
                    ? `${missingRequiredFields.length} ${missingRequiredFields.length === 1 ? "field will" : "fields will"} remain blank`
                    : "Ready for employer review"}
                </strong>
                <small>
                  {formNeedsManualReview
                    ? app.addedBy === "user"
                      ? app.formFields.length === 0
                        ? "No employer form was observed. Try the original application page manually, then record the outcome here."
                        : "RolegAIn has not verified or mapped this employer form. Review the original listing, apply manually, then record the outcome here."
                      : "The vacancy is verified, but this form could not be mapped automatically. Open it here and complete protected, sign-in, CAPTCHA, or unsupported controls manually."
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
              disabled={busy || openingEmployerForm}
              className="send"
              onClick={() => void openEmployerForm()}
            >
              {openingEmployerForm ? (
                <LoaderCircle className="spin" size={16} />
              ) : canReturnToEmployer ? (
                <ArrowUpRight size={16} />
              ) : (
                <Send size={16} />
              )}{" "}
              {openingEmployerForm
                ? "Opening employer form"
                : canReturnToEmployer
                  ? "Return to employer form"
                  : !app.liveFormValidated && app.formFields.length === 0
                    ? "Try application page manually"
                    : "Open employer form"}
            </button>
          </div>
          {employerFormError && (
            <p className="application-feature-error">{employerFormError}</p>
          )}
        </div>
      </div>
    </section>
  );
}

function CoverLetterFieldEditor({
  app,
  busy,
  llmBlocked,
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
  llmBlocked: boolean;
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
        disabled={verified || refining || llmBlocked}
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
            disabled={verified || refining || busy || llmBlocked}
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
            disabled={
              verified ||
              refining ||
              busy ||
              llmBlocked ||
              changed ||
              !message.trim()
            }
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
          <small className="manual-application-note">
            Add an employer link for manual application and outcome tracking.
          </small>
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
          <Plus size={15} /> Add for tracking
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
  disabled = false,
  lockedReason,
  onClick,
}: {
  icon: typeof UserRound;
  label: string;
  active: boolean;
  badge?: string;
  disabled?: boolean;
  lockedReason?: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`nav-btn ${active ? "active" : ""}`}
      type="button"
      disabled={disabled}
      aria-label={disabled && lockedReason ? `${label}. ${lockedReason}` : label}
      title={disabled ? lockedReason : undefined}
      onClick={onClick}
    >
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
  if (application.addedBy === "user" && !application.liveFormValidated)
    return "Manual tracking";
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
  if (application.addedBy === "user" && !application.liveFormValidated)
    return "Manual application tracking";
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
