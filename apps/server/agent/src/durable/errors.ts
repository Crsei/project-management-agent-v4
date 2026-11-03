export class DurableError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 412 | 413 | 415 | 429 | 502 | 503;
  readonly code: string;
  constructor(status: DurableError["status"], code: string, message: string) {
    super(message);
    this.name = "DurableError";
    this.status = status;
    this.code = code;
  }
}
