/** runcycles - TypeScript client for the Cycles budget-management protocol. */

// Client
export { CyclesClient } from "./client.js";

// Config
export { CyclesConfig } from "./config.js";

// Higher-order function
export { withCycles, setDefaultClient, setDefaultConfig } from "./withCycles.js";

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

// Lifecycle config type
export type { WithCyclesConfig } from "./lifecycle.js";
