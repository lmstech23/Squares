// Merch domain errors carry a stable code and the HTTP status a route returns.
// Messages are written for the supporter or host who will read them.

export type MerchErrorCode =
  | "NOT_FOUND"
  | "CLOSED"
  | "INVALID_INPUT"
  | "OUT_OF_STOCK"
  | "OVER_LIMIT"
  | "DUPLICATE_FREE_ORDER"
  | "TOO_MANY_PENDING"
  | "RATE_LIMITED"
  | "PAYMENTS_NOT_READY"
  | "FORBIDDEN"
  | "CONFLICT";

const STATUS: Record<MerchErrorCode, number> = {
  NOT_FOUND: 404,
  CLOSED: 409,
  INVALID_INPUT: 400,
  OUT_OF_STOCK: 409,
  OVER_LIMIT: 400,
  DUPLICATE_FREE_ORDER: 409,
  TOO_MANY_PENDING: 429,
  RATE_LIMITED: 429,
  PAYMENTS_NOT_READY: 409,
  FORBIDDEN: 403,
  CONFLICT: 409,
};

export class MerchError extends Error {
  readonly code: MerchErrorCode;
  readonly status: number;
  constructor(code: MerchErrorCode, message: string) {
    super(message);
    this.name = "MerchError";
    this.code = code;
    this.status = STATUS[code];
  }
}

export function isMerchError(e: unknown): e is MerchError {
  return e instanceof MerchError;
}
