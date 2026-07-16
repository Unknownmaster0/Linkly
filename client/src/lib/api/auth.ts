/** Auth endpoints (server/api/src/routes/auth.ts). */

import { apiFetch, performSilentRefresh } from "../api-client";
import type { AuthData, RegisterInput } from "../api-types";

/** `POST /api/auth/login` — 401 here means bad credentials, not an expired token. */
export function login(email: string, password: string): Promise<AuthData> {
  return apiFetch<AuthData>("/api/auth/login", {
    method: "POST",
    body: { email, password },
    auth: false,
  });
}

/** `POST /api/auth/register` — also sets the refresh cookie. */
export function register(input: RegisterInput): Promise<AuthData> {
  return apiFetch<AuthData>("/api/auth/register", {
    method: "POST",
    body: input,
    auth: false,
  });
}

/** `POST /api/auth/logout` — revokes the refresh token + clears the cookie. */
export function logout(): Promise<void> {
  return apiFetch<void>("/api/auth/logout", { method: "POST" });
}

/**
 * `DELETE /api/auth/account` — anonymizes the account and soft-deletes all
 * owned URLs. Requires the current password. Clears the refresh cookie.
 */
export function deleteAccount(password: string): Promise<void> {
  return apiFetch<void>("/api/auth/account", {
    method: "DELETE",
    body: { password },
  });
}

/** `POST /api/auth/refresh` — silent, single-flight (see api-client). */
export const refreshSession = performSilentRefresh;
