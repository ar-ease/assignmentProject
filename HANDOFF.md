# Pickup Counter handoff

Updated 2026-10-24 after Step 3 payment handling.

## Scope and current state

Steps 1 and 2 are complete: products, transactional order creation with stock holds, GET /orders/:id, lazy expiry and the five-second expiry sweep.
Step 3 is complete: signed payment webhook, idempotent processing, late-payment stock checks, review reasons, and the send-webhook script.
Step 4, pickup claim, is next. No pickup endpoint or customer ordering/payment UI was implemented. Wait for the user's Step 4 instructions.

The user requested no commits. This agent created no commits. HEAD during continuation was `846cfed` (`until payment webhook`); the final expiry-race fix, its test, README note, and this handoff remain uncommitted. Recheck `git status --short` before editing.

The stack is running. The backend was rebuilt and restarted with the final implementation. Its startup deploys migrations, seeds missing products, then starts the compiled server. The new migration has been applied to both `pickup` and `pickup_test`.

## Stack and invariants

- Independent `backend/` and `frontend/` npm packages, no workspaces. Express 5, strict TypeScript, Prisma 6.19.3, PostgreSQL 16, zod 4, tsx, Vitest and supertest. Node 20 in Docker; this host currently runs Node 24.
- Express is the only API. Frontend Next.js calls it directly. No Next.js API routes.
- All money uses integer paise; database tables/columns use snake_case with Prisma camelCase mappings.
- Database `now()` determines holds and paid timestamps. Do not replace it with JavaScript time.
- Inventory availability subtracts active pending holds plus paid orders. Expired, needs_review and picked_up orders do not reserve stock.
- Lock an existing ORDER first, then its PRODUCT rows in ID order. Pickup must follow this order too. Order creation locks products in ID order before inserting a new order.
- Under READ COMMITTED, read reservations in a separate statement after product locking so a previous lock holder's committed changes are visible.
- Reuse `withTx` from `backend/src/db.ts` and `reservedUnitsSql` from `backend/src/reservations.ts`.
- Tests use real Postgres, truncate only `pickup_test`, and must not run concurrently against that database. Vitest refuses other database names.
- Existing Ponytail preference: smallest complete change, no extra dependencies or unsolicited features.

## Step 3 implementation

- `backend/src/app.ts` mounts POST `/payments/webhook` with `express.raw({ type: 'application/json', limit: '10kb', inflate: false })` before JSON routers. The comment explains that HMAC must cover exact received bytes. Compressed bodies return 415; oversized bodies return 413 through the central error handler.
- `backend/src/config.ts` validates `WEBHOOK_SECRET` at startup, rejecting missing/blank values. It also retains Step 2 HOLD_SECONDS validation, default 120.
- `backend/src/routes/payments.ts` checks for exactly 64 hex signature characters before constructing the comparison buffers, verifies HMAC-SHA256 using `timingSafeEqual`, and only then parses JSON and applies the zod schema. Rejected signatures return 401 INVALID_SIGNATURE; malformed JSON/schema return readable 400 VALIDATION_ERROR. Neither writes to the database.
- `backend/src/payments.ts` performs all event insertion and order processing inside one `withTx` transaction. `INSERT ... ON CONFLICT DO NOTHING RETURNING event_id` serializes retries. A duplicate returns 200 duplicate without changing paid_at. If processing fails, the event rolls back so a retry can process it.
- Malformed order UUIDs are recorded as null in webhook_events.order_id. Unknown orders are recorded and acknowledged with 200 ignored/unknown_order because retries cannot fix them.
- Non-captured events are ignored. Captures of paid, picked_up or needs_review orders are ignored with a warning about a possible double charge.
- Wrong amounts set needs_review/amount_mismatch. Correct captures pay with DB paid_at if stock is available. Late captures return late:true when paid, otherwise needs_review/late_payment_stock_unavailable.
- Review found and a real-Postgres test reproduced an expiry race: a capture could start within its hold, wait on an order lock past expiry, and pay after another order reclaimed the last stock. The final code locks and rechecks products for EVERY correctly valued capture, explicitly excluding its own hold. It preserves order-before-product locking and the shared reservation helper. This prevents overselling across expiry.
- `backend/prisma/migrations/20261024114000_order_review_reason/migration.sql` adds nullable orders.review_reason TEXT. Prisma maps it to reviewReason; GET /orders/:id includes that nullable field.
- `backend/scripts/send-webhook.ts` runs via `npm run send-webhook -- <orderId> [--amount <paise>] [--event <id>] [--status <status>] [--bad-signature]`. It fetches the total unless --amount is supplied, generates/prints evt_<random> by default, signs the body, and prints HTTP status and response. Non-2xx and argument/network failures exit 1.
- README includes the payment decisions, late-payment/refund rationale, edge-case table, and curl/CLI demo commands.

