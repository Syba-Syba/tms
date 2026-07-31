export class AppError extends Error {
  constructor(
    message: string,
    public status = 500,
    public code = 'internal_error',
    public details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad request.', details?: unknown) {
    super(message, 400, 'bad_request', details);
  }
}

export class UnauthorisedError extends AppError {
  constructor(message = 'Not authenticated.') {
    super(message, 401, 'unauthorised');
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Not allowed.') {
    super(message, 403, 'forbidden');
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found.`, 404, 'not_found');
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflicting change.') {
    super(message, 409, 'conflict');
  }
}
