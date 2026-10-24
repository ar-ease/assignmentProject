# Pickup Counter handoff

Generated from the setup session on 2026-10-24. This document briefs an incoming LLM without requiring the original conversation.

## Goal and authorized scope

Pickup Counter is a take-home assignment for a self-service snack counter. Eventually customers will order snacks, pay by UPI through a simulated webhook, and collect from a locker.

Only initial setup was authorized and completed. DO NOT implement order creation, payment webhooks, HMAC verification, expiry processing, or pickup until the user supplies the next step. Their database models exist because the initial setup explicitly required them. The availability query reads order records, but no order endpoints exist.

## Current state

Repository: `/Users/ar-ease/Developer/Projects/assignments/assignmentProject`.

Implementation commit: `ec4dd8e` — `Set up Pickup Counter API, database, and frontend`.

The working tree was clean before this handoff was created. This handoff is uncommitted. No push or deployment was performed.

The stack was started with `docker compose up --build -d`. All three services were running at the end of setup, with the database healthy. Recheck their status when resuming; this document records completed verification, not a promise that containers are still running.

## Fixed stack and constraints

- Two independent npm packages in `backend/` and `frontend/`. No workspaces or monorepo tooling.
- Strict TypeScript, Node 20. Both Dockerfiles use `node:20-slim`; `.nvmrc` specifies 20.
- Backend: Express 5, Prisma 6.19.3, PostgreSQL 16, zod 4, cors, tsx.
- Frontend: Next.js App Router and React. Lockfile resolved Next.js 16.4.3 during verification.
- Tests: Vitest 4.1.12 and supertest against real PostgreSQL. No database mocks.
- Express is the only backend. Do not introduce Next.js API routes.
- Customer UI is a client component calling Express directly from the browser.
- All money is integer paise. No Float or Decimal money fields. Convert to rupees only for display.
- Use snake_case PostgreSQL table and column names; later steps will use raw SQL.
- Database time, `now()`, determines reservation expiry. Do not replace it with JavaScript time.
- Keep changes small and focused. User's active Ponytail preference asks for the smallest complete solution and a brief final note on omitted checks and known risks.

## Files and implementation

### Root and Docker

| File | Purpose |
| --- | --- |
| `docker-compose.yml` | Defines `db`, `backend`, and `frontend`, ports, environment defaults, named PostgreSQL volume, and healthy database dependency. |
| `docker/db/init.sql` | Creates `pickup` and `pickup_test` during first initialization of a fresh PostgreSQL volume. |
| `.env.example` | Working Compose environment defaults. No `.env` is needed to start Compose. |
| `.nvmrc` | Selects Node 20 for local development. |
| `README.md` | Brief setup/test commands and placeholders for later assignment documentation. Includes an HTML comment for a future send-webhook script. |
| `AI_NOTES.md` | Placeholder for future implementation notes. |
| `LICENSE`, `.gitignore` | Pre-existing repository files; not changed during setup. |

Compose publishes frontend 3000, API 4000, and PostgreSQL 5432.

Default Compose environment:

```dotenv
DATABASE_URL=postgresql://pickup:pickup@db:5432/pickup?connection_limit=20
TEST_DATABASE_URL=postgresql://pickup:pickup@db:5432/pickup_test?connection_limit=20
WEBHOOK_SECRET=local-development-webhook-secret
PORT=4000
NEXT_PUBLIC_API_URL=http://localhost:4000
```

These are development credentials. The browser API URL must remain `localhost`, not `db` or `backend`.

`db` uses `postgres:16`, `POSTGRES_DB=postgres`, and a `pg_isready -U pickup -d pickup` healthcheck. Its init SQL creates both assignment databases. Init scripts only run on an empty data volume.

`backend/Dockerfile` installs OpenSSL on Debian slim, runs `npm ci`, then `prisma generate` and the TypeScript build. Default container startup runs migration deploy, then seed, then the compiled server. The frontend runs `next dev -H 0.0.0.0 -p 3000`.

### Backend

| File | Purpose |
| --- | --- |
| `backend/package.json`, `backend/package-lock.json` | Independent backend dependencies, lockfile, and scripts. |
| `backend/tsconfig.json` | Strict TypeScript with NodeNext modules; outputs to `dist/`. |
| `backend/Dockerfile`, `backend/.dockerignore` | Node 20 image build and context exclusions. |
| `backend/src/db.ts` | Exports one PrismaClient and `withTx(fn)`, using `maxWait: 10000` and `timeout: 10000`. Callback receives a Prisma transaction client suitable for later row-locking SQL. |
| `backend/src/app.ts` | Exports `app` without listening. Enables CORS for `http://localhost:3000`, mounts health/products routes, then JSON 404 and error handling. |
| `backend/src/server.ts` | Listens on `PORT`, default 4000, on `0.0.0.0`. |
| `backend/src/errors.ts` | `AppError(status, code, message)` and central error handler returning `{ error: { code, message } }`. Zod errors become readable 400 responses; unexpected errors become generic 500 responses and are logged. |
| `backend/src/routes/products.ts` | Implements GET `/products` using one raw SQL query. |
| `backend/prisma/schema.prisma` | Required schema with snake_case mappings. |
| `backend/prisma/seed.ts` | Exported reusable `seed(db = prisma)` and CLI entrypoint. |
| `backend/prisma/migrations/20261024092003_init/migration.sql` | Generated initial migration with manually added CHECK constraints. |
| `backend/prisma/migrations/migration_lock.toml` | Prisma PostgreSQL migration lock. |