## Environment and commands

Compose publishes frontend 3000, API 4000 and Postgres 5432. Working development defaults require no .env file:

```dotenv
DATABASE_URL=postgresql://pickup:pickup@db:5432/pickup?connection_limit=20
TEST_DATABASE_URL=postgresql://pickup:pickup@db:5432/pickup_test?connection_limit=20
WEBHOOK_SECRET=local-development-webhook-secret
PORT=4000
HOLD_SECONDS=120
NEXT_PUBLIC_API_URL=http://localhost:4000
```

The CLI uses API_URL, default http://localhost:4000, and the same default development secret as Compose. A custom Compose secret must also be exported for host CLI use. The CLI needs no database credentials.

```sh
docker compose up --build -d
# Run these test invocations sequentially:
docker compose run --rm backend npm test
# Host, after installing backend dependencies:
(cd backend && npm run send-webhook -- <orderId>)
# Inside the running backend container:
docker compose exec backend npm run send-webhook -- <orderId>
```

Local server startup requires WEBHOOK_SECRET and DATABASE_URL. For local database commands, replace hostname db with an accessible host. A pre-existing host Postgres server has conflicted with Compose's localhost:5432 in this session; Docker tests avoid that issue. Do not stop unrelated databases or delete volumes.

## Verification completed

Final backend image build passed Prisma generation and `npm run build`, including the script in TypeScript compilation.
Three consecutive full runs of `docker compose run --rm backend npm test` passed on the final image:

| Run | Test files | Tests | Failures | Vitest duration |
| --- | --- | --- | --- | --- |
| 1 | 5 passed | 78 passed | 0 | 6.69s |
| 2 | 5 passed | 78 passed | 0 | 7.12s |
| 3 | 5 passed | 78 passed | 0 | 6.51s |

The files contain 37 payment tests, 19 order tests, 8 CLI tests, 3 product tests and 11 config tests. Payment coverage includes all requested cases, exact whitespace/Unicode bytes, compressed/oversized bodies, concurrent late captures, every-item availability, transaction rollback/retry, and the reproduced expiry-boundary race. Expected warnings for captures of final orders appear in the test output.

Manual host verification returned HTTP 200 paid/late:true. Reusing its event ID inside the container returned HTTP 200 duplicate. The container --bad-signature command printed HTTP 401 INVALID_SIGNATURE and exited 1 as expected. Both host and container then returned duplicate against the final rebuilt/restarted backend.
Demo order `cf54386b-3790-4f11-ae7b-c49004391d7c` and event `evt_host_step3` remain in the development database; no cleanup deleted user data.
One initial in-container CLI attempt reported fetch failed, but immediate API checks and subsequent CLI runs succeeded. Its transient cause was not established.
The initial new tests failed as expected before implementation; the additional race test failed before the product-lock fix and passed afterward. No test failures remain.

## Known limits and next step

- PostgreSQL now() is transaction-stable. Long lock waits can conservatively count another hold that expired during the wait and send a payment to review. The late flag likewise reflects the transaction's DB time. Stock is still rechecked under locks to prevent overselling.
- Refunds are not implemented. Amount mismatches, unavailable late captures and possible double charges need a refund flow. Never silently discard a customer's captured payment.
- The Docker dependency install still reports three existing high-severity audit findings in Prisma tooling dependencies. No forced major upgrades or overrides were made.
- Frontend/browser checks were not repeated for this backend-only step. No production deployment or production hardening was requested.
- Next: Step 4 pickup claim. Follow the same order-before-products lock order and preserve payment/stock idempotency. Do not implement it without the user's next instructions.
