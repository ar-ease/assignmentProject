# Pickup Counter

The backend supports products, orders with stock holds and expiry, and signed payment webhooks.
Step 5 adds the customer menu, cart and payment status screens in `frontend/`.

```sh
docker compose up --build
```

Open http://localhost:3000. Express runs at http://localhost:4000 and PostgreSQL at localhost:5432.
Compose has working development defaults; no `.env` file is required.
The init SQL creates `pickup` and `pickup_test` on the first volume initialization.

```sh
docker compose run --rm backend npm test
```

For local backend commands, use Node 20, run `npm ci` and `npx prisma generate` in `backend`,
and set `DATABASE_URL` and `TEST_DATABASE_URL` using `.env.example` values with `localhost` instead of `db`.
Set `WEBHOOK_SECRET` before starting the API; startup rejects missing or blank secrets.
`npm test` defaults to the local `pickup_test` URL and migrates it automatically.
Tests truncate only the test database. Do not run tests concurrently against that database.

The seed inserts missing snacks and preserves existing stock on restart.
The Docker backend startup runs migrations, seed, then the compiled server.

## Customer screen

At http://localhost:3000, add snacks to the cart and place an order. Quantities are capped
at available stock and 20 per item. Stock refreshes every five seconds and after each
order attempt; reduced stock adjusts the cart. All totals are calculated in integer paise.

The payment page is `/orders/<id>`, so refreshing or reopening its URL loads the same order.
It shows a demo UPI placeholder and a copyable command to simulate payment:

```sh
docker compose exec backend npm run send-webhook -- <id>
```

Order status polls every two seconds after the previous request completes, retries network
errors, and stops on paid, expired, needs_review or picked_up. The countdown resyncs from
the server's `expiresInSeconds` on every response and measures elapsed time with
`performance.now()`. Device wall-clock skew cannot change it. At zero, the screen checks
payment status and waits for the server to confirm expiry.

To work on the frontend locally, use Node 20 and run these commands in `frontend/`:

```sh
npm ci
npm run dev
npm test
npm run build
```

`npm test` runs small Vitest unit tests, including countdown advancement, resync, zero
clamping, and wall clocks set ten minutes ahead and behind, plus cart stock limits and
integer-paise calculations. `NEXT_PUBLIC_API_URL` defaults to `http://localhost:4000`.

## Decisions

- Lock product rows with `FOR UPDATE` in ID order to avoid deadlocks. Read reservations in a separate statement after locking so committed holds are visible under READ COMMITTED.
- Use the database clock for holds and countdowns.
- Expire orders lazily on reads and sweep every five seconds. The sweeper is cosmetic; overdue pending holds already stop reserving stock.
- Snapshot unit prices into `order_items` so product price changes do not change an order's total.
- Configure hold duration with positive integer `HOLD_SECONDS`, default 120. Values must fit a PostgreSQL integer.
- Verify `X-Signature` as hex HMAC-SHA256 over the exact raw request bytes before parsing JSON. The webhook mounts `express.raw()` before JSON routers, limits bodies to 10kb, and rejects compressed bodies so decompression cannot change the signed bytes. The API requires `WEBHOOK_SECRET` at startup.
- Insert the event and change the order in one transaction. `ON CONFLICT DO NOTHING` makes sequential and concurrent retries idempotent. A failed transaction rolls back its event too, allowing a provider retry to process it.
- When changing an existing order and locking stock, lock the order first, then products in ID order. Step 4 pickup must follow the same rule. After product locks, read reservations in a separate statement to see the previous lock holder's commits.
- Every correctly valued capture locks and rechecks stock, excluding its own hold. Even a capture started before expiry can wait while another order reclaims the released stock. This check prevents overselling when that delayed capture resumes. Expiry uses PostgreSQL transaction-time `now()` as elsewhere; a long lock wait can conservatively count another hold that has since expired, requiring review rather than risking overselling.
- A late capture rechecks stock under product locks using the shared reservation helper. Its expired hold does not reserve units. Honour the payment if every item is still available; otherwise set `needs_review` with `late_payment_stock_unavailable`. Never oversell to accept money, and never silently lose a customer's payment. Flag payments we cannot honour for a refund.
- A wrong amount sets `needs_review` with `amount_mismatch`. `GET /orders/:id` includes nullable `reviewReason`. Orders under review do not hold stock.
- Acknowledge unknown orders with 200 and record the event. Providers retry non-2xx responses, and retrying cannot fix an unknown order. Store malformed order IDs as null in the event's UUID column.
- Distinct captures for final orders log a warning and leave the order unchanged. A second capture for a paid order may be a double charge.

