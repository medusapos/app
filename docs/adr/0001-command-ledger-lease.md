# Command ledger lease and fencing

Status: Accepted
Date: 2026-09-23

## Context

The #6 review found that a crashed worker leaves a command `in_progress`
forever, and a status-only check cannot stop a stale worker from writing.

## Decision

Claims have a 120 s lease on `updated_at`. Only the same fingerprint can
re-claim an expired `in_progress` command. Each claim gets a fresh
`claim_token`; conditional `complete` and `release` statements fence out
older claims. A row lost between claim and read raises `CONFLICT`, mapped
by the command endpoint to retryable `409 in_progress`.

Order creation also dedupes on `metadata.tally_client_id`, added with the
workflow.

## Consequences

A crashed command is retryable after two minutes. A slow worker past the
lease cannot write its result after a re-claim; order dedupe prevents a
second order.
