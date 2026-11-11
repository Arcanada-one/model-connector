# Protected Lab environment keys

Stage A protected reservation profile is server-selected. These keys are declared
as bare `KEY=` lines in the root `.env.example` so graph admission can scope the
diff via `env_example_key_delta`.

| Key | Meaning |
|-----|---------|
| `PROTECTED_LAB_PROFILE` | Enables `/connectors/:name/protected/*`. Empty, unset, `false`, `0`, or `no` means disabled (routes 404). Does **not** flip `BILLING_ENFORCED`. |
| `PROTECTED_LAB_CONNECTORS` | Comma-separated allow-list. Empty admits no connector even when the profile is on. |

Canonical schema comments live in `src/config/env.schema.ts`.
