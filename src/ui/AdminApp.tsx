import { useEffect, useState, type FormEvent } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  LogOut,
  PauseCircle,
  PlayCircle,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  Users,
} from "lucide-react";
import "./admin.css";

interface BetaStatus {
  applicationsUsed: number;
  applicationLimit: number;
  batchesStarted: number;
  batchLimit: number;
  remainingApplications: number;
  remainingBatches: number;
  canStartBatch: boolean;
  releaseUpdates: boolean;
}

interface AdminUser {
  id: string;
  email?: string;
  name?: string;
  registeredAt?: string;
  lastSignInAt?: string;
  lastActiveAt?: string;
  phase: string;
  profileCompleteness: number;
  sources: number;
  jobsSeen: number;
  searchReadyJobs: number;
  applications: number;
  applied: number;
  beta: BetaStatus;
  events: Record<string, number>;
  latestWorkflow?: {
    type: string;
    status: string;
    createdAt: string;
  };
}

interface AdminOverview {
  generatedAt: string;
  service: {
    codexEnabled: boolean;
    maintenanceMessage?: string;
  };
  totals: {
    users: number;
    applications: number;
    jobSourceClicks: number;
  };
  eventTotals: Record<string, number>;
  users: AdminUser[];
}

export function AdminApp() {
  const [overview, setOverview] = useState<AdminOverview>();
  const [authenticated, setAuthenticated] = useState<boolean>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");

  const refresh = async () => {
    const response = await fetch("/api/admin/overview", {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (response.status === 401) {
      setAuthenticated(false);
      setOverview(undefined);
      return;
    }
    if (!response.ok) throw new Error(await responseError(response));
    setOverview(await response.json() as AdminOverview);
    setAuthenticated(true);
  };

  useEffect(() => {
    void refresh().catch((cause) => {
      setAuthenticated(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    });
    const timer = window.setInterval(
      () => void refresh().catch(() => undefined),
      15_000,
    );
    return () => window.clearInterval(timer);
  }, []);

  if (authenticated !== true)
    return (
      <AdminLogin
        error={error}
        busy={busy}
        onLogin={async (username, password) => {
          setBusy(true);
          setError("");
          try {
            const response = await fetch("/api/admin/login", {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ username, password }),
            });
            if (!response.ok) throw new Error(await responseError(response));
            await refresh();
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          } finally {
            setBusy(false);
          }
        }}
      />
    );

  const users = (overview?.users ?? []).filter((user) =>
    `${user.name || ""} ${user.email || ""} ${user.id}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const codexEnabled = overview?.service.codexEnabled ?? true;

  return (
    <main className="admin-shell">
      <header className="admin-header">
        <div>
          <span className="admin-kicker">Rolegain closed beta</span>
          <h1>Admin control room</h1>
          <p>User progression, feature activity and Codex control.</p>
        </div>
        <div className="admin-header-actions">
          <button
            className={codexEnabled ? "admin-danger" : "admin-resume"}
            type="button"
            disabled={busy}
            onClick={async () => {
              const next = !codexEnabled;
              if (
                !next &&
                !window.confirm(
                  "Pause all new Codex work and put the user app into maintenance mode?",
                )
              )
                return;
              setBusy(true);
              setError("");
              try {
                const response = await fetch("/api/admin/codex", {
                  method: "POST",
                  credentials: "same-origin",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ enabled: next }),
                });
                if (!response.ok)
                  throw new Error(await responseError(response));
                await refresh();
              } catch (cause) {
                setError(
                  cause instanceof Error ? cause.message : String(cause),
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            {codexEnabled ? (
              <><PauseCircle size={17} /> Disconnect Codex</>
            ) : (
              <><PlayCircle size={17} /> Reconnect Codex</>
            )}
          </button>
          <button
            type="button"
            onClick={() => void refresh()}
            title="Refresh dashboard"
          >
            <RefreshCw size={16} />
          </button>
          <details className="admin-settings">
            <summary>
              <SettingsIcon size={16} /> Settings
            </summary>
            <div className="admin-settings-menu">
              <button
                type="button"
                onClick={async () => {
                  await fetch("/api/admin/logout", {
                    method: "POST",
                    credentials: "same-origin",
                  });
                  setAuthenticated(false);
                  setOverview(undefined);
                }}
              >
                <LogOut size={16} /> Sign out
              </button>
            </div>
          </details>
        </div>
      </header>

      {!codexEnabled && (
        <section className="admin-maintenance">
          <AlertTriangle size={19} />
          <div>
            <strong>Codex is disconnected</strong>
            <span>
              Users see maintenance mode. New workflows and new model turns are
              blocked until you reconnect it.
            </span>
          </div>
        </section>
      )}
      {error && <div className="admin-error">{error}</div>}

      <section className="admin-metrics">
        <Metric
          icon={Users}
          label="Registered users"
          value={overview?.totals.users ?? 0}
        />
        <Metric
          icon={CheckCircle2}
          label="Beta applications"
          value={overview?.totals.applications ?? 0}
        />
        <Metric
          icon={Activity}
          label="Job link clicks"
          value={overview?.totals.jobSourceClicks ?? 0}
        />
      </section>

      <section className="admin-function-panel">
        <header>
          <div>
            <span className="admin-kicker">Feature activity</span>
            <h2>What people are using</h2>
          </div>
        </header>
        <div className="admin-event-grid">
          {Object.entries(overview?.eventTotals ?? {})
            .sort((left, right) => right[1] - left[1])
            .map(([event, count]) => (
              <div key={event}>
                <span>{eventLabel(event)}</span>
                <strong>{count}</strong>
              </div>
            ))}
          {!Object.keys(overview?.eventTotals ?? {}).length && (
            <p>No interaction events recorded yet.</p>
          )}
        </div>
      </section>

      <section className="admin-users">
        <header>
          <div>
            <span className="admin-kicker">Users</span>
            <h2>Progress and usage</h2>
          </div>
          <label className="admin-search">
            <Search size={15} />
            <input
              value={query}
              placeholder="Search user or email"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </header>
        <div className="admin-table-wrap">
          <table>
            <thead>
              <tr>
                <th>User</th>
                <th>Progress</th>
                <th>Jobs</th>
                <th>Applications</th>
                <th>Beta</th>
                <th>Activity</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td>
                    <strong>{user.name || "Unnamed user"}</strong>
                    <span>{user.email || user.id}</span>
                    <small>
                      Joined {formatDate(user.registeredAt)}
                    </small>
                  </td>
                  <td>
                    <strong>{progressLabel(user)}</strong>
                    <span>{user.profileCompleteness}% profile</span>
                    <small>
                      {user.sources} sources · {workflowLabel(user)}
                    </small>
                  </td>
                  <td>
                    <strong>{user.jobsSeen} seen</strong>
                    <span>{user.searchReadyJobs} ready for matching</span>
                    <small>
                      {user.events.job_source_opened ?? 0} source clicks
                    </small>
                  </td>
                  <td>
                    <strong>{user.applications} current</strong>
                    <span>{user.applied} marked applied</span>
                    <small>
                      {user.events.application_opened ?? 0} opens ·{" "}
                      {user.events.employer_form_opened ?? 0} employer forms
                    </small>
                  </td>
                  <td>
                    <strong>
                      {user.beta.applicationsUsed}/{user.beta.applicationLimit}
                    </strong>
                    <span>
                      {user.beta.batchesStarted}/{user.beta.batchLimit} batches
                    </span>
                    <small>
                      {user.beta.releaseUpdates
                        ? "Release updates: yes"
                        : "Release updates: no"}
                    </small>
                    <UserLimitControl user={user} onUpdated={refresh} />
                  </td>
                  <td>
                    <strong>{formatDate(user.lastActiveAt)}</strong>
                    <span>Last sign-in {formatDate(user.lastSignInAt)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!users.length && <p className="admin-empty">No matching users.</p>}
        </div>
      </section>
    </main>
  );
}

function AdminLogin({
  error,
  busy,
  onLogin,
}: {
  error: string;
  busy: boolean;
  onLogin: (username: string, password: string) => Promise<void>;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void onLogin(username, password);
  };
  return (
    <main className="admin-login-shell">
      <form className="admin-login-card" onSubmit={submit}>
        <span className="admin-kicker">Private administration</span>
        <h1>Rolegain admin</h1>
        <p>This route is separate from candidate authentication.</p>
        <label>
          Username
          <input
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            required
          />
        </label>
        <label>
          Password
          <input
            autoComplete="current-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        {error && <div className="admin-error">{error}</div>}
        <button type="submit" disabled={busy}>
          {busy ? "Checking…" : "Open admin"}
        </button>
      </form>
    </main>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Users;
  label: string;
  value: string | number;
}) {
  return (
    <article>
      <span><Icon size={18} /></span>
      <div>
        <strong>{value}</strong>
        <small>{label}</small>
      </div>
    </article>
  );
}

function UserLimitControl({
  user,
  onUpdated,
}: {
  user: AdminUser;
  onUpdated: () => Promise<void>;
}) {
  const [limit, setLimit] = useState(String(user.beta.applicationLimit));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(
    () => setLimit(String(user.beta.applicationLimit)),
    [user.beta.applicationLimit],
  );

  return (
    <div className="admin-limit-control">
      <label>
        Total limit
        <input
          aria-label={`Application limit for ${user.email || user.id}`}
          type="number"
          min={user.beta.applicationsUsed}
          max={10_000}
          value={limit}
          onChange={(event) => setLimit(event.target.value)}
        />
      </label>
      <button
        type="button"
        disabled={
          busy ||
          Number(limit) === user.beta.applicationLimit ||
          !Number.isSafeInteger(Number(limit))
        }
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            const response = await fetch(
              `/api/admin/users/${encodeURIComponent(user.id)}/application-limit`,
              {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ limit: Number(limit) }),
              },
            );
            if (!response.ok)
              throw new Error(await responseError(response));
            await onUpdated();
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Saving…" : "Set"}
      </button>
      {error && <em>{error}</em>}
    </div>
  );
}

function progressLabel(user: AdminUser) {
  if (user.applied > 0) return "Applied";
  if (user.applications > 0) return "Application filling";
  if (user.searchReadyJobs > 0) return "Jobs verified";
  if (user.jobsSeen > 0) return "Discovery";
  if (user.sources > 0) return "Evidence setup";
  return user.phase === "intake" ? "Profile setup" : user.phase;
}

function workflowLabel(user: AdminUser) {
  if (!user.latestWorkflow) return "No workflow yet";
  return `${user.latestWorkflow.type.replace(/-/g, " ")} · ${user.latestWorkflow.status}`;
}

function eventLabel(value: string) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) =>
    letter.toUpperCase()
  );
}

function formatDate(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
}

async function responseError(response: Response) {
  const body = await response.json().catch(() => ({})) as { error?: string };
  return body.error || `Request failed (${response.status})`;
}
