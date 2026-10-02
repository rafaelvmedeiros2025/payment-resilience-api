# Design decisions and failure analysis

## 1. A timeout is an unknown result

A lost response does not tell us whether the provider charged. The worker records uncertainty and reconciles with provider lookup before attempting a POST with the same stable provider idempotency key. After the retry budget, the system keeps `unknown` and flags `needs_review`; it never invents a definitive failure from repeated transport errors.

The simulator persists its charge before delaying the response. HTTP timeout tests therefore prove recovery from an actual lost/late response, not just a thrown mock exception.

## 2. Leases separate database work from network work

Claiming a payment happens in a short transaction. PostgreSQL locks one eligible row with SKIP LOCKED, increments attempts, stores a fresh lease token and expiration, then commits. Provider lookup and charge requests run without an open database transaction.

Finalization conditionally updates the row only when its lease token still matches. An expired worker whose job has been reclaimed cannot overwrite the new owner's result. Another worker can reclaim a lease after a crash; the stable provider key prevents a second logical charge if both workers contact the simulator.

A late worker may finish after expiration if no replacement has claimed the row. This is safe because the token still names the current owner. Expiration permits recovery; replacing the token performs fencing.

## 3. Idempotency exists at two boundaries

The API uses the caller's key to identify a request and reject changed payment details. The provider uses the payment UUID, not the caller's key, to identify the external charge. Amount, currency and normalized simulation mode are included in the API fingerprint. Provider charge records reject a changed amount/currency for an existing key.

Neither guarantee is an exactly-once networking claim. Calls can repeat. The simulator ensures that those repeated calls resolve to one persisted charge, and the service reconciles to its reference.

## Failure scenarios

| Scenario | Recovery |
| --- | --- |
| API commits but its response is lost | Caller retries the same key and receives the existing payment |
| Parallel workers race | SKIP LOCKED and unexpired leases allow only one active claim |
| Worker crashes before provider call | Lease expires; next worker reconciles and sends the charge |
| Worker crashes after provider charge | Next worker finds the receipt and records success |
| Old worker returns after lease replacement | Conditional token check rejects its stale update |
| HTTP response times out after charge commit | Status becomes unknown; lookup recovers the charge |
| HTTP 422 decline | Terminal decline; worker does not claim it again |
| Lookup is unavailable | Do not POST; preserve uncertainty and retry |
| Repeated uncertain outcomes exhaust budget | Flag review required and stop automatic claims |
| Database finalization fails | Transaction rolls back; lease recovery and lookup reconcile later |

## Operational limits

The worker's configured lease must exceed its two HTTP timeouts. This reduces overlapping work but does not eliminate arbitrary runtime pauses; token fencing and provider idempotency are still required. The in-memory timer only controls polling; all retry schedules and leases live in PostgreSQL.

Retries use capped exponential backoff with jitter. Attempts count worker claims, including reconciliation attempts and recovered leases. The retry budget is five by default, with uncertain outcomes retained for investigation. Audit events commit alongside accepted requests, claims and final state transitions.

The PostgreSQL-backed queue favors an inspectable local reference over broker throughput. The provider simulator shares the database instance for convenience, but service code does not query provider tables. Separate databases, credentials, monitoring and reconciliation operations are required for a real integration.
