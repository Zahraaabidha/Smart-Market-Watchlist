import { useId, useState } from "react";
import { Button } from "@/components/ui";
import { GoogleSignInButton } from "@/components/GoogleSignInButton";

export function SignIn({
  onSubmit,
  onGoogleCredential,
  error,
  busy,
  onModeChange,
}: {
  onSubmit: (email: string, password: string, mode: "login" | "register") => void;
  onGoogleCredential: (credential: string) => void;
  error: string | null;
  busy: boolean;
  onModeChange?: () => void;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [googleError, setGoogleError] = useState<string | null>(null);

  const emailId = useId();
  const passwordId = useId();

  const tooShort =
    mode === "register" && password.length > 0 && password.length < 8;

  const label = "mb-1.5 block text-xs font-medium text-ink-600";
  const field =
    "w-full rounded-lg border border-line-strong bg-surface px-3 py-2.5 text-sm text-ink-900 " +
    "placeholder:text-ink-400 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25";

  const shownError = error ?? googleError;

  return (
    <div className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      {/* Left: the one-line pitch, over a full-bleed video. The footage is
          dark, so white text sits directly on it with no scrim needed. */}
      <div className="relative hidden flex-col justify-between overflow-hidden border-r border-line p-12 lg:flex">
        <video
          src="/login_vid.mp4"
          autoPlay
          muted
          loop
          playsInline
          className="absolute inset-0 h-full w-full object-cover"
        />

        <div className="relative flex items-center gap-2 text-sm font-semibold text-white">
          <Mark />
          Groww Focus
        </div>
        <div className="relative">
          <h1 className="max-w-md text-3xl font-semibold leading-tight tracking-tight text-white">
            Don&rsquo;t scan the market. Know what changed.
          </h1>
          <p className="mt-4 max-w-sm text-sm leading-relaxed text-white/80">
            A brief that tells you what moved enough to matter while you were
            away, why it surfaced, and whether the data can be trusted.
          </p>
          <p className="mt-4 text-xs text-white/60">
            Deterministic replay market data. Not a live exchange feed.
          </p>
        </div>
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
          <p className="mt-1 text-sm text-black">
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
            <div>
              <label htmlFor={emailId} className={label}>
                Email
              </label>
              <input
                id={emailId}
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Email"
                className={field}
              />
            </div>

            <div>
              <label htmlFor={passwordId} className={label}>
                Password
              </label>
              <div className="relative">
                <input
                  id={passwordId}
                  type={showPassword ? "text" : "password"}
                  required
                  autoComplete={
                    mode === "login" ? "current-password" : "new-password"
                  }
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Password"
                  className={`${field} pr-10`}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  aria-pressed={showPassword}
                  className="absolute inset-y-0 right-0 flex items-center px-3 text-ink-400 transition-colors hover:text-ink-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded-r-lg"
                >
                  <EyeIcon open={showPassword} />
                </button>
              </div>
              {tooShort && (
                <p className="mt-1.5 text-xs text-sev-high">
                  Password must be at least 8 characters.
                </p>
              )}
            </div>

            {shownError && (
              <p
                role="alert"
                className="rounded-lg border border-sev-bg-critical bg-sev-bg-critical px-3 py-2 text-sm text-sev-critical"
              >
                {shownError}
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

          <div className="my-5 flex items-center gap-3" aria-hidden="true">
            <div className="h-px flex-1 bg-line" />
            <span className="text-xs font-medium text-ink-400">or</span>
            <div className="h-px flex-1 bg-line" />
          </div>

          <GoogleSignInButton
            onCredential={(credential) => {
              setGoogleError(null);
              onGoogleCredential(credential);
            }}
            onError={setGoogleError}
          />

          <button
            onClick={() => {
              setMode(mode === "login" ? "register" : "login");
              setGoogleError(null);
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

function EyeIcon({ open }: { open: boolean }) {
  if (open) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M1.5 8.5C2.7 5.6 5.1 4 8 4s5.3 1.6 6.5 4.5C13.3 11.4 10.9 13 8 13S2.7 11.4 1.5 8.5Z"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
        <circle cx="8" cy="8.5" r="1.8" stroke="currentColor" strokeWidth="1.3" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M1.5 8.5C2.7 5.6 5.1 4 8 4s5.3 1.6 6.5 4.5C13.3 11.4 10.9 13 8 13S2.7 11.4 1.5 8.5Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M2.5 2.5l11 11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
