# Integration tests

These hit a real Postgres database and are NOT run by `npm test` (the unit
tests in `src/**/__tests__/*.test.ts` cover pure logic and run with no
database — those are the ones CI should always run).

## Why these are separate

This sandbox has no network access to any Postgres instance, so these
could be written and reviewed here but never actually executed — same
limitation noted throughout this project for anything needing the real
database or Paystack's API. Run them yourself once you have a spare
database to point at.

## Running them

1. Create a **separate, disposable** database — never point this at your
   real business data, since these tests create and delete records freely.
   A second free Supabase project, or `createdb salepoint_test` locally,
   both work.
2. Set `TEST_DATABASE_URL` in `.env` to that database's connection string.
3. `npx prisma migrate deploy` against it (or `DATABASE_URL=$TEST_DATABASE_URL npx prisma migrate dev`).
4. `npm run test:integration`

Each test file resets its own data with `beforeEach`, and the whole suite
is skipped automatically (not failed) if `TEST_DATABASE_URL` isn't set —
see `src/__tests__/integration/setup.ts`.
