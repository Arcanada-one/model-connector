#!/usr/bin/env bash
# DEC-AUP-0197 B9: the offline dependency setup the Program gate runs in each of its two private
# worktrees (base and head) before the declared full_test. Declared in .arcana/verify.json as
# deployables["."].full_test_parity_setup and read at BASE only. The gate routes every proxy variable to
# a closed port and sets npm_config_offline, so any network fetch here fails the setup (fail closed).
set -euo pipefail
pnpm install --frozen-lockfile --offline --ignore-scripts --ignore-pnpmfile
# Same dummy DATABASE_URL as CI: prisma generate needs a URL string even though it only writes the client.
DATABASE_URL=postgresql://dummy:dummy@localhost:5432/dummy pnpm exec prisma generate
