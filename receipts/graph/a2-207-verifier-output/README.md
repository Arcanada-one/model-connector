# A2-207 — verifier output behind `change-admission-a2-207-*.json`

Captured by `tools/graph/verify.py 1.0.1` (Arcanada-one/arcanada-universal-program) on arcana-devs,
2026-09-23, for `main..arc2/a2-207-connector-timeout-retryafter`.

The two `graph-*.json` dumps the run also produced (968K each) are deliberately NOT committed: the
receipt records their `graph_digest`, and `verify.py --graph auto` rebuilds them from git objects at
the same commits. Same choice as `change-admission-a2-201-*.json.d`, which kept only the text outputs.

| File | What it is |
|---|---|
| `v-type-check-tsconfig.txt` | full `tsc --noEmit -p tsconfig.json` output at head |
| `v-type-check-tsconfig-ab.txt` | the A/B behind the one exemption: 147 errors at base, 147 at head, none in a changed file |
| `v-targeted-test-root.txt` | `pnpm test` (vitest) over the impact set |
| `v-type-check-packages-sdk-ts-tsconfig.txt` | `tsc` over `packages/sdk-ts` |
| `v-targeted-test-packages-sdk-ts.txt` | what the profile's sdk-ts test verifier did (see the `not_measured` note in the receipt) |
| `v-contract-diff.json`, `v-config-schema.json`, `v-fitness.json`, `v-canary.json`, `v-doc-reference.txt` | the remaining matrix verifiers |
| `sdk-suites-by-hand.txt` | the two SDK suites run by hand, red before / green after — evidence for a reader, not a verifier verdict |
