/**
 * First-class streaming adapter for Cycles budget governance.
 *
 * Unlike `withCycles` (which wraps a Promise-returning function and commits
 * immediately after the function resolves), `reserveForStream` returns a
 * handle that lets the caller control when to commit or release. This is
 * essential for LLM streaming where the function returns a stream object
 * immediately but actual usage is only known after the stream finishes.
 *
 * The handle owns its own finalization: calling `commit()` or `release()`
 * automatically stops the heartbeat. There is no need for a `finally`
 * block around the stream — the heartbeat lives until a terminal
 * operation (commit/release) is reached.
 *
 * RACE SAFETY: In real streaming code, multiple terminal paths can fire
 * concurrently (onFinish, error handler, abort signal, client disconnect).
 * The handle is once-only: the first terminal call (commit/release/dispose)
 * wins, and subsequent calls are either no-ops (release, dispose) or throw
 * (commit). Check `handle.finalized` to inspect state.
 *
 * Typical lifecycle:
 *   1. `reserveForStream(...)` — creates reservation + starts heartbeat
 *   2. Start streaming (e.g. `streamText(...)`)
 *   3. On stream finish → `handle.commit(actualCost, metrics)` (stops heartbeat)
 *   4. On stream error/abort → `handle.release("aborted")` (stops heartbeat)
 *   5. If stream startup fails before streaming begins → `handle.dispose()`
 */

import { randomUUID } from "node:crypto";
import type { CyclesClient } from "./client.js";
import { DEFAULT_TTL_MS } from "./constants.js";
import { buildProtocolException } from "./errors.js";
import { CyclesError, CyclesProtocolError } from "./exceptions.js";
import {
  buildEventFallbackBody,
  createLeadFloorAtScheduleStart,
  createReservationWithRecovery,
  extractExtendErrorCode,
  isSchemaValidExtendResponse,
  PERMANENT_EXTEND_ERROR_CODES,
} from "./lifecycle.js";
import {
  metricsToWire,
} from "./mappers.js";
import type { CyclesResponse } from "./response.js";
import { CommitRetryEngine } from "./retry.js";
import { isSchemaValidCommitSuccess } from "./settlement.js";
import type { Caps, CyclesMetrics, Decision, Subject } from "./models.js";
import {
  ErrorCode,
  errorCodeFromString,
  isMetricsEmpty,
  isRetryableErrorCode,
} from "./models.js";
import {
  validateExtendByMs,
  validateGracePeriodMs,
  validateNonNegative,
  validateSubject,
  validateTtlMs,
} from "./validation.js";

export interface StreamReservationOptions {
  client: CyclesClient;
  estimate: number;
  unit?: string;
  actionKind?: string;
  actionName?: string;
  actionTags?: string[];
  ttlMs?: number;
  gracePeriodMs?: number;
  overagePolicy?: string;
  tenant?: string;
  workspace?: string;
  app?: string;
  workflow?: string;
  agent?: string;
  toolset?: string;
  dimensions?: Record<string, string>;
}

export interface StreamReservation {
  /** The reservation ID from the server. */
  readonly reservationId: string;
  /** The budget decision (ALLOW or ALLOW_WITH_CAPS). */
  readonly decision: Decision;
  /** Caps imposed by the budget, if any. */
  readonly caps: Caps | undefined;
  /** True after commit(), release(), or dispose() has been called. */
  readonly finalized: boolean;

  /**
   * Commit actual usage after the stream completes successfully.
   * Automatically stops the heartbeat. Call from `onFinish` or equivalent.
   * Throws `CyclesError` if the handle is already finalized.
   *
   * Durability: transient failures (transport/5xx/429), authentication
   * failures, post-expiry commits, and unclassifiable client errors
   * (codeless or unrecognized error codes) are handled internally —
   * journaled and retried in the background (with a `POST /v1/events`
   * fallback once the reservation has expired) — and resolve normally.
   * Only genuine rejections carrying a recognized protocol error code
   * (e.g. UNIT_MISMATCH) reset `finalized` and throw.
   */
  commit(
    actual: number,
    metrics?: CyclesMetrics,
    metadata?: Record<string, unknown>,
  ): Promise<void>;

  /**
   * Release the reservation on error or abort.
   * Automatically stops the heartbeat. Best-effort — errors are swallowed.
   * No-op if the handle is already finalized.
   */
  release(reason?: string): Promise<void>;

