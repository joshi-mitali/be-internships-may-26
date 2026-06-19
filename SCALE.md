# Scale Plan

How I'd take this from the SQLite prototype to ~10k requests/sec.

## Data model / indexes
Swap SQLite for Postgres, same table:

- `signals(id, user_id, type, payload, idempotency_key, created_at)`
- unique index on `idempotency_key` — this is what makes idempotency safe
- index on `(user_id, created_at desc)` for the list query

Writes are append-only and reads are "latest N for a user", so those two indexes
cover the hot paths. At high volume, partition `signals` by month so indexes stay
small and old data is cheap to drop.

## Idempotency across instances
The guarantee lives in the database, not the app, so it already works with any
number of instances: every writer races on the same unique `idempotency_key`,
exactly one insert wins, the rest read the existing row back. No coordination
between app servers needed. A short-lived Redis cache keyed by the idempotency key
can skip the DB on repeats, but the DB stays the source of truth.

## Rate limiting across instances
The in-memory limiter only counts within one process. For several instances, move
the counter to Redis: `INCR rl:{userId}` and `EXPIRE 60` on the first hit of a
window. `INCR` is atomic, so parallel requests across all instances count
correctly. A token bucket (small Lua script) is the nicer version if we want to
avoid bursts at the window edge.

## Observability
- Structured JSON logs (Fastify gives this) with a request id on each line.
- Metrics: request rate, p95/p99 latency, 429 rate, 503 rate, DB error + retry
  counts, connection-pool usage. Prometheus + Grafana.
- Alerts on rising 5xx, DB errors, pool exhaustion, and latency SLO breaches.

## Failure modes
- DB down: retries with backoff absorb short blips; once exhausted we return 503
  instead of hanging. A circuit breaker would stop hammering a DB that's clearly
  down.
- Partial outage: reads fail over to a replica, writes go to the primary only.
- Retries: jitter stops a retry stampede, and since a write either fully happens
  or not at all and keys are unique, retries never duplicate.

## 10k RPS sketch
```
client -> load balancer -> N stateless app instances
                                |          |
                            Postgres     Redis  (rate limit + idempotency cache)
                          (PgBouncer +
                           read replicas)
```
- App is stateless, so scale out — ~10-20 instances behind the LB.
- PgBouncer pools connections (10k raw connections would crush Postgres); read
  replicas serve the GET endpoint.
- Redis for rate limiting and the idempotency fast-path.
- If writes become the bottleneck, POST just enqueues (Kafka/SQS) and workers
  batch-insert.
- Rough cost: a handful of app boxes + a primary with 2 replicas + one Redis node —
  order of a few thousand $/month on a cloud, mostly the database.
