import { useEffect, useRef, useState } from "react";

/**
 * "Continue with Google", via Google Identity Services.
 *
 * GIS renders its own button inside an iframe -- that's Google's branding
 * requirement, not a choice made here, and it's also what keeps this an
 * actual verifiable credential rather than a custom button we'd have to
 * trust blindly. The client id is public by design (it's the audience a
 * token is checked against, not a secret), so shipping it to the browser is
 * safe; nothing here can mint a session without the backend independently
 * verifying the token against Google.
 *
 * With no client id configured (e.g. this repo without Google credentials
 * set up yet), it degrades to a disabled button with an explanation instead
 * of silently doing nothing or throwing.
 */

const CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined)?.trim();

interface GoogleCredentialResponse {
  credential: string;
}

interface GoogleIdConfig {
  client_id: string;
  callback: (response: GoogleCredentialResponse) => void;
}

interface GoogleButtonOptions {
  type: "standard";
  theme: "outline";
  size: "large";
  shape: "rectangular";
  text: "continue_with";
  logo_alignment: "center";
  width: number;
}

interface GoogleAccountsId {
  initialize: (config: GoogleIdConfig) => void;
  renderButton: (parent: HTMLElement, options: GoogleButtonOptions) => void;
}

declare global {
  interface Window {
    google?: { accounts: { id: GoogleAccountsId } };
  }
}

let scriptPromise: Promise<void> | null = null;

function loadGoogleScript(): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve();
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      script.defer = true;
      script.onload = () => resolve();
      script.onerror = () => {
        scriptPromise = null;
        reject(new Error("load-failed"));
      };
      document.head.appendChild(script);
    });
  }
  return scriptPromise;
}

export function GoogleSignInButton({
  onCredential,
  onError,
}: {
  onCredential: (credential: string) => void;
  onError: (message: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState(false);

  // GIS is initialized exactly once (re-initializing on every render would
  // tear down its already-rendered button), so the latest callbacks are read
  // through a ref rather than joining the effect's dependency array.
  const callbacksRef = useRef({ onCredential, onError });
  useEffect(() => {
    callbacksRef.current = { onCredential, onError };
  });

  useEffect(() => {
    if (!CLIENT_ID) return;
    let cancelled = false;

    loadGoogleScript()
      .then(() => {
        const container = containerRef.current;
        if (cancelled || !container || !window.google) return;
        window.google.accounts.id.initialize({
          client_id: CLIENT_ID,
          callback: (response) => callbacksRef.current.onCredential(response.credential),
        });
        window.google.accounts.id.renderButton(container, {
          type: "standard",
          theme: "outline",
          size: "large",
          shape: "rectangular",
          text: "continue_with",
          logo_alignment: "center",
          width: Math.min(360, container.clientWidth || 360),
        });
        setRendered(true);
      })
      .catch(() => {
        if (!cancelled) {
          callbacksRef.current.onError(
            "Could not load Google Sign-In. Check your connection and try again.",
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (!CLIENT_ID) {
    return (
      <div>
        <button
          type="button"
          disabled
          aria-describedby="google-signin-unavailable"
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-line-strong bg-surface px-3.5 py-2.5 text-sm font-medium text-ink-400 disabled:cursor-not-allowed"
        >
          <GoogleMark />
          Continue with Google
        </button>
        <p id="google-signin-unavailable" className="mt-1.5 text-xs text-ink-400">
          Google sign-in isn&rsquo;t configured for this environment.
        </p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="flex w-full justify-center [&>div]:!w-full"
      aria-busy={!rendered}
    />
  );
}

function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9c1.7-1.57 2.7-3.88 2.7-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.96v2.33A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.95 10.7A5.4 5.4 0 0 1 3.67 9c0-.59.1-1.17.28-1.7V4.97H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.03l2.99-2.33Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.51.46 3.44 1.35l2.58-2.58A8.98 8.98 0 0 0 9 0 9 9 0 0 0 .96 4.97l2.99 2.33C4.66 5.17 6.65 3.58 9 3.58Z"
      />
    </svg>
  );
}
