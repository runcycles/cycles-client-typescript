/** runcycles - TypeScript client for the Cycles budget-management protocol. */

// Client
export { CyclesClient } from "./client.js";

// Config
export { CyclesConfig } from "./config.js";

// Higher-order function
export { withCycles, setDefaultClient, setDefaultConfig } from "./withCycles.js";

// Streaming adapter
export { reserveForStream } from "./streaming.js";
export type { StreamReservation, StreamReservationOptions } from "./streaming.js";

// Context
export { getCyclesContext } from "./context.js";
export type { CyclesContext } from "./context.js";

// Response
export { CyclesResponse } from "./response.js";

// Exceptions
export {
  CyclesError,
  CyclesProtocolError,
  CyclesTransportError,
  BudgetExceededError,
  DebtOutstandingError,
  OverdraftLimitExceededError,
  ReservationExpiredError,
  ReservationFinalizedError,
} from "./exceptions.js";

// Models - Enums
export {
  Unit,
  Decision,
  CommitOveragePolicy,
  ReservationStatus,
  CommitStatus,
  ReleaseStatus,
  ExtendStatus,
  EventStatus,
  ErrorCode,
} from "./models.js";

// Models - Helper functions
export {
  isAllowed,
  isDenied,
  isRetryableErrorCode,
  errorCodeFromString,
  isToolAllowed,
  isMetricsEmpty,
} from "./models.js";

// Models - Types
export type {
  Amount,
  SignedAmount,
  Subject,
  Action,
  Caps,
  CyclesMetrics,
  Balance,
  ReservationCreateRequest,
  CommitRequest,
  ReleaseRequest,
  ReservationExtendRequest,
  DecisionRequest,
  EventCreateRequest,
  ReservationCreateResponse,
  CommitResponse,
  ReleaseResponse,
  ReservationExtendResponse,
  DecisionResponse,
  EventCreateResponse,
  DryRunResult,
  ErrorResponse,
  ReservationDetail,
  ReservationSummary,
  ReservationListResponse,
  BalanceResponse,
} from "./models.js";

// Mappers (for advanced use — building/parsing wire-format bodies)
export {
  // Request mappers (camelCase → snake_case)
  metricsToWire,
  reservationCreateRequestToWire,
  commitRequestToWire,
  releaseRequestToWire,
  reservationExtendRequestToWire,
  decisionRequestToWire,
  eventCreateRequestToWire,
  // Response mappers (snake_case → camelCase)
  capsFromWire,
  reservationCreateResponseFromWire,
  commitResponseFromWire,
  releaseResponseFromWire,
  reservationExtendResponseFromWire,
  decisionResponseFromWire,
  eventCreateResponseFromWire,
  reservationDetailFromWire,
  reservationSummaryFromWire,
  reservationListResponseFromWire,
  balanceResponseFromWire,
  errorResponseFromWire,
} from "./mappers.js";

// Lifecycle config type
export type { WithCyclesConfig } from "./lifecycle.js";
