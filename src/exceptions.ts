/** Exception hierarchy for the Cycles client. */

export class CyclesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CyclesError";
  }
}

export class CyclesProtocolError extends CyclesError {
  readonly status: number;
  readonly errorCode: string | undefined;
  readonly reasonCode: string | undefined;
  readonly retryAfterMs: number | undefined;
  readonly requestId: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    message: string,
    options: {
      status?: number;
      errorCode?: string;
      reasonCode?: string;
      retryAfterMs?: number;
      requestId?: string;
      details?: Record<string, unknown>;
    } = {},
  ) {
    super(message);
    this.name = "CyclesProtocolError";
    this.status = options.status ?? 0;
    this.errorCode = options.errorCode;
    this.reasonCode = options.reasonCode;
    this.retryAfterMs = options.retryAfterMs;
    this.requestId = options.requestId;
    this.details = options.details;
  }

  isBudgetExceeded(): boolean {
    return this.errorCode === "BUDGET_EXCEEDED";
  }

  isOverdraftLimitExceeded(): boolean {
    return this.errorCode === "OVERDRAFT_LIMIT_EXCEEDED";
  }

  isDebtOutstanding(): boolean {
    return this.errorCode === "DEBT_OUTSTANDING";
  }

  isReservationExpired(): boolean {
    return this.errorCode === "RESERVATION_EXPIRED";
  }

  isReservationFinalized(): boolean {
    return this.errorCode === "RESERVATION_FINALIZED";
  }

  isIdempotencyMismatch(): boolean {
    return this.errorCode === "IDEMPOTENCY_MISMATCH";
  }

  isUnitMismatch(): boolean {
    return this.errorCode === "UNIT_MISMATCH";
  }

  isRetryable(): boolean {
    return (
      this.errorCode === "INTERNAL_ERROR" ||
      this.errorCode === "UNKNOWN" ||
      this.status >= 500
    );
  }
}

export class BudgetExceededError extends CyclesProtocolError {
  constructor(
    message: string,
    options: ConstructorParameters<typeof CyclesProtocolError>[1] = {},
  ) {
    super(message, options);
    this.name = "BudgetExceededError";
  }
}

export class OverdraftLimitExceededError extends CyclesProtocolError {
  constructor(
    message: string,
    options: ConstructorParameters<typeof CyclesProtocolError>[1] = {},
  ) {
    super(message, options);
    this.name = "OverdraftLimitExceededError";
  }
}

export class DebtOutstandingError extends CyclesProtocolError {
  constructor(
    message: string,
    options: ConstructorParameters<typeof CyclesProtocolError>[1] = {},
  ) {
    super(message, options);
    this.name = "DebtOutstandingError";
  }
}

export class ReservationExpiredError extends CyclesProtocolError {
  constructor(
    message: string,
    options: ConstructorParameters<typeof CyclesProtocolError>[1] = {},
  ) {
    super(message, options);
    this.name = "ReservationExpiredError";
  }
}

export class ReservationFinalizedError extends CyclesProtocolError {
  constructor(
    message: string,
    options: ConstructorParameters<typeof CyclesProtocolError>[1] = {},
  ) {
    super(message, options);
    this.name = "ReservationFinalizedError";
  }
}

export class CyclesTransportError extends CyclesError {
  readonly cause: Error | undefined;

  constructor(message: string, options?: { cause?: Error }) {
    super(message);
    this.name = "CyclesTransportError";
    this.cause = options?.cause;
  }
}