  /**
   * Stop the heartbeat timer without committing or releasing.
   * Use only for stream startup failures where the stream was never started.
   * For normal finalization, use `commit()` or `release()` instead.
   * No-op if the handle is already finalized.
   */
  dispose(): void;
}

/**
 * Reserve budget for a streaming operation and return a handle to
 * commit or release when the stream completes.
 *
 * Throws `BudgetExceededError` (or other protocol errors) if the
 * reservation is denied.
 */
export async function reserveForStream(
  options: StreamReservationOptions,
): Promise<StreamReservation> {
  const {
    client,
    estimate,
    unit = "USD_MICROCENTS",
    actionKind = "unknown",
    actionName = "unknown",
    actionTags,
    ttlMs = DEFAULT_TTL_MS,
    gracePeriodMs,
    overagePolicy = "ALLOW_IF_AVAILABLE",
    dimensions,
  } = options;

  validateNonNegative(estimate, "estimate");
  validateTtlMs(ttlMs);
  validateGracePeriodMs(gracePeriodMs);

  // Build subject from options, falling back to client config defaults
  const configDefaults = client.config;
  const subject: Record<string, unknown> = {};
  for (const field of ["tenant", "workspace", "app", "workflow", "agent", "toolset"] as const) {
    const val = options[field] ?? configDefaults[field];
    if (val) {
      subject[field] = val;
    }
  }
  if (dimensions) {
    subject.dimensions = dimensions;
  }
  validateSubject(subject as Subject);

  // Build action
  const action: Record<string, unknown> = { kind: actionKind, name: actionName };
  if (actionTags) {
    action.tags = actionTags;
  }

  // Build wire-format request body
  const body: Record<string, unknown> = {
    idempotency_key: randomUUID(),
    subject,
    action,
    estimate: { unit, amount: estimate },
    ttl_ms: ttlMs,
    overage_policy: overagePolicy,
  };
  if (gracePeriodMs !== undefined) {
    body.grace_period_ms = gracePeriodMs;
  }

  const {
    response,
    result: parsed,
    rttMs: createRttMs,
    receivedMono: createReceivedMono,
  } = await createReservationWithRecovery(client, body);

  if (parsed.decision === "DENY") {
    throw buildProtocolException("Reservation denied", response);
  }

  const reservationId = parsed.reservationId;
  if (!reservationId) {
    throw new CyclesProtocolError(
      "Reservation successful but reservation_id missing",
      { status: response.status },
    );
  }

  // Background retry engine: commit failures that represent real spend
  // (transient errors, auth failures, post-expiry commits) are journaled
  // and retried rather than surfaced as caller-managed exceptions.
  const retryEngine = new CommitRetryEngine(client.config);
  retryEngine.setClient(client);

  // Heartbeat and finalization state
  let heartbeatStopped = false;
  let finalized = false;
  let currentTimer: ReturnType<typeof setTimeout> | undefined;

  const stopHeartbeat = (): void => {
    if (!heartbeatStopped) {
      heartbeatStopped = true;
      clearTimeout(currentTimer);
    }
  };

  const startHeartbeat = (): void => {
    if (ttlMs <= 0) return;
    validateExtendByMs(ttlMs);
    // FALLBACK cadence (servers without remaining_ttl_ms): the FIRST beat
    // fires IMMEDIATELY (delay 0). Tenant policy max_reservation_ttl_ms
    // may have silently capped the granted TTL far below the requested
    // one (governance default: 1 hour), the create response then has no
    // effective-TTL signal, and spec review round 4 confirmed that ANY
    // bounded first-beat delay can outlive a small capped lease — so the
    // first extend primes the lease with a real, measurable grant right
    // away instead of gambling on an unknowable one. After each applied
    // grant the cadence re-derives from the MEASURED grant:
    // clamp(grant/2, 500, ttl/2), except under a suspected lead clamp
    // (see the regime split in the success handler), where it holds at
    // min(ttl/2, 30 s). The 500 ms floor cannot starve liveness — it
    // binds only when the server grants less than 1 s per extend, i.e.
    // below the spec's own minimum ttl_ms.
    const heldIntervalMs = Math.min(ttlMs / 2, 30_000);
    let intervalMs = heldIntervalMs;

    // --- PRIMARY: server-authoritative scheduling (remaining_ttl_ms) ---
    // Per the spec's HEARTBEAT GUIDANCE (PR #148), NORMATIVE whenever a
    // schema-valid response carries remaining_ttl_ms — the remaining
    // lifetime at response evaluation, same clock snapshot as
    // expires_at_ms. The (grant, elapsed) regime heuristic below is
    // formally undecidable (e.g. ttl 24 s with +10 s grants gives a held
    // cadence of 12 s and a post-skip grant/elapsed ratio of 10/12 ~ 0.83
    // that sits inside the clamp band forever while the lease erodes to a
    // lapse), so exact scheduling always wins when the server provides
    // it. fieldMode tracks whether the LATEST schema-valid success
    // carried the field; the heuristic bookkeeping keeps running
    // underneath so it can take over seamlessly if the field disappears
    // mid-flight (proxy strips it, mixed-version server fleet, ...).
    //
    // Scheduling formula, recomputed from EVERY schema-valid response
    // alone (never accumulating expiry differences):
    //   rtt            = monotonic(response_received - attempt_sent),
    //                    per individual HTTP attempt (max tracked);
    //   lead_floor     = max(0, remaining_ttl_ms - rtt);
    //   attempt_budget = max(request_timeout_budget, 1 s, 2 x maxRtt);
    //   safety_margin  = max(1 s, 2 x maxRtt);
    //   retry_reserve  = 2 x attempt_budget + safety_margin;
    //   next_delay     = max(0, lead_floor - retry_reserve)
    // scheduled from response receipt. Budgets/margins round UP, leads
    // and delays round DOWN, so rounding never consumes the margin; all
    // arithmetic is overflow-safe (JS doubles saturate to Infinity —
    // an unknown/unbounded timeout makes attempt_budget Infinity and
    // next_delay 0). retry_reserve covers one failed attempt, one
    // same-key retry, and scheduling margin.
    let fieldMode = false;
    let maxObservedRttMs = 0;
    if (Number.isFinite(createRttMs) && createRttMs >= 0) {
      maxObservedRttMs = createRttMs;
    }
    let lastLeadFloorMs = 0;
    let lastLeadFloorMono = 0;
    // Zero-delay guard: a schema-valid success with next_delay = 0
    // permits ONE immediate fresh attempt (new idempotency key); two in a
    // row mean the lease cannot hold the retry-safety reserve -> stop.
    let zeroDelayStreak = 0;
    // Recovery progress guard state (spec: stop when neither monotonic
    // elapsed nor retry_window moves between consecutive failures).
    let lastFailMono: number | undefined;
    let lastFailWindow: number | undefined;
    let zeroWindowRetried = false;

    // The client's ENFORCED finite per-attempt bound: CyclesClient caps
    // every request with AbortSignal.timeout(connectTimeout+readTimeout).
    // Unknown or unbounded -> Infinity (the spec forbids pretending an
    // unbounded attempt fits any lease).
    const cfgTimeoutSum =
      client.config.connectTimeout + client.config.readTimeout;
    const requestTimeoutBudgetMs =
      Number.isFinite(cfgTimeoutSum) && cfgTimeoutSum > 0
        ? cfgTimeoutSum
        : Infinity;

    const attemptBudgetMs = (): number =>
      Math.ceil(Math.max(requestTimeoutBudgetMs, 1000, 2 * maxObservedRttMs));
    const safetyMarginMs = (): number =>
      Math.ceil(Math.max(1000, 2 * maxObservedRttMs));
    const retryReserveMs = (): number =>
      2 * attemptBudgetMs() + safetyMarginMs();

    /** last lead_floor decayed by monotonic elapsed time (floored at 0). */
    const currentLeadEstimateMs = (nowMono: number): number => {
      const elapsed = nowMono - lastLeadFloorMono;
      if (!Number.isFinite(elapsed) || elapsed < 0) return 0;
      const decayed = lastLeadFloorMs - elapsed;
      return Number.isFinite(decayed) ? Math.max(0, Math.floor(decayed)) : 0;
    };

    const stopAndSurface = (reason: string): void => {
      heartbeatStopped = true;
      console.warn(
        `[runcycles] Heartbeat stopped: ${reason}: ${reservationId}`,
      );
    };

    /**
     * Field-mode recovery decision for a transient failure (timeout,
     * connection error, 5xx, 429, or ambiguous 2xx). Recomputes
     * current_lead_estimate and retry_window from the SAME last
     * schema-valid response on every failure; repeated recovery is
     * allowed while the freshly recomputed window stays >= 0, always with
     * the SAME idempotency key. Returns the retry delay in ms, or
     * undefined when the heartbeat must stop (already surfaced).
     */
    const fieldRecoveryDelayMs = (
      retryAfter429Ms: number | undefined,
      is429: boolean,
    ): number | undefined => {
      const now = performance.now();
      const lead = currentLeadEstimateMs(now);
      // retry_window is deliberately UNclamped: negative means no
      // complete retry plus margin provably fits.
      const window = lead - attemptBudgetMs() - safetyMarginMs();
      if (window === 0 && zeroWindowRetried) {
        stopAndSurface(
          "retry window is still zero after the one permitted immediate recovery retry",
        );
        return undefined;
      }
      // Progress guard: between consecutive failures either monotonic
      // time advanced or the window shrank; otherwise a coarse clock
      // could sustain a zero-time recovery loop.
      if (
        lastFailMono !== undefined &&
        lastFailWindow !== undefined &&
        !(now > lastFailMono) &&
        !(window < lastFailWindow)
      ) {
        stopAndSurface(
          "no forward progress between recovery attempts (zero-time loop guard)",
        );
        return undefined;
      }
      lastFailMono = now;
      lastFailWindow = window;
      if (window < 0) {
        stopAndSurface(
          `remaining lease (${lead}ms) cannot hold one complete retry plus margin (need ${attemptBudgetMs() + safetyMarginMs()}ms)`,
        );
        return undefined;
      }
      if (window === 0) zeroWindowRetried = true;
      if (is429) {
        // Retry-After delta-seconds only, already converted to ms by the
        // response accessor (overflow is rejected, never wrapped). Honor it
        // exactly, and only when it fits the window — never invent an
        // earlier retry that violates throttling.
        if (retryAfter429Ms === undefined || !(retryAfter429Ms <= window)) {
          stopAndSurface(
            `rate limited and Retry-After ${retryAfter429Ms === undefined ? "is missing/invalid" : `(${retryAfter429Ms}ms) exceeds the safe retry window (${window}ms)`}`,
          );
          return undefined;
        }
        return retryAfter429Ms;
      }
      // window == 0 -> immediate retry; a second failure without
      // intervening success trips the progress guard above.
      return Math.max(0, Math.floor(Math.min(30_000, lead / 4, window)));
    };

    // Lead lower-bound extension. `extend_by_ms` extends relative to the
    // CURRENT expires_at_ms (spec), so blindly extending by ttlMs on
    // every beat would drift expiry outward per beat and burn the
    // server's max_extensions budget faster than needed. Each beat
    // instead computes a rigorous LOWER BOUND on the expiry lead:
    //
    //   leadMin = grantsSum - (now - anchor)
    //
    // where grants are differences of SUCCESSIVE expires_at_ms values
    // returned by the server (same server clock frame) and the elapsed
    // term is client-monotonic — no cross-clock arithmetic anywhere.
    // leadMin starts at 0: the initial grant is deliberately NOT counted,
    // because there is no safe same-clock anchor to measure it against
    // (per RFC 9110 the HTTP Date header is a whole-second, best-effort
    // origination time that intermediaries may replace; in the reference
    // server expires_at_ms comes from Redis TIME while Date comes from
    // the servlet container). So leadMin never overstates the real lead.
    // A beat is skipped only when leadMin >= 1.5x the last MEASURED
    // grant; otherwise it extends by the requested ttl. When a response
    // carries no numeric expires_at_ms, the grant falls back to the
    // requested ttl (2xx is proof the extend applied).
    let prevExpiry = parsed.expiresAtMs;
    const anchor = performance.now();
    let grantsSum = 0;
    let lastGrant: number | undefined;
    // Monotonic time of the last APPLIED extend (heartbeat start before
    // the first one) — the baseline for the lead-clamp regime test.
    let lastSuccessMono: number | undefined;
    let leadClampWarned = false;
    // Idempotency key of an extend whose outcome we never saw. It is
    // reused on the retry so a lost response cannot double-extend.
    let pendingKey: string | undefined;

    const tick = (delayMs: number): void => {
      if (heartbeatStopped) return;
      currentTimer = setTimeout(() => {
        if (heartbeatStopped) return;
        // Heuristic skip check — BYPASSED in field mode: there the
        // schedule is exact, and a heuristic skip could push the beat
        // past the real lease.
        if (!fieldMode) {
          const leadMin = grantsSum - (performance.now() - anchor);
          if (lastGrant !== undefined && leadMin >= 1.5 * lastGrant) {
            // Plenty of proven lead — skip this beat (no server call).
            tick(intervalMs);
            return;
          }
        }
        const key = pendingKey ?? randomUUID();
        pendingKey = key;
        const extendBody = { idempotency_key: key, extend_by_ms: ttlMs };
        const sentMono = performance.now();
        // Delay until the next beat, finalized by the handlers below and
        // consumed once in .finally.
        let nextDelayMs = intervalMs;
        void client
          .extendReservation(reservationId, extendBody)
          .then((response) => {
            if (response.isSuccess) {
              const schemaValid = isSchemaValidExtendResponse(response);
              if (!schemaValid) {
                // Any non-200 or schema-invalid 2xx is ambiguous, in both
                // modes. Keep the pending idempotency key for recovery.
                console.warn(
                  `[runcycles] Heartbeat extend returned an ambiguous 2xx (status=${response.status}); treating as transient: ${reservationId}`,
                );
                if (fieldMode) {
                  nextDelayMs = fieldRecoveryDelayMs(undefined, false) ?? 0;
                }
                return;
              }
              // Observed success.
              pendingKey = undefined;
              lastFailMono = undefined;
              lastFailWindow = undefined;
              zeroWindowRetried = false;
              const newExpires = response.getBodyAttribute("expires_at_ms");
              // Measured server-frame grant; requested-ttl fallback when
              // either endpoint of the difference is unavailable.
              const grant =
                typeof newExpires === "number" &&
                typeof prevExpiry === "number"
                  ? newExpires - prevExpiry
                  : ttlMs;
              prevExpiry =
                typeof newExpires === "number"
                  ? newExpires
                  : prevExpiry !== undefined
                    ? prevExpiry + ttlMs
                    : undefined;
              const now = performance.now();
              const rttMs = now - sentMono;
              if (Number.isFinite(rttMs) && rttMs >= 0) {
                maxObservedRttMs = Math.max(maxObservedRttMs, rttMs);
              }
              const elapsedSinceSuccess = now - (lastSuccessMono ?? anchor);
              lastSuccessMono = now;
              const remaining = response.getBodyAttribute("remaining_ttl_ms");
              if (schemaValid && typeof remaining === "number") {
                // PRIMARY path: schedule exactly from the server's own
                // remaining lifetime; never accumulate expiry
                // differences here. The heuristic bookkeeping below
                // still runs so it can take over if the field vanishes.
                fieldMode = true;
                let leadFloor: number;
                if (!Number.isFinite(rttMs) || rttMs < 0) {
                  // Timing unavailable/unreliable: unknown elapsed time
                  // must NOT be treated as zero — lead_floor and
                  // next_delay collapse to 0. The zero-delay guard below
                  // then permits at most one immediate fresh attempt
                  // before stopping; this is never a silent downgrade to
                  // the fieldless fallback.
                  leadFloor = 0;
                } else {
                  maxObservedRttMs = Math.max(maxObservedRttMs, rttMs);
                  leadFloor = Math.max(0, Math.floor(remaining - rttMs));
                }
                lastLeadFloorMs = leadFloor;
                lastLeadFloorMono = now;
                nextDelayMs = Math.max(
                  0,
                  Math.floor(leadFloor - retryReserveMs()),
                );
                if (nextDelayMs === 0) {
                  if (zeroDelayStreak >= 1) {
                    // Two consecutive zero-delay schedules: the lease is
                    // shorter than the retry-safety budget — stop rather
                    // than burn max_extensions in a tight loop.
                    stopAndSurface(
                      `lease is shorter than the retry-safety budget (lead_floor=${leadFloor}ms, retry_reserve=${retryReserveMs()}ms)`,
                    );
                    return;
                  }
                  // One immediate FRESH attempt (new idempotency key —
                  // pendingKey was cleared above) is permitted: an
                  // additive-delta server's immediate extension can
                  // still establish positive lead.
                  zeroDelayStreak = 1;
                } else {
                  zeroDelayStreak = 0;
                }
                grantsSum += Math.max(grant, 0);
                lastGrant = Math.max(grant, 0);
                return;
              }
              fieldMode = false;
              zeroDelayStreak = 0;
              // Regime split (spec review round 4). Under a maximum-LEAD
              // clamp the server holds expires_at_ms ~ now + L, so the
              // difference of successive expires_at_ms values measures
              // ELAPSED TIME, not granted lease — deriving the cadence
              // from it would collapse the interval to the floor and burn
              // max_extensions in seconds. A grant is treated as
              // lead-clamped when it is non-positive (no lease movement)
              // or both well below the requested ttl AND explainable as
              // elapsed time: within the 0.75x-1.25x BAND of the time
              // since the last applied extend. The band must be two-sided
              // (Rust-port finding, adopted fleet-wide): after a leadMin
              // skip the next grant arrives across a doubled gap, so a
              // genuine grant-clamped server (grant/2 cadence) also shows
              // grant ~ elapsed exactly once — an upper bound alone would
              // classify it as lead-clamped and the hold would
              // self-sustain (at the held cadence grant stays <= elapsed
              // forever, decaying the lease to a lapse). With the band, a
              // real maximum-lead clamp tracks ANY gap with ratio ~ 1 and
              // stays held, while the post-skip real grant lands in the
              // hold once: at the held cadence its ratio falls to ~ 0.5,
              // exits the band, and the cadence re-tightens. Only a REAL
              // per-extend grant may tighten the cadence.
              if (
                grant <= 0 ||
                (grant < 0.9 * ttlMs &&
                  grant >= 0.75 * elapsedSinceSuccess &&
                  grant <= 1.25 * elapsedSinceSuccess)
              ) {
                // Hold the cadence — never tighten it — and keep
                // extending every beat: lastGrant ~ elapsed keeps leadMin
                // below the skip threshold, which is exactly the desired
                // behavior under a lead clamp.
                intervalMs = heldIntervalMs;
                if (!leadClampWarned) {
                  leadClampWarned = true;
                  console.warn(
                    `[runcycles] Server appears to clamp lease lead (extend moved expires_at_ms by ${grant}ms in ${Math.round(elapsedSinceSuccess)}ms); holding heartbeat cadence at ${heldIntervalMs}ms — the extension budget (max_extensions) will deplete: ${reservationId}`,
                  );
                }
              } else {
                intervalMs = Math.min(Math.max(grant / 2, 500), ttlMs / 2);
              }
              grantsSum += Math.max(grant, 0);
              lastGrant = Math.max(grant, 0);
              nextDelayMs = intervalMs;
              return;
            }
            // Failure: KEEP pendingKey so any retry reuses the same
            // idempotency key. Permanent rejections (reservation gone,
            // settled, or extension budget exhausted) stop the heartbeat —
            // no retry can ever fix them. The bare status check catches
            // bodyless 410 Gone responses.
            const errorCode = extractExtendErrorCode(response);
            if (
              response.status === 410 ||
              (errorCode !== undefined &&
                PERMANENT_EXTEND_ERROR_CODES.has(errorCode))
            ) {
              console.warn(
                `[runcycles] Heartbeat extend permanently rejected (status=${response.status}, error=${String(errorCode)}); stopping heartbeat: ${reservationId}`,
              );
              heartbeatStopped = true;
              return;
            }
            if (!fieldMode) {
              // FALLBACK: retry on the next beat at the current cadence.
              console.warn(
                `[runcycles] Heartbeat extend failed (status=${response.status}); retrying next beat: ${reservationId}`,
              );
              return;
            }
            // PRIMARY-path failure handling.
            if (response.status === 429) {
              const delay = fieldRecoveryDelayMs(
                response.retryAfterMsHeader,
                true,
              );
              if (delay === undefined) return; // stopped and surfaced
              nextDelayMs = delay;
              return;
            }
            if (response.isClientError) {
              // Any other 4xx: a request/authorization failure a retry of
              // the UNCHANGED request cannot fix — stop and surface;
              // never rotate the idempotency key to force it through.
              stopAndSurface(
                `extend rejected with client error (status=${response.status}, error=${String(errorCode)})`,
              );
              return;
            }
            if (!response.isTransportError && !response.isServerError) {
              stopAndSurface(
                `extend returned unexpected HTTP status ${response.status}`,
              );
              return;
            }
            // Timeout-as-response, transport-as-response, or 5xx.
            const delay = fieldRecoveryDelayMs(undefined, false);
            if (delay === undefined) return; // stopped and surfaced
            nextDelayMs = delay;
            console.warn(
              `[runcycles] Heartbeat extend failed (status=${response.status}); retrying with the same key in ${nextDelayMs}ms: ${reservationId}`,
            );
          })
          .catch((error: unknown) => {
            // Transport exception: preserve the same-key retry semantics, but
            // never make the loss of lease authority invisible to operators.
            const detail =
              error instanceof Error
                ? `${error.name}: ${error.message}`
                : String(error);
            if (fieldMode) {
              const delay = fieldRecoveryDelayMs(undefined, false);
              if (delay === undefined) {
                console.warn(
                  `[runcycles] Heartbeat extend transport error; recovery stopped: ${reservationId}: ${detail}`,
                );
                return; // stopped and surfaced
              }
              nextDelayMs = delay;
              console.warn(
                `[runcycles] Heartbeat extend transport error; retrying with the same key in ${nextDelayMs}ms: ${reservationId}: ${detail}`,
              );
            } else {
              console.warn(
                `[runcycles] Heartbeat extend transport error; retrying next beat with the same key in ${nextDelayMs}ms: ${reservationId}: ${detail}`,
              );
            }
          })
          .finally(() => { tick(nextDelayMs); });
      }, delayMs);
    };

    if (
      typeof parsed.remainingTtlMs === "number" &&
      Number.isInteger(parsed.remainingTtlMs) &&
      parsed.remainingTtlMs >= 0
    ) {
      // PRIMARY: the first beat derives from the create response's
      // remaining_ttl_ms with the same formula as every later beat,
      // using the create call's own measured rtt. No immediate prime:
      // under a maximum-lead clamp an immediate extend would only waste
      // one of max_extensions, and the exact schedule already lands the
      // first beat inside the real lease.
      fieldMode = true;
      const measuredLeadFloor = createLeadFloorAtScheduleStart(
        parsed.remainingTtlMs,
        createRttMs,
        createReceivedMono,
        anchor,
      );
      let leadFloor: number;
      if (measuredLeadFloor === undefined) {
        // Unknown timing must not be treated as zero elapsed time.
        leadFloor = 0;
      } else {
        maxObservedRttMs = Math.max(maxObservedRttMs, createRttMs);
        leadFloor = measuredLeadFloor;
      }
      lastLeadFloorMs = leadFloor;
      lastLeadFloorMono = anchor;
      const firstDelay = Math.max(0, Math.floor(leadFloor - retryReserveMs()));
      if (firstDelay === 0) {
        // The create response is the first zero-delay schema-valid
        // success: exactly one immediate fresh extension is permitted
        // before the two-consecutive-zero-delay guard stops the
        // heartbeat.
        zeroDelayStreak = 1;
      }
      tick(firstDelay);
    } else {
      // FALLBACK: immediate first beat — see the comment above
      // heldIntervalMs. The 0 delay applies to this first schedule ONLY:
      // every reschedule passes a delay that never becomes 0 (heuristic
      // reschedules use intervalMs, which starts at heldIntervalMs), so
      // a transient failure on the immediate first attempt never
      // hot-loops against a down server.
      tick(0);
    }
  };

  startHeartbeat();

  return {
    reservationId,
    decision: parsed.decision as Decision,
    caps: parsed.caps,

    get finalized(): boolean {
      return finalized;
    },

    async commit(
      actual: number,
      metrics?: CyclesMetrics,
      metadata?: Record<string, unknown>,
    ): Promise<void> {
      if (finalized) {
        throw new CyclesError("StreamReservation already finalized");
      }
      finalized = true;
      stopHeartbeat();
      const commitBody: Record<string, unknown> = {
        idempotency_key: randomUUID(),
        actual: { unit, amount: actual },
      };
      if (metrics && !isMetricsEmpty(metrics)) {
        commitBody.metrics = metricsToWire(metrics);
      }
      if (metadata) {
        commitBody.metadata = metadata;
      }
      const eventFallback = buildEventFallbackBody(
        reservationId,
        subject,
        action,
        commitBody,
      );
      retryEngine.persistPending(reservationId, commitBody, eventFallback);

      let response: CyclesResponse;
      try {
        response = await client.commitReservation(reservationId, commitBody);
      } catch {
        // Transport exception: the spend already happened — journal and
        // retry in the background rather than punting to the caller.
        retryEngine.schedule(reservationId, commitBody, eventFallback);
        return;
      }
      if (isSchemaValidCommitSuccess(response)) {
        retryEngine.discardPending(reservationId);
        return;
      }
      if (response.isSuccess) {
        console.warn(
          `[runcycles] Stream commit returned an ambiguous protocol-invalid 2xx (status=${response.status}); scheduling same-key retry: ${reservationId}`,
        );
        retryEngine.schedule(reservationId, commitBody, eventFallback);
        return;
      }
      if (response.isTransportError || response.isServerError) {
        retryEngine.schedule(reservationId, commitBody, eventFallback);
        return;
      }

      const errorResp = response.getErrorResponse();
      let errorCode = errorResp?.error;
      if (errorCode === undefined) {
        const rawError = response.getBodyAttribute("error");
        if (typeof rawError === "string") {
          errorCode = rawError;
        }
      }

      if (response.status === 429 || errorCode === "LIMIT_EXCEEDED") {
        // Rate-limited, not rejected — never release spent budget.
        retryEngine.schedule(
          reservationId,
          commitBody,
          eventFallback,
          response.retryAfterMsHeader,
        );
        return;
      }
      if (response.status === 401 || response.status === 403) {
        console.error(
          `[runcycles] Stream commit got authentication failure (status=${response.status}); journaling for replay: ${reservationId}`,
        );
        retryEngine.schedule(reservationId, commitBody, eventFallback);
        return;
      }
      if (response.status === 410 || errorCode === "RESERVATION_EXPIRED") {
        // The status check catches bodyless 410 Gone responses.
        console.warn(
          `[runcycles] Reservation expired before commit; recovering spend via POST /v1/events: ${reservationId}`,
        );
        retryEngine.scheduleEvent(reservationId, eventFallback);
        return;
      }
      if (
        errorCode === "RESERVATION_FINALIZED" ||
        errorCode === "IDEMPOTENCY_MISMATCH"
      ) {
        retryEngine.discardPending(reservationId);
        console.warn(
          `[runcycles] Stream commit already settled (${errorCode}): ${reservationId}`,
        );
        return;
      }

      const parsedErrorCode = errorCodeFromString(errorCode);
      if (
        response.isClientError &&
        parsedErrorCode !== undefined &&
        parsedErrorCode !== ErrorCode.UNKNOWN &&
        !isRetryableErrorCode(parsedErrorCode)
      ) {
        // Genuine rejection (e.g. UNIT_MISMATCH — a recognized protocol
        // code): reset finalized so the caller can correct and retry
        // commit or fall back to release. The heartbeat is NOT restarted
        // to avoid spawning duplicate heartbeat chains (an old in-flight
        // extend's .finally→tick could race with a new startHeartbeat
        // call). The reservation's remaining TTL should give the caller
        // enough time to retry or release.
        retryEngine.discardPending(reservationId);
        finalized = false;
        throw new CyclesError(
          `Commit failed with status ${response.status}: ${response.errorMessage ?? "unknown error"}`,
        );
      }

      // Codeless, mangled, or forward-compat unknown client error:
      // unclassifiable. Never throw away real spend on a response we
      // cannot interpret — journal it for background retry / replay.
      console.error(
        `[runcycles] Stream commit got unclassifiable client error (status=${response.status}, error=${String(errorCode)}); journaling for replay: ${reservationId}`,
      );
      retryEngine.schedule(reservationId, commitBody, eventFallback);
    },

    async release(reason?: string): Promise<void> {
      if (finalized) return;
      finalized = true;
      stopHeartbeat();
      try {
        const releaseBody = { idempotency_key: randomUUID(), reason: reason ?? "stream_aborted" };
        await client.releaseReservation(reservationId, releaseBody);
      } catch {
        // Best-effort release
      }
    },

    dispose(): void {
      if (finalized) return;
      finalized = true;
      stopHeartbeat();
    },
  };
}
