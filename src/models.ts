/** Enums, interfaces, and helper functions for the Cycles protocol. */

// --- Enums ---

export enum Unit {
  USD_MICROCENTS = "USD_MICROCENTS",
  TOKENS = "TOKENS",
  CREDITS = "CREDITS",
  RISK_POINTS = "RISK_POINTS",
}

export enum CommitOveragePolicy {
  REJECT = "REJECT",
  ALLOW_IF_AVAILABLE = "ALLOW_IF_AVAILABLE",
  ALLOW_WITH_OVERDRAFT = "ALLOW_WITH_OVERDRAFT",
}

export enum Decision {
  ALLOW = "ALLOW",
  ALLOW_WITH_CAPS = "ALLOW_WITH_CAPS",
  DENY = "DENY",
}

export enum ReservationStatus {
  ACTIVE = "ACTIVE",
  COMMITTED = "COMMITTED",
  RELEASED = "RELEASED",
  EXPIRED = "EXPIRED",
}

export enum CommitStatus {
  COMMITTED = "COMMITTED",
}

export enum ReleaseStatus {
  RELEASED = "RELEASED",
}

export enum ExtendStatus {
  ACTIVE = "ACTIVE",
}

export enum EventStatus {
  APPLIED = "APPLIED",
}

export enum ErrorCode {
  INVALID_REQUEST = "INVALID_REQUEST",
  UNAUTHORIZED = "UNAUTHORIZED",
  FORBIDDEN = "FORBIDDEN",
  NOT_FOUND = "NOT_FOUND",
  BUDGET_EXCEEDED = "BUDGET_EXCEEDED",
  RESERVATION_EXPIRED = "RESERVATION_EXPIRED",
  RESERVATION_FINALIZED = "RESERVATION_FINALIZED",
  IDEMPOTENCY_MISMATCH = "IDEMPOTENCY_MISMATCH",
  UNIT_MISMATCH = "UNIT_MISMATCH",
  OVERDRAFT_LIMIT_EXCEEDED = "OVERDRAFT_LIMIT_EXCEEDED",
  DEBT_OUTSTANDING = "DEBT_OUTSTANDING",
  INTERNAL_ERROR = "INTERNAL_ERROR",
  UNKNOWN = "UNKNOWN",
}

// --- Core value objects ---

export interface Amount {
  unit: Unit | string;
  amount: number;
}

export interface SignedAmount {
  unit: Unit | string;
  amount: number;
}

export interface Subject {
  tenant?: string;
  workspace?: string;
  app?: string;
  workflow?: string;
  agent?: string;
  toolset?: string;
  dimensions?: Record<string, string>;
}

export interface Action {
  kind: string;
  name: string;
  tags?: string[];
}

export interface Caps {
  maxTokens?: number;
  maxStepsRemaining?: number;
  toolAllowlist?: string[];
  toolDenylist?: string[];
  cooldownMs?: number;
}

export interface CyclesMetrics {
  tokensInput?: number;
  tokensOutput?: number;
  latencyMs?: number;
  modelVersion?: string;
  custom?: Record<string, unknown>;
}

export interface Balance {
  scope: string;
  scopePath: string;
  remaining: SignedAmount;
  reserved?: Amount;
  spent?: Amount;
  allocated?: Amount;
  debt?: Amount;
  overdraftLimit?: Amount;
  isOverLimit?: boolean;
}

// --- Request models ---

export interface ReservationCreateRequest {
  idempotencyKey: string;
  subject: Subject;
  action: Action;
  estimate: Amount;
  ttlMs?: number;
  gracePeriodMs?: number;
  overagePolicy?: CommitOveragePolicy | string;
  dryRun?: boolean;
  metadata?: Record<string, unknown>;
}

export interface CommitRequest {
  idempotencyKey: string;
  actual: Amount;
  metrics?: CyclesMetrics;
  metadata?: Record<string, unknown>;
}

export interface ReleaseRequest {
  idempotencyKey: string;
  reason?: string;
}

export interface ReservationExtendRequest {
  idempotencyKey: string;
  extendByMs: number;
  metadata?: Record<string, unknown>;
}

