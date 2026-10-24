# Pickup Counter handoff

Updated 2026-10-24 during Step 6, proof and polish.

## Scope and current state

Products, transactional orders and holds, expiry, signed payment webhooks and the
customer ordering/payment screens are implemented. Step 6 adds evidence, tests, CI and
documentation only. Application source, migrations, dependencies and runtime configuration
must remain identical to HEAD `fe7940e` (`Customer screen`). No commits were made.

Pickup is missing from this checkout. Despite commit `15dd5a6` being named `pickup claim`,
it only changed payment handling/tests and documentation. `backend/src/routes/orders.ts`
has POST /orders and GET /orders/:id, with no pickup route, conditional pickup UPDATE or
simultaneous-claim tests. The user was informed and work continued on available proof.
Do not describe Step 6 as fully complete or claim pickup safety is verified.

## What changed

- `backend/tests/invariants.test.ts`: fixed seed 20261024, 60 concurrent operations in three
  waves. Mixes orders, valid captures, wrong amounts, already-sent event duplicates and
  forced pending expiry. Uses independent SQL after every wave to check stock,
  reservations, conservation, exact event IDs and timestamps. Requires real paid/review
  outcomes, forced expiry and acknowledged duplicates. Pickup integration and the
  at-most-one successful claim assertion remain an explicit `test.todo`.
- `backend/tests/products.test.ts`: raw SQL negative-stock write must fail with
  `products_stock_check`, preserving the previous stock.
- `.github/workflows/ci.yml`: push and PR triggers; separate backend/frontend jobs, Node 20,
  per-package npm caches and `npm ci`. Backend generates Prisma and runs tests against a
  healthy PostgreSQL 16 service named `pickup_test`. Frontend runs tests and production build.
  Uses checkout/setup-node v6 and read-only repository permissions. No repository secrets
  are required; credentials and webhook secret are disposable CI values.
- README additions preserve existing sections: summary, badge placeholder, guarantees
  mapped to real test names, architecture/state Mermaid diagrams, mutation results,
  stress results and a first-CI-run checklist. Pickup is explicitly marked missing.

## Verification and evidence

Mutation checks used real PostgreSQL 16 and Node 20 in Docker, with host source/tests
mounted read-only so stale image code could not mask the mutation. Test database only.

| Mutation | Result over three isolated runs |
| --- | --- |
| Remove product `FOR UPDATE` in order creation | Failed 3/3: 6, 9, then 3 of 10 orders succeeded for 2 units. |
| Remove pickup conditional status predicate | Not run: implementation and tests absent. |
| Skip webhook event insert and duplicate early return | Both sequential and simultaneous tests failed 3/3. Retries returned ignored/already_final rather than duplicate. Final-status protection still prevented paying twice. |
| HMAC normalized JSON instead of raw bytes | Each run: 3 failed, 5 passed. Whitespace-valid signature rejected, whitespace tampering accepted, invalid JSON/bad signature returned 500 instead of 401. Existing whitespace/Unicode test retained. |

Each mutated source file was restored with `git checkout -- <file>` and checked with
`git diff --exit-code HEAD -- <file>`. An initial restore needed sandbox approval; the
idempotency experiment was repeated three times with only its own mutation afterward.
All application source was restored before adding lasting tests/docs/CI.

Five consecutive stress runs passed, each with 1 passing test and 1 pickup TODO.
Vitest durations: 1.60s, 1.31s, 1.21s, 1.06s, 1.11s. The seed fixes random choices;
concurrent scheduling and winners still vary. No collected orders are produced, so
conservation/timestamp checks alone do not prove pickup correctness.

Final full backend run: 6 files, 80 passing tests, 1 pickup TODO, zero failures, 7.58s.
Frontend: 2 files, 8 passing tests; Node 20 production build passed, including TypeScript
and routes `/`, `/_not-found`, `/orders/[id]`. A separate strict TypeScript check covers
the two changed backend test files.

Workflow YAML was parsed and checked for both triggers/jobs, Node versions, working
folders, lockfile cache paths, command order, Postgres image/port/health check, matching
credentials and the `/pickup_test` guard. Official GitHub action inputs/tags were checked.
GitHub Actions itself has not run. README lists what to inspect on the first run.

## Stack and invariants to preserve

- Independent backend/frontend npm packages, no workspaces. Express is the only API;
  Next.js calls it directly. No Next.js API routes.
- Use Node 20. Host currently has Node 24; Docker verification uses Node 20.
- Integer paise, snake_case database columns with Prisma mappings.
- Database `now()` determines holds and paid timestamps. Availability subtracts active
  pending holds and paid orders; expired/review/collected orders do not reserve stock.
- Lock an existing ORDER first, then PRODUCT rows in ID order. Order creation locks
  products in ID order before inserting a new order. Pickup must preserve this order.
- Under READ COMMITTED, read reservations in a separate statement after product locking
  to see the prior lock holder's commits. Reuse `withTx` and `reservedUnitsSql`.
- Every correct capture rechecks stock, excluding its own hold, even if it began before
  expiry. A lock wait may cross expiry while another order reclaims stock.
- Webhook event insert and processing share one transaction. HMAC uses exact raw bytes
  before parsing. Preserve validation, rollback/retry and final-order safeguards.
- Tests truncate only `pickup_test`. Never run backend test processes concurrently
  against the same database. Frontend checks can run alongside backend checks.

## Environment and commands

Compose publishes frontend 3000, API 4000 and PostgreSQL 5432. Default development values:

```dotenv
DATABASE_URL=postgresql://pickup:pickup@db:5432/pickup?connection_limit=20
TEST_DATABASE_URL=postgresql://pickup:pickup@db:5432/pickup_test?connection_limit=20
WEBHOOK_SECRET=local-development-webhook-secret
PORT=4000
HOLD_SECONDS=120
NEXT_PUBLIC_API_URL=http://localhost:4000
```

```sh
docker compose up --build -d
# Mount current source/tests when verifying changes without rebuilding the backend image:
docker compose run --rm \
  -v "$PWD/backend/src:/app/src:ro" \
  -v "$PWD/backend/tests:/app/tests:ro" \
  -v "$PWD/backend/vitest.config.ts:/app/vitest.config.ts:ro" \
  backend npm test
# Run from frontend/ with Node 20 installed:
npm test
npm run build
```

Host DB commands use localhost instead of db. A host PostgreSQL server previously
conflicted with Compose on port 5432; Docker tests avoid that ambiguity. Do not stop
unrelated databases or delete volumes. This step touched only test data.

## Next

1. Resolve the missing Step 4 implementation before closing pickup proof. Then run its
   conditional-update mutation three times and integrate simultaneous/duplicate pickup
   operations plus successful-response counts into the seeded stress test. Re-run five times.
2. Step 7: final README polish and AI_NOTES update, then the fresh-clone check.
3. Replace OWNER/REPO in the badge and inspect the first GitHub Actions run using the
   README checklist. Expected backend result currently includes one visible pickup TODO.
4. User reviews and commits. Suggested message: `test: add mutation evidence, invariant stress test and CI`.

Refunds remain unimplemented. Review cases and distinct double captures need a refund
flow. PostgreSQL transaction-time now() may conservatively send a delayed payment to
review. Earlier installs reported existing Prisma-tooling audit findings; this step
made no dependency changes or audit remediation. Browser checks, production deployment,
and fresh-clone validation were not part of this step.
