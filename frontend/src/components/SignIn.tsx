import { useState } from "react";

export function SignIn({
  onSubmit,
  error,
  busy,
}: {
  onSubmit: (email: string, password: string, mode: "login" | "register") => void;
  error: string | null;
  busy: boolean;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const tooShort = mode === "register" && password.length > 0 && password.length < 8;

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-xl font-semibold tracking-tight text-slate-100">
          Smart Market Watchlist
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Tells you what changed enough to matter.
        </p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!tooShort) onSubmit(email, password, mode);
          }}
          className="mt-8 space-y-3"
        >
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            className="w-full bg-ink-900 border border-ink-700 rounded px-3 py-2 text-sm
                       placeholder:text-slate-600 focus:outline-none focus:border-ink-600"
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
              className="w-full bg-ink-900 border border-ink-700 rounded px-3 py-2 text-sm
                         placeholder:text-slate-600 focus:outline-none focus:border-ink-600"
            />
            {tooShort && (
              <p className="mt-1 text-xs text-amber-400">
                Password must be at least 8 characters.
              </p>
            )}
          </div>

          {error && (
            <p className="text-sm text-rose-400 bg-rose-950/30 border border-rose-900/50 rounded px-3 py-2">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy || tooShort}
            className="w-full py-2 rounded bg-slate-200 text-ink-950 text-sm font-medium
                       hover:bg-white disabled:opacity-40 transition-colors"
          >
            {busy
              ? "Working…"
              : mode === "login"
                ? "Sign in"
                : "Create account"}
          </button>
        </form>

        <button
          onClick={() => setMode(mode === "login" ? "register" : "login")}
          className="mt-4 text-xs text-slate-500 hover:text-slate-300"
        >
          {mode === "login"
            ? "No account? Create one — it comes with a starter watchlist."
            : "Already have an account? Sign in."}
        </button>
      </div>
    </div>
  );
}
