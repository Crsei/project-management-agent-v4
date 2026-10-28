export class DurableError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 412 | 503;
  readonly code: string;
  constructor(status: 400 | 401 | 403 | 404 | 409 | 412 | 503, code: string, message: string) {
    super(message);
    this.name = "DurableError";
    this.status = status;
    this.code = code;
  }
}
