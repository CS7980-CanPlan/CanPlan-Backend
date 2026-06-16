// Helpers for returning structured errors from AppSync Lambda resolvers.
// AppSync surfaces the message in the GraphQL `errors` array.

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** Caller is authenticated but lacks the required role/group (e.g. SystemAdmin). */
export class UnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnauthorizedError';
  }
}
