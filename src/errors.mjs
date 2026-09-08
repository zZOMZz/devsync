export class SyncError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "SyncError";
    this.code = code;
    this.details = details;
  }
}
export function errorResult(error) {
  return {
    code: error.code || (error.field ? `SSH_${error.field.toUpperCase()}` : "SYNC_FAILED"),
    message: error.message,
    ...(error.details ? { details: error.details } : {}),
  };
}
