export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly context?: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    context?: Record<string, unknown>
  ) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
    if (context !== undefined) {
      this.context = context;
    }
  }
}

export class ValidationError extends AppError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(400, 'VALIDATION_FAILED', message, context);
  }
}

export class AuthError extends AppError {
  constructor(message = 'Unauthorized') {
    super(401, 'UNAUTHORIZED', message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(404, 'NOT_FOUND', message);
  }
}

// Ownership mismatch → always 404, never 403 (IDOR prevention)
export class OwnershipError extends AppError {
  constructor() {
    super(404, 'NOT_FOUND', 'Not found');
  }
}

export class ConflictError extends AppError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(409, 'CONFLICT', message, context);
  }
}

export class BusinessRuleError extends AppError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(409, 'BUSINESS_RULE_VIOLATED', message, context);
  }
}

export class RateLimitError extends AppError {
  readonly retryAfter: number;

  constructor(retryAfter: number) {
    super(429, 'RATE_LIMIT_EXCEEDED', 'Rate limit exceeded');
    this.retryAfter = retryAfter;
  }
}
