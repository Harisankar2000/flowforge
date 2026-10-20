/**
 * Base class for errors that map to a well-defined HTTP response.
 * Anything that is not an AppError is treated as an unexpected 500.
 */
export class AppError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 400, 'BAD_REQUEST', details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Missing or invalid API key') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id: string) {
    super(`${resource} '${id}' was not found`, 404, 'NOT_FOUND');
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, 'CONFLICT');
  }
}

/** Includes the root cause, e.g. "fetch failed: getaddrinfo ENOTFOUND api.test". */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.cause instanceof Error
      ? `${error.message}: ${getErrorMessage(error.cause)}`
      : error.message;
  }
  return typeof error === 'string' ? error : JSON.stringify(error);
}
