# Pickup Counter handoff

Updated 2026-10-25 after implementing Step 4 pickup and completing final documentation.

## Current state

Steps 1–7 are implemented and the automated verification below passes.
AI_NOTES.md records the completed checks and the limits of the available
verification. No commit was made.

Latest commit remains a3c2a9b, the Step 6 tests/CI commit. Current changes add
pickup to the application, tests and customer screen and finalize README/AI notes.
The user's previously staged documentation remains staged; new edits have not
been staged or committed.

POST /orders/:id/pickup-claim validates UUIDs, conditionally changes paid orders
to picked_up with a database timestamp, then locks products in ID order and
decrements each stock row inside the same withTx. Repeated claims cannot collect
twice. Stock and reservation changes commit together, preserving available units.
Invalid states produce the specified 409 codes; missing orders produce 404.

The customer screen shows a curl hint for paid orders, continues polling while
paid, and shows "Order collected" after pickup. No schema/dependency changes
were needed.

## Verification

- New pickup test first failed with the expected 404 from the missing route.
- Twelve real-Postgres pickup cases now cover two and ten simultaneous claims,
  pending/expired/overdue/review conflicts, later retries, UUID validation,
  availability conservation, mixed concurrent orders/pickups and transaction
  rollback when a later item violates the stock CHECK.
- The seeded 60-operation stress test now sends four competing pickup requests
  against a paid order, requires one success and three ALREADY_CLAIMED conflicts,
  counts successes per order and checks actual collection timestamps/conservation.
- Full backend suite on restored source: 7 files, 92 passed, no skipped cases,
  three consecutive runs. Durations: 7.40s, 9.33s, 7.64s.
- Frontend: 2 files, 8 passed. Production build passed, including TypeScript and
  routes /, /_not-found and /orders/[id]. The changed backend tests also passed
  a separate strict TypeScript check.
- Rebuilt and started Compose. Live signed payment returned paid; the README curl
  pickup command returned 200 picked_up, and repeating it returned 409 ALREADY_CLAIMED.
  Earlier payment/duplicate/bad-signature/review/natural-expiry examples were also run.
- Independent read-only source/test review reported no actionable findings.
- Browser inventory was empty, so interactive browser verification remains unavailable.

## Pickup mutation evidence

Saved the correct orders.ts implementation and its diff outside the repository.
Added an unlocked JS paid-status check and removed AND status = 'paid' from the
UPDATE. The test-held row lock lets every claim read paid and reach the UPDATE
before it is released.

Both simultaneous-claim tests failed in all three runs: two claims returned two
successes and ten returned ten, rather than exactly one. Each run had two failures.

Ran git checkout -- backend/src/orders.ts, then git diff --exit-code on that file
to confirm restoration to the indexed source. Reapplied the saved correct
implementation and verified its diff exactly matched the pre-mutation diff.
The final three full-suite runs used the restored implementation. No mutation remains.

## Earlier clone and hosted CI evidence

A clean GitHub clone of a3c2a9b passed uncached Docker builds, database initialization,
tests and frontend build before this pickup change. Hosted backend/frontend CI
also passed for that commit:
https://github.com/ar-ease/assignmentProject/actions/runs/40110794151

Those results do not cover this uncommitted pickup change; rerun hosted CI after
the user's commit/push. The temporary clone is retained at
/tmp/colima/pickup-step7.nMP2Bd/checkout; its containers and database volume were removed.

Colima shares the home directory and /tmp/colima by default. A first clone under
unshared /tmp could not mount init.sql; moving the clone fixed startup. README
records the shared-directory requirement. One earlier CLI connection failure
succeeded on an unchanged retry; its cause was not established.

## Invariants and remaining limits

Use Node 20 and PostgreSQL 16. Compose defaults need no .env file.
Tests truncate only pickup_test; never run backend test processes concurrently
against that database. Preserve the development volume and unrelated databases.

Lock an existing order first, then products in ID order. Recount reservations
in a separate statement after locking under READ COMMITTED. Pickup relies on
the conditional UPDATE, not a JS check. Payment event insertion and processing
share a transaction; HMAC covers raw bytes before JSON parsing.

README records future production work: order-creation idempotency, refunds,
paid-order pickup deadlines, authentication/rate limits, hot-row contention,
observability, a production frontend image and Prisma-tooling audit findings.
These remain declared limitations rather than unfinished assignment code.

## Next

1. Review and commit the changes, push, confirm new CI, then submit.

Suggested commit: feat: implement atomic pickup claims and complete verification.