export interface DecisionRequest {
  idempotencyKey: string;
  subject: Subject;
  action: Action;
  estimate: Amount;
  metadata?: Record<string, unknown>;
}

export interface EventCreateRequest {
  idempotencyKey: string;
  subject: Subject;
  action: Action;
  actual: Amount;
  overagePolicy?: CommitOveragePolicy | string;
  metrics?: CyclesMetrics;
  clientTimeMs?: number;
  metadata?: Record<string, unknown>;
}

// --- Response models ---

export interface ReservationCreateResponse {
  decision: Decision;
  reservationId?: string;
  affectedScopes: string[];
  expiresAtMs?: number;
  scopePath?: string;
  reserved?: Amount;
  caps?: Caps;
  reasonCode?: string;
  retryAfterMs?: number;
  balances?: Balance[];
}

export interface CommitResponse {
  status: CommitStatus;
  charged: Amount;
  released?: Amount;
  balances?: Balance[];
}

export interface ReleaseResponse {
  status: ReleaseStatus;
  released: Amount;
  balances?: Balance[];
}

export interface ReservationExtendResponse {
  status: ExtendStatus;
  expiresAtMs: number;
  balances?: Balance[];
}

export interface DecisionResponse {
  decision: Decision;
  caps?: Caps;
  reasonCode?: string;
  retryAfterMs?: number;
  affectedScopes?: string[];
}

export interface EventCreateResponse {
  status: EventStatus;
  eventId: string;
  balances?: Balance[];
}

export interface DryRunResult {
  decision: Decision;
  caps?: Caps;
  affectedScopes?: string[];
  scopePath?: string;
  reserved?: Amount;
  balances?: Balance[];
  reasonCode?: string;
  retryAfterMs?: number;
}

export interface ErrorResponse {
  error: string;
  message: string;
  requestId: string;
  details?: Record<string, unknown>;
}

export interface ReservationDetail {
  reservationId: string;
  status: ReservationStatus;
  subject: Subject;
  action: Action;
  reserved: Amount;
  createdAtMs: number;
  expiresAtMs: number;
  scopePath: string;
  affectedScopes: string[];
  idempotencyKey?: string;
  committed?: Amount;
  finalizedAtMs?: number;
  metadata?: Record<string, unknown>;
}

export interface ReservationSummary {
  reservationId: string;
  status: ReservationStatus;
  subject: Subject;
  action: Action;
  reserved: Amount;
  createdAtMs: number;
  expiresAtMs: number;
  scopePath: string;
  affectedScopes: string[];
  idempotencyKey?: string;
}

export interface ReservationListResponse {
  reservations: ReservationSummary[];
  hasMore?: boolean;
  nextCursor?: string;
}

export interface BalanceResponse {
  balances: Balance[];
  hasMore?: boolean;
  nextCursor?: string;
}

// --- Helper functions ---

export function isAllowed(decision: Decision): boolean {
  return decision === Decision.ALLOW || decision === Decision.ALLOW_WITH_CAPS;
}

export function isDenied(decision: Decision): boolean {
  return decision === Decision.DENY;
}

export function isRetryableErrorCode(code: ErrorCode): boolean {
  return code === ErrorCode.INTERNAL_ERROR || code === ErrorCode.UNKNOWN;
}

export function errorCodeFromString(value: string | undefined): ErrorCode | undefined {
  if (value === undefined) return undefined;
  if (Object.values(ErrorCode).includes(value as ErrorCode)) {
    return value as ErrorCode;
  }
  return ErrorCode.UNKNOWN;
}

export function isToolAllowed(caps: Caps, tool: string): boolean {
  if (caps.toolAllowlist !== undefined) {
    return caps.toolAllowlist.includes(tool);
  }
  if (caps.toolDenylist && caps.toolDenylist.includes(tool)) {
    return false;
  }
  return true;
}

export function isMetricsEmpty(metrics: CyclesMetrics): boolean {
  return (
    metrics.tokensInput === undefined &&
    metrics.tokensOutput === undefined &&
    metrics.latencyMs === undefined &&
    metrics.modelVersion === undefined &&
    !metrics.custom
  );
}
