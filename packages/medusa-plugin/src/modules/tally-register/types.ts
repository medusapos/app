export type RegisterSessionStatus = 'open' | 'counting' | 'closed' | 'superseded'

/** A register command's server figures (registers c2b applies them). */
export interface RegisterCommandResult {
  resumed?: { fromSessionId: string };
  superseded?: { sessionId: string; openedAt: string; deviceId?: string; deviceName?: string };
  /** The session's server state after this command. `expected` is absent when the server redacts it (blind). */
  session?: { id: string; status: 'open' | 'counting' | 'closed'; openedAt?: string; openingFloatMinor?: number; expected?: Record<string, number>; salesCount?: number };
  /** The register's counters: a floor for the till's own, never lowered. */
  counters?: { lastClosureNumber: number; perpetualSalesTotalMinor: number; perpetualRefundsTotalMinor: number };
  /** `register.closure.submit` only. */
  closure?: { serverClosureId: string; number: number; expected?: Record<string, number>; variance?: Record<string, number> };
}

export interface RegisterSessionOpenPayload {
  sessionId: string; registerId: string; storeKey?: string; businessDay?: string; openedAt: string; openedBy?: string;
  expectedFloatMinor?: number; countedFloatMinor: number; openingVarianceMinor?: number;
}
export interface RegisterSessionOpenV2Payload extends RegisterSessionOpenPayload {
  deviceName?: string; supersedes?: string;
}
export type RegisterSessionOpenInput = RegisterSessionOpenV2Payload & { deviceId?: string; contract?: number }

export interface RegisterSessionTransitionPayload {
  contract?: number;
  sessionId: string; status: 'open' | 'counting' | 'closed'; at: string;
  /** Closing only. */ counted?: Record<string, number>; closedBy?: string; approvedBy?: string;
}
export interface RegisterMovementRecordPayload {
  contract?: number;
  movementId: string; sessionId: string; type: 'paid_in' | 'paid_out' | 'no_sale'; amountMinor: number; reason: string;
  createdAt: string; createdBy?: string;
}
export interface RegisterMovementVoidPayload {
  contract?: number;
  movementId: string; sessionId: string; voids: string; createdAt: string; createdBy?: string;
}
export interface RegisterClosureSubmitPayload {
  contract?: number;
  closureId: string; sessionId: string; registerId: string; number: number; businessDay?: string;
  openedAt: string; closedAt: string; closedBy?: string; approvedBy?: string;
  tillExpected: Record<string, number>; counted: Record<string, number>;
  periodSalesTotalMinor: number; periodRefundsTotalMinor: number;
  perpetualSalesTotalMinor: number; perpetualRefundsTotalMinor: number;
  unsyncedCount: number; unsyncedTotalMinor: number; softwareVersion: string;
  orderIds: string[]; movementIds: string[];
}

export type RegisterCounters = {
  lastClosureNumber: number; perpetualSalesTotalMinor: number; perpetualRefundsTotalMinor: number
}

export type RegisterConflictCode =
  | 'register_session_already_open'
  | 'register_session_closed'
  | 'register_session_superseded'
  | 'register_closure_exists'
  | 'register_closure_number_invalid'

export type RegisterOutcome =
  | { kind: 'ok'; register: RegisterCommandResult }
  | { kind: 'conflict'; code: RegisterConflictCode; data?: Record<string, unknown> }
  | { kind: 'invalid'; message: string }
