import { useState } from "react";
import { Button } from "@/components/ui";

export function SignIn({
  onSubmit,
  error,
  busy,
  onModeChange,
}: {
  onSubmit: (email: string, password: string, mode: "login" | "register") => void;
  error: string | null;
  busy: boolean;
  onModeChange?: () => void;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const tooShort =
    mode === "register" && password.length > 0 && password.length < 8;

  const field =
    "w-full rounded-lg border border-line-strong bg-surface px-3 py-2.5 text-sm text-ink-900 " +
    "placeholder:text-ink-400 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25";

  return (
    <div className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      {/* Left: the one-line pitch. Not a marketing page. */}
      <div className="hidden flex-col justify-between border-r border-line bg-surface p-12 lg:flex">
        <div className="flex items-center gap-2 text-sm font-semibold text-ink-900">
          <Mark />
          Groww Focus
        </div>
        <div>
          <h1 className="max-w-md text-3xl font-semibold leading-tight tracking-tight text-ink-900">
            Don&rsquo;t scan the market. Know what changed.
          </h1>
          <p className="mt-4 max-w-sm text-sm leading-relaxed text-ink-500">
            A brief that tells you what moved enough to matter while you were
            away, why it surfaced, and whether the data can be trusted.
          </p>
        </div>
        <p className="text-xs text-ink-400">
          Deterministic replay market data. Not a live exchange feed.
        </p>
      </div>

      {/* Right: the form */}
      <div className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2 text-sm font-semibold text-ink-900 lg:hidden">
            <Mark />
            Groww Focus
          </div>

          <h2 className="text-lg font-semibold tracking-tight text-ink-900">
            {mode === "login" ? "Sign in" : "Create your account"}
          </h2>
          <p className="mt-1 text-sm text-ink-500">
            {mode === "login"
              ? "Pick up where the market left you."
              : "Comes with a starter watchlist, so the brief is never empty."}
          </p>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!tooShort) onSubmit(email, password, mode);
            }}
            className="mt-6 space-y-3"
          >
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email"
              className={field}
            />
            <div>
              <input
                type="password"
                required
                autoComplete={
                  mode === "login" ? "current-password" : "new-password"
                }
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                className={field}
              />
              {tooShort && (
                <p className="mt-1.5 text-xs text-sev-high">
                  Password must be at least 8 characters.
                </p>
              )}
            </div>

            {error && (
              <p className="rounded-lg border border-sev-bg-critical bg-sev-bg-critical px-3 py-2 text-sm text-sev-critical">
                {error}
              </p>
            )}

            <Button
              type="submit"
              variant="primary"
              disabled={busy || tooShort}
              className="w-full"
            >
              {busy
                ? "Working…"
                : mode === "login"
                  ? "Sign in"
                  : "Create account"}
            </Button>
          </form>

          <button
            onClick={() => {
              setMode(mode === "login" ? "register" : "login");
              onModeChange?.();
            }}
            className="mt-4 text-xs font-medium text-ink-500 transition-colors hover:text-ink-700"
          >
            {mode === "login"
              ? "No account? Create one →"
              : "Already have an account? Sign in →"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Mark() {
  return (
    <span className="grid h-6 w-6 place-items-center rounded-md bg-ink-900 text-white">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
        <path
          d="M2 11.5 6 6l3 3 5-7"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}