## Webhook edge cases

All 200 outcomes record the event, except a duplicate, which keeps the existing event.
Signature and body validation failures write nothing. Unexpected processing errors return 500 and roll back the event and order changes.

| Case | Response | Why |
| --- | --- | --- |
| Missing, non-hex, wrong-length, mismatched signature, or tampered body | 401 `INVALID_SIGNATURE` | Authenticate the raw bytes before parsing or writing. |
| Signed invalid JSON or schema | 400 `VALIDATION_ERROR` with readable message | Reject malformed input without recording an event. |
| Body over 10kb / compressed body | 413 / 415 | Bound memory use and preserve signed bytes. |
| Same event ID, sequentially or concurrently | 200 `{"result":"duplicate"}` | The event primary key serializes retries; `paid_at` stays unchanged. |
| Malformed UUID or unknown order | 200 `{"result":"ignored","reason":"unknown_order"}` | Keep an audit record and stop futile provider retries. |
| Status other than `captured` | 200 `{"result":"ignored","reason":"not_captured"}` | Only captured payments change orders. |
| Already `paid`, `picked_up`, or `needs_review` | 200 `{"result":"ignored","reason":"already_final"}` | Preserve final state and warn about a possible double charge. |
| Captured amount differs from total | 200 `{"result":"needs_review","reason":"amount_mismatch"}` | Flag the discrepancy for review. |
| Correct capture within active hold | 200 `{"result":"paid"}` | Set `paid_at` with the DB clock; paid items stay reserved. |
| Late capture, all stock available | 200 `{"result":"paid","late":true}` | Reclaim stock safely and honour the payment. |
| Late capture, any stock unavailable | 200 `{"result":"needs_review","reason":"late_payment_stock_unavailable"}` | Avoid overselling and flag the payment for refund. |

## Try it

Start the stack with `docker compose up --build -d`. From the repository root, place an order
and capture its ID. These commands use Node, so no `jq` installation is needed.

```sh
ORDER_ID=$(curl -fsS http://localhost:4000/orders \
  -H 'Content-Type: application/json' \
  -d '{"items":[{"productId":1,"quantity":1}]}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).id')

# Host: fetches the order total and generates/prints an evt_<random> eventId.
(cd backend && npm run send-webhook -- "$ORDER_ID")

# Copy the printed eventId to resend exactly the same event.
EVENT_ID=evt_replace_with_printed_id
(cd backend && npm run send-webhook -- "$ORDER_ID" --event "$EVENT_ID")

# Deliberately rejected with HTTP 401. The script exits 1 on non-2xx responses.
(cd backend && npm run send-webhook -- "$ORDER_ID" --bad-signature)

# The same script is also available inside the running backend container.
docker compose exec backend npm run send-webhook -- "$ORDER_ID" --event "$EVENT_ID"
```

The CLI reads `API_URL`, default `http://localhost:4000`, and `WEBHOOK_SECRET`,
default `local-development-webhook-secret`, matching Compose. Export the same secret on the host
if you changed it in Compose. Inside the backend container, localhost points to its own API.
The CLI does not need database credentials. Optional `--amount <paise>` skips the order fetch;
`--status <status>` defaults to `captured`. For example, use `--amount 1` to demonstrate review
or `--status failed` on a fresh order to demonstrate an ignored event.

## Next steps

- Add a refund flow for amount mismatches, unavailable late-payment stock, and potential double charges from distinct captures of an already-paid order. Step 3 records/warns but does not issue refunds.
