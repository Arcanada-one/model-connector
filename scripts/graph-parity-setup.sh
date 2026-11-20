#!/usr/bin/env bash
# DEC-AUP-0197 B9: the offline dependency setup the Program gate runs in each of its two private
# worktrees (base and head) before the declared full_test. Declared in .arcana/verify.json as
# deployables["."].full_test_parity_setup; the gate reads the declaration and this script at BASE.
#
# What this script controls:
#   - pnpm install is --offline: a package missing from the store fails the setup.
#   - prisma generate runs with CHECKPOINT_DISABLE=1, so Prisma makes no checkpoint (update-check and
#     telemetry) call. That call ignores proxy variables, so only this variable or a network namespace
#     stops it.
#   - If the Prisma engine is not already in the user's cache, generate tries to download it and fails
#     (the download honours the proxy variables): the setup fails closed.
# What the gate must control, not this script: the network namespace, a private HOME, pnpm store and
# TMPDIR per worktree, a scrubbed environment with no credentials, and refusing a head whose .npmrc,
# pnpm-workspace.yaml or package.json pnpm policy differs from base.
set -euo pipefail
pnpm install --frozen-lockfile --offline --ignore-scripts --ignore-pnpmfile
# Same dummy DATABASE_URL as CI: prisma generate needs a URL string even though it only writes the client.
CHECKPOINT_DISABLE=1 PRISMA_HIDE_UPDATE_MESSAGE=1 DATABASE_URL=postgresql://dummy:dummy@localhost:5432/dummy pnpm exec prisma generate
