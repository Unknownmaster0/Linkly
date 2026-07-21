/**
 * Typed fetch wrapper for the Fastify `api` server.
 *
 * Auth model (see docs/notes/DECISIONS.md #5):
 *   • access token  → returned in JSON, held in memory here (never persisted).
 *   • refresh token → httpOnly cookie bound to the api origin; the browser sends
 *                     it automatically on `credentials: "include"` requests.
 *
 * Responsibilities:
 *   • attach `Authorization: Bearer <accessToken>` + always send credentials;
 *   • unwrap the success envelope (`{ success, message, data }`) → returns `data`;
 *   • map any non-2xx to a typed {@link ApiError} from the `{ error, details?,
 *     retryAfter? }` body (headers aren't read — CORS doesn't expose them);
 *   • on 401, run a SINGLE-FLIGHT silent refresh and retry the request once.
 *     Only a FAILED refresh clears the token + notifies the app (→ login); a 401
 *     that SURVIVES a successful refresh is a business error (e.g. wrong password
 *     on account deletion), not an expired session, so it is surfaced as an
 *     ApiError rather than forcing a logout.
 */

import { API_BASE_URL } from "./config";
import type { ApiErrorBody, ApiSuccess, AuthData } from "./api-types";

// ── Typed error ──────────────────────────────────────────────────────────────

export class ApiError extends Error {
  readonly status: number;
  readonly details?: Record<string, unknown>;
  readonly retryAfter?: number;

  constructor(
    status: number,
    message: string,
    details?: Record<string, unknown>,
    retryAfter?: number,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    if (details !== undefined) this.details = details;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }

  /** Offending field name from a 400 validation error (`details.field`). */
  get field(): string | undefined {
    const value = this.details?.["field"];
    return typeof value === "string" ? value : undefined;
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }
}

// ── In-memory access token ───────────────────────────────────────────────────

let accessToken: string | null = null;

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

// ── App callbacks (wired once by AuthProvider) ───────────────────────────────

interface AuthCallbacks {
  /** Called whenever a refresh produces a fresh token + user. */
  onRefreshed?: (data: AuthData) => void;
  /** Called when the session can no longer be refreshed. */
  onUnauthorized?: () => void;
}

let callbacks: AuthCallbacks = {};

export function registerAuthCallbacks(next: AuthCallbacks): void {
  callbacks = next;
}

// ── Low-level fetch ──────────────────────────────────────────────────────────

interface FetchOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  /** Attach Bearer token + treat 401 as refreshable. Default: true. */
  auth?: boolean;
  signal?: AbortSignal;
}

async function rawFetch(path: string, opts: FetchOptions): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.auth !== false && accessToken) {
    headers["Authorization"] = `Bearer ${accessToken}`;
  }

  return fetch(`${API_BASE_URL}${path}`, {
    method: opts.method ?? "GET",
    headers,
    credentials: "include",
    cache: "no-store",
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal ?? null,
  });
}

// ── Single-flight silent refresh ─────────────────────────────────────────────

let refreshPromise: Promise<AuthData | null> | null = null;

/**
 * Refreshes the session using the httpOnly cookie. Concurrent callers share one
 * in-flight request (dedupes React StrictMode double-mounts and parallel 401s),
 * so each browser only ever fires one `/auth/refresh` at a time.
 */
export function performSilentRefresh(): Promise<AuthData | null> {
  if (!refreshPromise) {
    refreshPromise = doRefresh().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

async function doRefresh(): Promise<AuthData | null> {
  let res: Response;
  try {
    res = await rawFetch("/api/auth/refresh", { method: "POST", auth: false });
  } catch {
    return null; // network error → treat as logged-out
  }
  if (!res.ok) return null;

  try {
    const json = (await res.json()) as ApiSuccess<AuthData>;
    setAccessToken(json.data.accessToken);
    callbacks.onRefreshed?.(json.data);
    return json.data;
  } catch {
    return null;
  }
}

// ── Response handling ────────────────────────────────────────────────────────

const DEFAULT_MESSAGES: Record<number, string> = {
  400: "Invalid request.",
  401: "Your session has expired. Please sign in again.",
  403: "You don't have access to this resource.",
  404: "Not found.",
  409: "That conflicts with something that already exists.",
  410: "This link has expired or been deleted.",
  429: "Too many requests — please slow down.",
  500: "Something went wrong on our end. Please try again.",
};

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function handleResponse<T>(res: Response): Promise<T> {
  const text = await res.text();
  const json = text ? safeParse(text) : undefined;

  if (!res.ok) {
    const body = (json ?? {}) as ApiErrorBody;
    const message =
      body.error ??
      DEFAULT_MESSAGES[res.status] ??
      `Request failed (${res.status}).`;
    throw new ApiError(res.status, message, body.details, body.retryAfter);
  }

  // 204 / empty body → void
  if (json === undefined) return undefined as T;
  return (json as ApiSuccess<T>).data;
}

// ── Public entry point ───────────────────────────────────────────────────────

export async function apiFetch<T>(
  path: string,
  opts: FetchOptions = {},
): Promise<T> {
  let res = await rawFetch(path, opts);
  
  if (res.status === 401 && opts.auth !== false) {
    const refreshed = await performSilentRefresh();
    if (refreshed) {
      // Retry once with the fresh token. If it STILL 401s, this is NOT a token
      // problem — the successful refresh just proved the session is valid — so
      // it's a business 401 (e.g. a wrong password on DELETE /api/auth/account).
      // Let it fall through as a normal ApiError instead of forcing a logout.
      res = await rawFetch(path, opts);
    } else {
      // The refresh itself failed → the session is genuinely dead. Clear the
      // token and notify the app (→ redirect to login).
      setAccessToken(null);
      callbacks.onUnauthorized?.();
    }
  }

  return handleResponse<T>(res);
}
