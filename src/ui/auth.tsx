import {
  createContext,
  useContext,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  createClient,
  type Session,
  type SupabaseClient,
} from "@supabase/supabase-js";
import {
  ArrowRight,
  BadgeCheck,
  BookOpenCheck,
  BriefcaseBusiness,
  CheckCircle2,
  FileCheck2,
  ListChecks,
  LockKeyhole,
  SearchCheck,
  Sparkles,
} from "lucide-react";

const authMode = import.meta.env.VITE_ROLEGAIN_AUTH_MODE || "local";
const supabase =
  authMode === "supabase"
    ? createClient(
        requiredEnvironment("VITE_SUPABASE_URL"),
        requiredEnvironment("VITE_SUPABASE_PUBLISHABLE_KEY"),
      )
    : undefined;

type AuthActions = {
  signOut: () => void;
};

const AuthActionsContext = createContext<AuthActions | undefined>(undefined);
const localSessionKey = "rolegain.local-session";

export function useAuthActions() {
  return useContext(AuthActionsContext);
}

export async function authorizationHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(
    supabase ? undefined : null,
  );
  const [recovering, setRecovering] = useState(false);

  useEffect(() => {
    if (!supabase) return;
    void supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((event, next) => {
      setSession(next);
      if (event === "PASSWORD_RECOVERY") setRecovering(true);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  if (!supabase) return <LocalAuthGate>{children}</LocalAuthGate>;
  if (session === undefined)
    return <main className="auth-shell">Loading Rolegain...</main>;
  if (!session) return <Login client={supabase} />;
  if (recovering)
    return (
      <PasswordRecovery
        client={supabase}
        onComplete={() => setRecovering(false)}
      />
    );
  return (
    <AuthActionsContext.Provider
      value={{ signOut: () => void supabase.auth.signOut() }}
    >
      {children}
    </AuthActionsContext.Provider>
  );
}

function LocalAuthGate({ children }: { children: ReactNode }) {
  const [signedIn, setSignedIn] = useState(
    () =>
      typeof window !== "undefined" &&
      window.localStorage.getItem(localSessionKey) === "active",
  );

  if (!signedIn)
    return (
      <LocalLogin
        onSignIn={() => {
          window.localStorage.setItem(localSessionKey, "active");
          setSignedIn(true);
        }}
      />
    );

  return (
    <AuthActionsContext.Provider
      value={{
        signOut: () => {
          window.localStorage.removeItem(localSessionKey);
          setSignedIn(false);
        },
      }}
    >
      {children}
    </AuthActionsContext.Provider>
  );
}

function LocalLogin({ onSignIn }: { onSignIn: () => void }) {
  return (
    <AuthLayout
      eyebrow="Local preview"
      title="Welcome back"
      description="Open the single local test workspace and review Rolegain before it goes online."
    >
      <div className="auth-local-account">
        <div className="auth-account-icon">
          <BriefcaseBusiness size={20} />
        </div>
        <div>
          <strong>Local user</strong>
          <span>local@rolegain.invalid</span>
        </div>
      </div>
      <button className="auth-primary" type="button" onClick={onSignIn}>
        Enter local workspace
        <ArrowRight size={17} />
      </button>
      <p className="auth-local-note">
        <LockKeyhole size={14} />
        Local preview only. This is not a production authentication method.
      </p>
    </AuthLayout>
  );
}

function Login({ client }: { client: SupabaseClient }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    const result =
      mode === "sign-up"
        ? await client.auth.signUp({ email, password })
        : await client.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (result.error) setMessage(result.error.message);
    else if (mode === "sign-up" && !result.data.session)
      setMessage("Check your email to confirm your account.");
  };

  return (
    <AuthLayout
      eyebrow={mode === "sign-in" ? "Candidate login" : "New candidate"}
      title={mode === "sign-in" ? "Welcome back" : "Create your account"}
      description="Sign in to continue your evidence-backed job search and application preparation."
    >
        <button
          className="auth-google"
          type="button"
          onClick={() =>
            void client.auth.signInWithOAuth({
              provider: "google",
              options: { redirectTo: window.location.origin },
            })
          }
        >
          Continue with Google
        </button>
        <div className="auth-divider">or</div>
        <form onSubmit={(event) => void submit(event)}>
          <label>
            Email
            <input
              autoComplete="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>
          <label>
            Password
            <input
              autoComplete={
                mode === "sign-in" ? "current-password" : "new-password"
              }
              type="password"
              minLength={8}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          {message && <p className="auth-message">{message}</p>}
          <button type="submit" disabled={busy}>
            {busy
              ? "Please wait..."
              : mode === "sign-in"
                ? "Sign in"
                : "Create account"}
          </button>
        </form>
        {mode === "sign-in" && (
          <button
            className="auth-switch"
            type="button"
            disabled={!email || busy}
            onClick={async () => {
              setBusy(true);
              const result = await client.auth.resetPasswordForEmail(email, {
                redirectTo: window.location.origin,
              });
              setBusy(false);
              setMessage(
                result.error
                  ? result.error.message
                  : "Check your email for a password-reset link.",
              );
            }}
          >
            Forgot password?
          </button>
        )}
        <button
          className="auth-switch"
          type="button"
          onClick={() =>
            setMode((current) =>
              current === "sign-in" ? "sign-up" : "sign-in",
            )
          }
        >
          {mode === "sign-in"
            ? "Need an account? Sign up"
            : "Already have an account? Sign in"}
        </button>
    </AuthLayout>
  );
}

function PasswordRecovery({
  client,
  onComplete,
}: {
  client: SupabaseClient;
  onComplete: () => void;
}) {
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  return (
    <AuthLayout
      eyebrow="Account recovery"
      title="Choose a new password"
      description="Set a new password to regain access to your Rolegain workspace."
    >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void client.auth.updateUser({ password }).then(({ error }) => {
              if (error) setMessage(error.message);
              else onComplete();
            });
          }}
        >
          <label>
            New password
            <input
              autoComplete="new-password"
              type="password"
              minLength={8}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          {message && <p className="auth-message">{message}</p>}
          <button type="submit">Update password</button>
        </form>
    </AuthLayout>
  );
}

