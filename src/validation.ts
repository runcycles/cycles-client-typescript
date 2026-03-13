/** Input validation utilities. */

import type { Subject } from "./models.js";

export function validateSubject(subject: Subject | undefined): void {
  if (subject === undefined) return;
  const hasField = !!(
    subject.tenant ||
    subject.workspace ||
    subject.app ||
    subject.workflow ||
    subject.agent ||
    subject.toolset
  );
  if (!hasField) {
    throw new Error(
      "Subject must have at least one standard field (tenant, workspace, app, workflow, agent, or toolset)",
    );
  }
}

export function validateReservationId(reservationId: string | undefined): void {
  if (!reservationId) {
    throw new Error("reservation_id is required and must be non-empty");
  }
}

export function validateNonNegative(value: number, name: string): void {
  if (value < 0) {
    throw new Error(`${name} must be non-negative, got ${value}`);
  }
}

export function validateTtlMs(ttlMs: number): void {
  if (ttlMs < 1_000 || ttlMs > 86_400_000) {
    throw new Error(`ttl_ms must be between 1000 and 86400000, got ${ttlMs}`);
  }
}

export function validateGracePeriodMs(gracePeriodMs: number | undefined): void {
  if (gracePeriodMs !== undefined && (gracePeriodMs < 0 || gracePeriodMs > 60_000)) {
    throw new Error(`grace_period_ms must be between 0 and 60000, got ${gracePeriodMs}`);
  }
}
