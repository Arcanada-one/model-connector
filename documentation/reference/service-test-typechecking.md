# Service test type checking

Run `pnpm exec tsc -p tsconfig.test.json --listFiles --pretty false` from the
repository root. The project inherits the service's compiler options and disables
emission and incremental caching. It covers service source, root service tests,
benchmark reservation fixtures and tests, prompt cache fixtures, and the two
listed Vitest configurations.

In particular, the compiler's file list must contain `test/app.e2e-spec.ts` and
`test/bench-reservation/boundary-http.spec.ts`. The production `tsconfig.json`
excludes `test`; successful production compilation alone does not check these
files. The native graph verifier discovers the sibling `tsconfig.test.json` and
selects it for service test code units.

The watcher is a separate deployable with its own `watcher/tsconfig.json` and
NodeNext module settings. The forwarding files under `test/watcher` import that
deployable's ESM tests and are outside this CommonJS service project. This project
does not establish their compiler coverage or replace watcher verification.

Compiler success establishes type compatibility for the listed project. It does
not execute HTTP tests, qualify a deployed route, authorize key rotation, or
replace graph admission and the canonical merge gate.