There is deliberately no global `express.json()` middleware. A comment in `app.ts` says future JSON routers should mount their own JSON parsing, preserving `/payments/webhook` for `express.raw()` and HMAC verification over original bytes.

Backend scripts:

```text
dev         tsx watch src/server.ts
build       tsc
start       node dist/src/server.js
test        vitest run
db:migrate  prisma migrate deploy
db:seed     tsx prisma/seed.ts
```

GET `/health` returns `{ "status": "ok" }`. It is a liveness response, not a database readiness probe.

GET `/products` returns an array containing `id`, `name`, `pricePaise`, `stock`, and `availableUnits`.

Its single `$queryRaw` query uses LEFT JOINs, SUM with FILTER, and COALESCE. It reserves quantities for active pending orders with `expires_at > now()`, plus all paid orders. Expired pending orders and statuses expired, needs_review, and picked_up do not reserve stock. Final availability is cast to PostgreSQL `int` to avoid BigInt JSON serialization failures. Results are ordered by product ID.

### Database schema

- `Product` maps to `products`: auto-increment integer `id`, unique `name`, integer `price_paise`, integer `stock`.
- `OrderStatus` maps to PostgreSQL enum `order_status`: pending, paid, expired, needs_review, picked_up.
- `Order` maps to `orders`: Prisma-generated UUID `id`, pending default `status`, integer `total_paise`, timestamptz `expires_at`, `created_at` default now, nullable timestamptz `paid_at` and `picked_up_at`. Index on `(status, expires_at)`.
- `OrderItem` maps to `order_items`: UUID `order_id`, integer `product_id`, integer `quantity`, integer `unit_price_paise`. Composite primary key `(order_id, product_id)` and relations to orders/products.
- `WebhookEvent` maps to `webhook_events`: string primary key `event_id`, nullable UUID `order_id`, JSONB `payload`, timestamptz `received_at` default now. No foreign key from webhook events was requested or added.
- UUID defaults on orders are generated by Prisma, not a SQL UUID default. Raw SQL fixtures explicitly supply UUIDs.

Migration was generated using `prisma migrate dev --create-only --name init`, then manually extended with:

```sql
ALTER TABLE "products" ADD CONSTRAINT "products_stock_check" CHECK (stock >= 0);
ALTER TABLE "products" ADD CONSTRAINT "products_price_paise_check" CHECK (price_paise > 0);
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_quantity_check" CHECK (quantity > 0);
```

All three constraints were confirmed in the running app database via PostgreSQL's constraint catalog. Migration files are committed.

Seed contents:

| Name | Price in paise | Initial stock |
| --- | ---: | ---: |
| Samosa | 2000 | 20 |
| Masala Chips | 2500 | 15 |
| Chai | 1500 | 25 |
| Veg Puff | 3000 | 2 |
| Peanut Chikki | 1000 | 12 |

Seed uses upsert by name with an empty update. Re-running it inserts missing products but does not reset existing stock or prices. Test resets truncate first, so tests get original seed values.

### Tests

| File | Purpose |
| --- | --- |
| `backend/vitest.config.ts` | Sets DATABASE_URL to TEST_DATABASE_URL during config loading, before Prisma imports. Defaults to localhost pickup_test URL, forwards the URL through Vitest test env, disables file parallelism, registers global/setup files. Rejects database names other than `pickup_test` because tests truncate tables. |
| `backend/tests/global-setup.ts` | Runs `npm run db:migrate` against the test database before test workers. |
| `backend/tests/setup.ts` | Exports `resetDatabase()`, truncates the four application tables with RESTART IDENTITY CASCADE before each test, reseeds, disconnects Prisma after tests. |
| `backend/tests/products.test.ts` | Three integration tests: five available products with no orders; reservation filtering across all statuses; seed idempotency and preservation of changed stock. |

The reservation test creates raw SQL fixtures without introducing order endpoints. It verifies Samosa availability is 17 from stock 20 after one active pending unit and two paid units; other order statuses and expired pending holds do not subtract units.

### Frontend

| File | Purpose |
| --- | --- |
| `frontend/package.json`, `frontend/package-lock.json` | Independent Next.js dependencies, scripts, and lockfile. |
| `frontend/tsconfig.json`, `frontend/next-env.d.ts` | Strict App Router TypeScript setup. |
| `frontend/Dockerfile`, `frontend/.dockerignore` | Node 20 image and context exclusions. |
| `frontend/app/layout.tsx` | Root layout, English document language, metadata, global CSS. |
| `frontend/app/page.tsx` | Client component fetching `/products` from NEXT_PUBLIC_API_URL. Lists name, price, and availability. Loading and error states; cancels fetch on unmount. Small paise formatting helper. |
| `frontend/app/globals.css` | Minimal plain CSS. No UI library. |

