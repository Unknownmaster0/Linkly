export class AppError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(404, 'NOT_FOUND', message);
  }
}

export class GoneError extends AppError {
  // Default matches ERROR_CONTRACT.md §410 and the redirect OpenAPI schema exactly.
  // The contract deliberately uses ONE body for both expiry and soft-delete so the
  // 410 never leaks which reason applies — keep all call sites on this default.
  constructor(message = 'Short URL expired or deleted') {
    super(410, 'GONE', message);
  }
}

export class LegalError extends AppError {
  constructor(message = 'URL unavailable for legal reasons') {
    super(451, 'UNAVAILABLE_FOR_LEGAL_REASONS', message);
  }
}

export class RateLimitError extends AppError {
  readonly retryAfter: number;

  constructor(retryAfter: number) {
    super(429, 'RATE_LIMIT_EXCEEDED', 'Rate limit exceeded');
    this.retryAfter = retryAfter;
  }
}