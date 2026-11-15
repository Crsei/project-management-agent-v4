export type SteeringAttempt = { id: string; generationId: string; text: string };

/** Only server responses proving rejection BEFORE native dispatch can release the at-most-once lock. */
const rejectedBeforeDispatch: Readonly<Record<string, number>> = {
  stale_execution: 409,
  unsupported_steering: 409,
  confirmation_required: 400,
  managed_session: 409,
  actor_changed: 403,
  invalid_request: 400,
  not_found: 404,
  thread_deleted: 409,
  execution_environment_changed: 409,
  execution_binding_changed: 409,
  session_cutover_required: 412,
  execution_environment_required: 412,
  code_environment_required: 412,
  pm_reference_forbidden: 403,
};
export function steeringAttemptAfterError(attempt: SteeringAttempt, error: unknown): SteeringAttempt | null {
  if (typeof error !== "object" || error === null || !("code" in error) || !("status" in error)) return attempt;
  return typeof error.code === "string" && Object.hasOwn(rejectedBeforeDispatch, error.code) && error.status === rejectedBeforeDispatch[error.code] ? null : attempt;
}
