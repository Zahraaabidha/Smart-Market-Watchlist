import type {
  Brief,
  Item,
  MarketSource,
  Preferences,
  SymbolPathDetail,
  TimelineEntry,
  Watchlist,
} from "./types";

const TOKEN_KEY = "smw.token";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    // Private-mode browsers throw on storage access. The app still works for
    // the session; the user just has to sign in again next time.
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token === null) localStorage.removeItem(TOKEN_KEY);
    else localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* non-fatal, see getToken */
  }
}

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = getToken();
  let response: Response;

  try {
    response = await fetch(`/api${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    });
  } catch {
    // Distinguish "the network failed" from "the server said no". The UI
    // shows a different message for each, because only one is retryable by
    // the user doing nothing.
    throw new ApiError(0, "Cannot reach the server. Check your connection.");
  }

  // A 401 with no token attached is a rejected login attempt, not an expired
  // session - surface the backend's actual message (e.g. "invalid email or
  // password") instead of claiming a session that never existed just ended.
  if (response.status === 401 && token) {
    setToken(null);
    throw new ApiError(401, "Your session expired. Please sign in again.");
  }

  if (!response.ok) {
    let detail = `Request failed (${response.status})`;
    try {
      const body = await response.json();
      if (typeof body?.detail === "string") detail = body.detail;
    } catch {
      /* keep the generic message */
    }
    throw new ApiError(response.status, detail);
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  register: (email: string, password: string) =>
    request<{ access_token: string }>("/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  login: (email: string, password: string) =>
    request<{ access_token: string }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  googleLogin: (credential: string) =>
    request<{ access_token: string }>("/auth/google", {
      method: "POST",
      body: JSON.stringify({ credential }),
    }),

  me: () => request<{ id: number; email: string }>("/auth/me"),

  watchlists: () => request<Watchlist[]>("/watchlists"),

  brief: (id: number) => request<Brief>(`/watchlists/${id}/brief`),

  path: (id: number, symbol: string) =>
    request<SymbolPathDetail>(
      `/watchlists/${id}/path/${encodeURIComponent(symbol)}`,
    ),

  marketSource: () => request<MarketSource>("/market/source"),

  demoReplay: () =>
    request<{ checked_at: string; returned_at: string; away_for: string }>(
      "/demo/replay",
      { method: "POST" },
    ),

  demoProvider: (mode: "replay" | "failing" | "live") =>
    request<MarketSource>("/demo/provider", {
      method: "POST",
      body: JSON.stringify({ mode }),
    }),

  timeline: (id: number, limit = 50) =>
    request<TimelineEntry[]>(`/watchlists/${id}/timeline?limit=${limit}`),

  checkpoint: (id: number, idempotencyKey: string) =>
    request<{ id: number; checked_at: string }>(
      `/watchlists/${id}/checkpoint`,
      {
        method: "POST",
        body: JSON.stringify({ idempotency_key: idempotencyKey }),
      },
    ),

  addItem: (
    id: number,
    body: {
      symbol: string;
      priority?: number;
      threshold_above?: string | null;
      threshold_below?: string | null;
    },
  ) =>
    request<Item>(`/watchlists/${id}/items`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  updateItem: (
    id: number,
    itemId: number,
    body: Partial<{ priority: number; threshold_above: string | null; threshold_below: string | null }>,
  ) =>
    request<Item>(`/watchlists/${id}/items/${itemId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  removeItem: (id: number, itemId: number) =>
    request<void>(`/watchlists/${id}/items/${itemId}`, { method: "DELETE" }),

  reorder: (id: number, itemIds: number[]) =>
    request<Item[]>(`/watchlists/${id}/order`, {
      method: "PUT",
      body: JSON.stringify({ item_ids: itemIds }),
    }),

  preferences: () => request<Preferences>("/preferences"),

  updatePreferences: (body: Partial<Preferences>) =>
    request<Preferences>("/preferences", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
};