function AuthLayout({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <main className="auth-shell">
      <section className="auth-frame">
        <aside className="auth-story">
          <div className="auth-brand">
            <Sparkles size={17} />
            RolegAIn
          </div>
          <div className="auth-story-copy">
            <span>Evidence-backed job search</span>
            <h2>Your experience is the advantage. Put it to work.</h2>
            <p>
              RolegAIn turns the work you have already done into a verified
              candidate knowledge base, then uses it to find and prepare better
              opportunities.
            </p>
          </div>
          <div className="auth-proof">
            <CheckCircle2 size={16} />
            Grounded in your evidence. Controlled by you.
          </div>
        </aside>
        <section className="auth-card">
          <header className="auth-intro">
            <span className="auth-eyebrow">From evidence to application</span>
            <h1>A job search that actually knows your work.</h1>
            <p>
              Build your profile once. RolegAIn carries the evidence through
              discovery, matching and application preparation.
            </p>
          </header>

          <div className="auth-journey">
            <article>
              <span className="auth-step-icon">
                <BookOpenCheck size={18} />
              </span>
              <div>
                <small>01 · Build your knowledge base</small>
                <h3>Bring the evidence</h3>
                <p>
                  Add your CV, local repositories, GitHub, portfolio, work
                  documents or webpages. RolegAIn reads every source, extracts
                  achievements and builds a provenance-checked candidate
                  knowledge base.
                </p>
              </div>
            </article>

            <article>
              <span className="auth-step-icon">
                <SearchCheck size={18} />
              </span>
              <div>
                <small>02 · Discover verified roles</small>
                <h3>Search deeper, waste less time</h3>
                <p>
                  Your evidence guides focused public-web searches. Concrete
                  vacancies are reopened and verified, while expired,
                  unsuitable or unverifiable listings stay out of your
                  shortlist.
                </p>
              </div>
            </article>

            <article>
              <span className="auth-step-icon">
                <ListChecks size={18} />
              </span>
              <div>
                <small>03 · Match requirement by requirement</small>
                <h3>Know where you really fit</h3>
                <p>
                  Each job requirement is matched against canonical evidence,
                  independently checked and scored. Roles are sorted by
                  supported fit, with genuine gaps kept visible.
                </p>
              </div>
            </article>

            <article>
              <span className="auth-step-icon">
                <FileCheck2 size={18} />
              </span>
              <div>
                <small>04 · Prepare the application</small>
                <h3>Review, then submit</h3>
                <p>
                  RolegAIn researches company context, drafts a grounded cover
                  letter and answers, can tailor a job-specific CV, and prefills
                  the inspected form. You make the final review and submission.
                </p>
              </div>
            </article>
          </div>

          <div className="auth-control-note">
            <BadgeCheck size={16} />
            Nothing is invented, and nothing is submitted without you.
          </div>

          <section className="auth-access">
            <span className="auth-eyebrow">{eyebrow}</span>
            <h2>{title}</h2>
            <p>{description}</p>
            {children}
          </section>
        </section>
      </section>
    </main>
  );
}

function requiredEnvironment(name: keyof ImportMetaEnv) {
  const value = import.meta.env[name];
  if (!value) throw new Error(`${name} is required for Supabase authentication`);
  return value;
}
