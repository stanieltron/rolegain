import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  createClient,
  type Session,
  type SupabaseClient,
} from "@supabase/supabase-js";

const authMode = import.meta.env.VITE_ROLEGAIN_AUTH_MODE || "local";
const supabase =
  authMode === "supabase"
    ? createClient(
        requiredEnvironment("VITE_SUPABASE_URL"),
        requiredEnvironment("VITE_SUPABASE_PUBLISHABLE_KEY"),
      )
    : undefined;

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

  if (!supabase) return children;
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
    <>
      <button
        className="auth-sign-out"
        type="button"
        onClick={() => void supabase.auth.signOut()}
      >
        Sign out
      </button>
      <UsageBadge />
      {children}
    </>
  );
}

function UsageBadge() {
  const [tokens, setTokens] = useState<number>();

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const response = await fetch("/api/usage", {
        headers: await authorizationHeader(),
      });
      if (!response.ok || !active) return;
      const body = (await response.json()) as { totalTokens?: number };
      if (active) setTokens(body.totalTokens ?? 0);
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div className="auth-usage" title="Total LLM tokens used">
      {tokens === undefined ? "Tokens: ..." : `Tokens: ${tokens.toLocaleString()}`}
    </div>
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
    <main className="auth-shell">
      <section className="auth-card">
        <div className="auth-brand">RolegAIn</div>
        <h1>{mode === "sign-in" ? "Welcome back" : "Create your account"}</h1>
        <p>Evidence-backed job search and application preparation.</p>
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
      </section>
    </main>
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
    <main className="auth-shell">
      <section className="auth-card">
        <div className="auth-brand">RolegAIn</div>
        <h1>Choose a new password</h1>
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
      </section>
    </main>
  );
}

function requiredEnvironment(name: keyof ImportMetaEnv) {
  const value = import.meta.env[name];
  if (!value) throw new Error(`${name} is required for Supabase authentication`);
  return value;
}
