type YimsgErrorKind =
  | 'precondition'
  | 'validation'
  | 'auth'
  | 'connection'
  | 'request'
  | 'protocol'
  | 'storage';

type YimsgErrorCode =
  | 'AUTH_REQUIRED'
  | 'SESSION_NOT_INITIALIZED'
  | 'INVALID_ARGUMENT'
  | 'AUTH_FAILED'
  | 'CONNECTION_FAILED'
  | 'CONNECTION_TIMEOUT'
  | 'REQUEST_FAILED'
  | 'INVALID_RESPONSE'
  | 'UPLOAD_FAILED'
  | 'STORAGE_UNSUPPORTED'
  | 'STORAGE_FAILED';

interface YimsgErrorOptions {
  cause?: unknown;
  context?: string;
  details?: Record<string, unknown>;
}

export class YimsgError extends Error {
  readonly kind: YimsgErrorKind;
  readonly code: YimsgErrorCode;
  readonly context?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    kind: YimsgErrorKind,
    code: YimsgErrorCode,
    message: string,
    options: YimsgErrorOptions = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.kind = kind;
    this.code = code;
    this.context = options.context;
    this.details = options.details;
    if (options.cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        configurable: true,
        enumerable: false,
        writable: true,
        value: options.cause,
      });
    }
  }
}

export class PreconditionError extends YimsgError {
  constructor(code: Extract<YimsgErrorCode, 'AUTH_REQUIRED' | 'SESSION_NOT_INITIALIZED'>, message: string, options: YimsgErrorOptions = {}) {
    super('precondition', code, message, options);
  }
}

export class ValidationError extends YimsgError {
  constructor(message: string, options: YimsgErrorOptions = {}) {
    super('validation', 'INVALID_ARGUMENT', message, options);
  }
}

export class AuthError extends YimsgError {
  constructor(message: string, options: YimsgErrorOptions = {}) {
    super('auth', 'AUTH_FAILED', message, options);
  }
}

export class ConnectionError extends YimsgError {
  constructor(
    code: Extract<YimsgErrorCode, 'CONNECTION_FAILED' | 'CONNECTION_TIMEOUT'>,
    message: string,
    options: YimsgErrorOptions = {},
  ) {
    super('connection', code, message, options);
  }
}

export class RequestError extends YimsgError {
  constructor(
    code: Extract<YimsgErrorCode, 'REQUEST_FAILED' | 'UPLOAD_FAILED'>,
    message: string,
    options: YimsgErrorOptions = {},
  ) {
    super('request', code, message, options);
  }
}

export class ProtocolValidationError extends YimsgError {
  constructor(message: string, options: YimsgErrorOptions = {}) {
    super('protocol', 'INVALID_RESPONSE', message, options);
  }
}

export class StorageModeError extends YimsgError {
  constructor(
    code: Extract<YimsgErrorCode, 'STORAGE_UNSUPPORTED' | 'STORAGE_FAILED'>,
    message: string,
    options: YimsgErrorOptions = {},
  ) {
    super('storage', code, message, options);
  }
}

export function isYimsgError(error: unknown): error is YimsgError {
  return error instanceof YimsgError;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error ?? 'unknown error');
}

export function wrapError(error: unknown, fallback: YimsgError): YimsgError {
  if (isYimsgError(error)) return error;
  const message = errorMessage(error);
  switch (fallback.kind) {
    case 'precondition':
      return new PreconditionError(
        fallback.code as Extract<YimsgErrorCode, 'AUTH_REQUIRED' | 'SESSION_NOT_INITIALIZED'>,
        fallback.message,
        { cause: error, context: fallback.context, details: fallback.details },
      );
    case 'validation':
      return new ValidationError(fallback.message, { cause: error, context: fallback.context, details: fallback.details });
    case 'auth':
      return new AuthError(fallback.message || message, { cause: error, context: fallback.context, details: fallback.details });
    case 'connection':
      return new ConnectionError(
        fallback.code as Extract<YimsgErrorCode, 'CONNECTION_FAILED' | 'CONNECTION_TIMEOUT'>,
        fallback.message || message,
        { cause: error, context: fallback.context, details: fallback.details },
      );
    case 'request':
      return new RequestError(
        fallback.code as Extract<YimsgErrorCode, 'REQUEST_FAILED' | 'UPLOAD_FAILED'>,
        fallback.message || message,
        { cause: error, context: fallback.context, details: fallback.details },
      );
    case 'protocol':
      return new ProtocolValidationError(fallback.message || message, {
        cause: error,
        context: fallback.context,
        details: fallback.details,
      });
    case 'storage':
      return new StorageModeError(
        fallback.code as Extract<YimsgErrorCode, 'STORAGE_UNSUPPORTED' | 'STORAGE_FAILED'>,
        fallback.message || message,
        { cause: error, context: fallback.context, details: fallback.details },
      );
  }
}

export function isConnectionIssue(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    message === 'not connected'
    || message === 'disconnected'
    || message === 'connection closed'
    || message === 'connect timeout'
    || message === 'request timeout'
  );
}

export function isServerErrorCode(error: unknown, code: string): boolean {
  return isYimsgError(error) && error.kind === 'request' && error.details?.serverErrorCode === code;
}