No ordering, checkout, payment, or pickup UI exists.

## Completed verification

These results were obtained during setup:

1. `docker compose up --build -d` succeeded. Backend and frontend were up, PostgreSQL was healthy.
2. Backend startup logs showed migration deploy, seed, and listening on 4000 in that order.
3. `curl http://localhost:4000/health` returned `{"status":"ok"}`.
4. Frontend at `http://localhost:3000` returned HTTP 200.
5. `docker compose run --rm backend npm test` exited 0: one test file, three tests passed against pickup_test.
6. `docker compose run --rm --no-deps frontend npm run build` exited 0: compiled successfully, TypeScript passed, static pages generated.
7. Backend TypeScript build passed as part of the Docker build.
8. Database catalog inspection confirmed all three CHECK constraints.
9. `git diff --check` passed before commit, and working tree was clean after commit.

Product response:

```json
[
  {"id":1,"name":"Samosa","pricePaise":2000,"stock":20,"availableUnits":20},
  {"id":2,"name":"Masala Chips","pricePaise":2500,"stock":15,"availableUnits":15},
  {"id":3,"name":"Chai","pricePaise":1500,"stock":25,"availableUnits":25},
  {"id":4,"name":"Veg Puff","pricePaise":3000,"stock":2,"availableUnits":2},
  {"id":5,"name":"Peanut Chikki","pricePaise":1000,"stock":12,"availableUnits":12}
]
```

## Failed attempts and workarounds

- Docker was installed but Colima was stopped. Started Colima successfully. Sandbox access to the Docker socket required escalation; Docker Compose commands were subsequently approved.
- Sandboxed npm installs and Prisma engine downloads failed with `ENOTFOUND` for registry.npmjs.org and binaries.prisma.sh. Re-ran with approved network access. Do not mistake those sandbox failures for broken package names.
- The host runs Node 24 and npm 11. Package engine warnings on the host were expected. Runtime/build verification used Node 20 containers.
- The first backend container build failed `npm ci` with missing esbuild lock entries. Regenerated the backend lockfile using `npx --yes npm@10 install --package-lock-only --ignore-scripts` to match the Node 20 image's npm major. The subsequent image build passed.
- Local Prisma migration generation failed with `P1010: User was denied access on the database`. A pre-existing host PostgreSQL process was listening on localhost:5432, so that command reached the wrong database. Did not stop or alter the host server. Generated the migration inside Docker with the backend Prisma directory mounted and database hostname `db`.
- Product tests were first run against the minimal Express app before adding the product route. Both endpoint tests failed with expected 404 responses. After implementation, all three tests passed.
- Initial curl commands inside the sandbox could not connect to the published local ports. Approved curl access succeeded for API and frontend.
- Updated older dependencies after audit findings: Prisma/client to 6.19.3, Vitest to 4.1.12, zod to 4.6.7, and compatible Express/cors updates. Backend npm audit still reported three high-severity findings in Prisma tooling dependencies. Do not claim the dependency tree is vulnerability-free. No forced major Prisma upgrade or overrides were applied.

## Known limits and unverified behavior

- Interactive browser behavior was not tested. The frontend was checked by HTTP response and production build.
- Local npm tests against localhost PostgreSQL were not verified because the pre-existing host server conflicts with the Compose port. Docker tests passed. Local tests require correctly configured accessible pickup_test credentials.
- Current init SQL explicitly creates both databases, but initial database bootstrapping during the session used POSTGRES_DB=pickup and an init SQL script creating pickup_test. This was then changed to POSTGRES_DB=postgres plus explicit creation of both databases. A second empty-volume initialization was not performed after that edit. Do not delete existing volumes casually to recheck it.
- No concurrency tests or row-locking behavior have been implemented yet; both connection URLs include connection_limit=20 for later ten-transaction tests.
- No webhook route or raw-body HMAC verification exists yet. Preserve the parser design when adding it.
- There is no send-webhook npm script yet; its future addition is noted in a README comment.
- No production deployment or hardening was requested.

## Next steps for the incoming LLM

1. Read this file and inspect `git status --short` and the relevant source before changing anything.
2. Wait for the user's next assignment step. Do not infer permission to implement deferred features from this handoff.
3. To recheck the existing setup, run:

   ```sh
   docker compose up --build -d
   docker compose ps
   curl -fsS http://localhost:4000/products
   docker compose run --rm backend npm test
   ```

4. For future transactional order work, build on `withTx(fn)` in `backend/src/db.ts` and the existing mapped schema. Row-locking SQL is anticipated but not implemented.
5. For future payments, mount raw parsing on `/payments/webhook` before any parser that consumes its body. The HMAC must cover original bytes.
6. Treat this handoff as an uncommitted scratch briefing. Do not commit it unless the user asks.
