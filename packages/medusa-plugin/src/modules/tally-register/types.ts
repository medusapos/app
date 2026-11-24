export type RegisterSessionStatus = 'open' | 'counting' | 'closed' | 'superseded'

export type AdmitApprovalResult =
  | { kind: 'admitted'; id: string }
  | { kind: 'refused'; code: 'approval_session_unknown' | 'approval_session_closed' | 'approval_rate_limited' }
export type IssueApprovalResult = { expiresAt: string }

/** A register command's server figures (registers c2b applies them). */
export interface RegisterCommandResult {
  resumed?: { fromSessionId: string };
  superseded?: { sessionId: string; openedAt: string; deviceId?: string; deviceName?: string };
  /** The session's server state after this command. `expected` is absent when the server redacts it (blind). */
  session?: { id: string; status: 'open' | 'counting' | 'closed'; openedAt?: string; openingFloatMinor?: number; expected?: Record<string, number>; salesCount?: number };
  /** The register's counters: a floor for the till's own, never lowered. */
  counters?: { lastClosureNumber: number; perpetualSalesTotalMinor: number; perpetualRefundsTotalMinor: number };
  /** `register.closure.submit` only. `refunds` only when the server's period refunds replaced the till's (#544). */
  closure?: { serverClosureId: string; number: number; expected?: Record<string, number>; variance?: Record<string, number>; approvalVerified?: boolean; refunds?: { tillMinor: number; serverMinor: number } };
}

export interface RegisterSessionOpenPayload {
  sessionId: string; registerId: string; storeKey?: string; businessDay?: string; openedAt: string; openedBy?: string;
  expectedFloatMinor?: number; countedFloatMinor: number; openingVarianceMinor?: number;
}
export interface RegisterSessionOpenV2Payload extends RegisterSessionOpenPayload {
  deviceName?: string; supersedes?: string;
}
export type RegisterSessionOpenInput = RegisterSessionOpenV2Payload & { deviceId?: string; contract?: number }
export type RegisterSessionTransitionInput = RegisterSessionTransitionPayload & { contract?: number }
export type RegisterMovementRecordInput = RegisterMovementRecordPayload & { contract?: number }
export type RegisterMovementVoidInput = RegisterMovementVoidPayload & { contract?: number }
export type RegisterClosureSubmitInput = RegisterClosureSubmitV3Payload & { contract?: number; commandId?: string; thresholdMinor?: number
  /** Contract 3 with unsyncedCount 0, or a false unsynced claim (the server holds every orderIds sale): the server's expected figures, which then decide the approval gate (ADR 0023). */
  serverExpected?: () => Promise<Record<string, number> | undefined>
  /** Under the same condition: the session's applied refunds, which replace a differing periodRefundsTotalMinor (#544). */
  serverRefundsTotalMinor?: () => Promise<number | undefined> }

export interface RegisterSessionTransitionPayload {
  sessionId: string; status: 'open' | 'counting' | 'closed'; at: string;
  /** Closing only. */ counted?: Record<string, number>; closedBy?: string; approvedBy?: string;
}
export interface RegisterMovementRecordPayload {
  movementId: string; sessionId: string; type: 'paid_in' | 'paid_out' | 'no_sale'; amountMinor: number; reason: string;
  createdAt: string; createdBy?: string;
}
export interface RegisterMovementVoidPayload {
  movementId: string; sessionId: string; voids: string; createdAt: string; createdBy?: string;
}
export interface RegisterClosureSubmitPayload {
  closureId: string; sessionId: string; registerId: string; number: number; businessDay?: string;
  openedAt: string; closedAt: string; closedBy?: string; approvedBy?: string;
  tillExpected: Record<string, number>; counted: Record<string, number>;
  periodSalesTotalMinor: number; periodRefundsTotalMinor: number;
  perpetualSalesTotalMinor: number; perpetualRefundsTotalMinor: number;
  unsyncedCount: number; unsyncedTotalMinor: number; softwareVersion: string;
  orderIds: string[]; movementIds: string[];
}
export interface RegisterClosureSubmitV3Payload extends RegisterClosureSubmitPayload { approval?: string }

/** A stored closure as closureHistory reads it: the submitted record plus its session's store, device and opener. */
export interface StoredClosure {
  id: string; session_id: string; register_id: string; number: number
  business_day: string | null; opened_at: string; closed_at: string
  closed_by: string | null; approved_by: string | null; approval_id: string | null
  till_expected: Record<string, number>; counted: Record<string, number>
  period_sales_total_minor: number; period_refunds_total_minor: number
  perpetual_sales_total_minor: number; perpetual_refunds_total_minor: number
  till_period_refunds_total_minor: number | null
  unsynced_count: number; unsynced_total_minor: number; software_version: string
  order_ids: string[]; movement_ids: string[]
  store_key: string | null; device_name: string | null; opened_by: string | null
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
  | 'register_approval_required'
  | 'register_approval_invalid'

export type RegisterOutcome =
  | { kind: 'ok'; register: RegisterCommandResult }
  | { kind: 'conflict'; code: RegisterConflictCode; data?: Record<string, unknown> }
  | { kind: 'invalid'; message: string }
