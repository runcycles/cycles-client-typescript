/** Internal constants for the Cycles client. */

export const API_KEY_HEADER = "X-Cycles-API-Key";
export const IDEMPOTENCY_KEY_HEADER = "X-Idempotency-Key";
export const REQUEST_ID_HEADER = "X-Request-Id";

export const DEFAULT_CONNECT_TIMEOUT = 2_000;
export const DEFAULT_READ_TIMEOUT = 5_000;
export const DEFAULT_TTL_MS = 60_000;
export const DEFAULT_GRACE_PERIOD_MS = 5_000;
export const DEFAULT_OVERAGE_POLICY = "REJECT";
export const DEFAULT_UNIT = "USD_MICROCENTS";

export const RESERVATIONS_PATH = "/v1/reservations";
export const DECIDE_PATH = "/v1/decide";
export const BALANCES_PATH = "/v1/balances";
export const EVENTS_PATH = "/v1/events";
