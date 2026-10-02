# Payment Resilience API

[![CI](https://github.com/rafaelvmedeiros2025/payment-resilience-api/actions/workflows/ci.yml/badge.svg)](https://github.com/rafaelvmedeiros2025/payment-resilience-api/actions/workflows/ci.yml)

An asynchronous payment reference implementation built around one difficult failure: **the provider charges successfully, but the HTTP response never reaches the worker**.

**Node.js 24 · TypeScript · Fastify · PostgreSQL · Docker**

## What it demonstrates

- Request idempotency shared across API instances, with canonical fingerprints and PostgreSQL advisory locks.
- Asynchronous acceptance (`202 Accepted`) and a durable state machine.
- Workers claim jobs using short transactions, expiring leases and `SKIP LOCKED`.
- External HTTP calls run **outside database transactions**.
- Lease tokens fence stale worker updates after a job is reclaimed.
- A stable provider idempotency key identifies the same logical charge on every retry.
- Provider lookup runs before each charge attempt, reconciling ambiguous outcomes.
- Exponential backoff with jitter, permanent declines and a bounded retry budget.
- Unresolved payments remain `unknown` and require review instead of being falsely marked failed.
- A separate HTTP simulator persists charges before delaying its response, reproducing a real transport timeout.

## Architecture

```mermaid
flowchart TD
    Client["API client"] --> API["Fastify payment API"]
    API --> DB["PostgreSQL payment state and audit events"]
    Worker["Leased worker"] --> DB
    Worker --> Provider["HTTP provider simulator"]
    Provider --> Charges["Provider charge records"]
    Worker --> Reconcile["Lookup before charge"]
    Reconcile --> Provider
```

The simulator and service share a PostgreSQL instance for a convenient local demo, but the worker accesses provider state only over HTTP. Provider tables are logically owned by the simulator. There is no real money movement or external payment integration.

## Run

Requires Docker with Compose v2:

```bash
docker compose up --build
```

| Component | Local address |
| --- | --- |
| API | `http://localhost:3001` |
| Provider simulator | `http://localhost:4001` |
| PostgreSQL | `localhost:5433` |

Ports differ from the order-platform demo so both projects can run together.

```bash
curl -i -X POST http://localhost:3001/payments \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: timeout-demo-001' \
  -d '{"amountCents":2500,"currency":"USD","mode":"timeout"}'
```

Poll the returned `Location` path with `GET /payments/:id`. In timeout mode, the simulator commits the charge, then delays the response beyond the worker's timeout. The worker records `unknown`, retries after backoff, discovers the existing receipt and finishes `succeeded` without another charge.

Repeat the POST with the same key and details to get the same payment (`200`). Changed details with the same key return `409`. Replays return the latest payment state rather than a stored original response.

### Demo scenarios

| `mode` | Behavior |
| --- | --- |
| `success` (default) | Provider returns a receipt immediately |
| `temporary` | First two charge attempts return HTTP 503; third succeeds |
| `declined` | HTTP 422; terminal decline, no retries |
| `timeout` | Charge commits before a delayed response; lookup recovers the receipt |
| `unavailable` | Charge attempts keep returning HTTP 503; review required after five worker claims |

Modes are simulation controls, not production client options. Amounts are integer cents; supported demo currencies are USD, BRL and EUR. No card or bank information is collected.

### API

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/payments` | Accept a payment; requires `Idempotency-Key` |
| GET | `/payments/:id` | Current status, attempts and provider reference |
| GET | `/health/live` | API liveness |
| GET | `/health/ready` | Database connectivity |

## State and uncertainty

```mermaid
stateDiagram-v2
    [*] --> Queued
    Queued --> Processing: Claim lease
    Processing --> Succeeded: Receipt found
    Processing --> Declined: Known provider decline
    Processing --> Unknown: Timeout or uncertain result
    Unknown --> Processing: Retry after backoff
    Unknown --> Review: Retry budget exhausted
    Review --> [*]
    Succeeded --> [*]
    Declined --> [*]
```

`Review` is represented as `status = 'unknown'` with `needs_review = true`, not a terminal failure. Do not create a fresh payment to bypass uncertainty: the original attempt could already have charged. This reference has no manual reconciliation/redrive endpoint; unresolved cases require investigation against the provider record.

## Development and tests

For Node running outside containers, start PostgreSQL with `docker compose up -d postgres`, then:

```bash
npm ci
cp .env.example .env
set -a
. ./.env
set +a
npm run migrate
npm run dev
# Another terminal with the same environment:
npm run provider:dev
# Another terminal with the same environment:
npm run worker:dev
```

Development scripts use API port 3000 and provider port 4000 unless overridden. The Compose demo uses host ports 3001 and 4001.

```bash
npm run check
npm test
npm run build
# Create a separate disposable database first; integration tests truncate tables.
TEST_DATABASE_URL=postgres://payments:payments@localhost:5433/payments_test \
npm run test:integration
```

Unit/HTTP tests exercise request fingerprints, backoff, lookup failures, reconciliation, declines, real timeouts and malformed responses. PostgreSQL integration tests exercise concurrent requests, concurrent workers, expired leases, stale-owner fencing, retries, timeout reconciliation, crash recovery and provider-side key conflicts. GitHub Actions provisions PostgreSQL and builds the Docker image.

## Operational inspection

```sql
SELECT status, needs_review, count(*) FROM payments GROUP BY status, needs_review;
SELECT id, attempts, last_error FROM payments WHERE needs_review;
SELECT * FROM payment_events ORDER BY id DESC LIMIT 30;
```

The API uses structured Fastify logs and request IDs; workers emit JSON activity/error logs. SIGTERM/SIGINT stops new claims and lets the active HTTP attempt finish. A process that crashes leaves a lease that another worker can reclaim after expiration.

## Boundaries and trade-offs

This is a portfolio reference implementation. It relies on the simulator's **durable idempotency and authoritative lookup semantics**. A real adapter must verify those guarantees, distinguish definitive declines from transport ambiguity, and validate receipts against the requested amount/currency. Provider-side retention limits and eventual-consistency delays need explicit treatment.

Authentication, authorization, tenant isolation, refunds, real payments, webhook verification, tracing exporters, metrics and load benchmarks are not implemented. Keys are global and retained indefinitely. Local credentials are for development. No throughput or production-readiness claims are made.

See [design decisions and failure analysis](docs/architecture.md).

Created by [Rafael Medeiros](https://www.linkedin.com/in/rmedeiros2/).
