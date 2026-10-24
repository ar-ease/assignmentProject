# Pickup Counter

Initial setup only. Orders, payment webhooks, and pickup endpoints come later.

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
`npm test` defaults to the local `pickup_test` URL and migrates it automatically.
Tests truncate only the test database. Do not run tests concurrently against that database.

The seed inserts missing snacks and preserves existing stock on restart.
The Docker backend startup runs migrations, seed, then the compiled server.

<!-- Future script: send-webhook will be added with payment handling. -->

Further assignment documentation to follow.
