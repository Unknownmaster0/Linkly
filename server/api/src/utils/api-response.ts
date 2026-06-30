// ─────────────────────────────────────────────────────────────────────────────
// API Response envelope
// Two canonical shapes, each built in exactly one place:
//   • Success  → `successResponse(...)`, called by route handlers.
//   • Error    → `errorResponse(...)` / `rateLimitResponse(...)`, called ONLY by
//                the global error handler in app.ts. Routes/middleware throw an
//                AppError; they never build the error envelope themselves.
// No ad-hoc JSON objects anywhere.
// ─────────────────────────────────────────────────────────────────────────────

export interface ApiSuccess<T> {
  success: true;
  message: string;
  data: T;
}

// Error envelope per ERROR_CONTRACT.md — { error, details?, retryAfter? }, no extra keys
export interface ApiError {
  error: string;
  details?: Record<string, unknown>;
  retryAfter?: number;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

// ─────────────────────────────────────────────────────────────────────────────
// Builders — use these in route handlers, never construct the shape manually
// ─────────────────────────────────────────────────────────────────────────────

export function successResponse<T>(message: string, data: T): ApiSuccess<T> {
  return { success: true, message, data };
}

export function errorResponse(
  message: string,
  details?: Record<string, unknown>
): ApiError {
  if (details !== undefined) {
    return { error: message, details };
  }
  return { error: message };
}

export function rateLimitResponse(retryAfterSeconds: number): ApiError {
  return { error: 'Rate limit exceeded', retryAfter: retryAfterSeconds };
}
