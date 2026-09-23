A2-210 — verifier output for change-admission-a2-210-*.json
===========================================================

Raw output of `tools/graph/verify.py --repo . --select targeted_test`, plus the
A/B measurements this receipt's exemptions rest on.

RE-ISSUED on a corrected range: A2-209 (#140) landed on main while this card was
running, so the branch was rebased from 70cee53469b0 onto 41d6f67 and every
measurement here was taken again against the new base. The figures did not move
(147 = 147 tsc errors, 8 = 8 failing contract edges), but a receipt bound to a
range that no longer exists would cover nothing, so it was re-issued rather than
edited in place.

The receipt itself covers 41d6f67..<this commit>, which is that range plus
this directory. The verifier was re-run on the wider range and returned the same
picture — the same 20 `failed` entities with the same reasons and the same 199
`not_measured` — with one additional `verified` entity, this document, reached
through its own doc_reference edge. The v-*.json / v-*.txt files below are the
narrower run, because that is the run whose head is the code this receipt is
about.

  v-*.json / v-*.txt          verifier output, as written by the tool
  v-type-check-tsconfig-ab.txt  A/B of the 147-error tsc baseline: 147 at base,
                                147 at head, identical location set, none in a
                                touched file
  v-contract-diff-ab.txt        A/B of the 8 failing contract edges: identical
                                set at base and head
  contract-diff-base-ab.json    the base-side run behind that A/B
  tests-red-green.txt           red on main / green on branch, per defect, plus
                                the two Node probes the change rests on

The RelationshipGraph/v1 instances for base and head are not committed: they are
1.1 MB each and rebuild deterministically from the two revisions with
`tools/graph/build_graph.py`.
