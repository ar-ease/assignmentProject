# AI notes

This account covers the work recorded in this conversation.

## Tools and what I used them for

I used Codex to inspect the repository, implement pickup, add tests and update
documentation. Git showed the changes and restored the mutation experiment.
Docker ran Node 20 and real PostgreSQL 16. Vitest checked API and frontend logic;
TypeScript and the frontend build checked compilation. I used curl for the live
pickup and repeat-claim requests.

## A prompt that worked well

"This conditional update is the concurrency guarantee"

That instruction came with the SQL predicate, lock order, response codes and
concurrent test cases. It gave the implementation a concrete contract. The
requested mutation then checked whether the tests detected losing that guarantee.

## What the AI got wrong and how I noticed

- The AI ran the requested search with unquoted include patterns in zsh. The output
  said "no matches found", so the search had not run. I reran it with quoted patterns.
- The AI initially cloned into an unshared temporary directory. PostgreSQL
  reported that init.sql was a directory. I checked Colima's mount configuration,
  moved the temporary clone under /tmp/colima and verified startup again.

## How I checked AI output

I ran the restored backend suite three times: 92 tests passed each time. Frontend
tests passed 8 and the production build passed. Both simultaneous-pickup tests
failed in all three mutation runs. I restored the source and compared its diff
with the saved correct implementation. A separate agent also reviewed the source
and tests read-only and reported no actionable findings.

The review used a separate agent; I did not verify that it used a different model.
Browser controls were unavailable, so I checked the UI through source review,
unit tests and a production build. I exercised payment, pickup and repeat claims
through HTTP requests. I did not perform manual browser testing.
