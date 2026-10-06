# How to: Read, change and prove a key's rate limit

`ApiKey.rateLimit` is enforced per key since A2-301: **requests per 60-second window**
(fixed, epoch-aligned), 429 + `Retry-After` past it. This page covers the three things an
operator needs around it (A2-319). The database is not an interface — do not edit the
`ApiKey` row by hand.

All admin routes need `ADMIN_TOKEN` (header `x-admin-token`). `/admin` is denied at the
public vhost, so run these **on the MC host over loopback** — or inside the container, where
the token is already in the environment.

## Read one key

```bash
curl -s http://127.0.0.1:3900/admin/keys/<id> -H "x-admin-token: $ADMIN_TOKEN"
# → {"id":"…","name":"…","rateLimit":60,"active":true,"createdAt":"…"}
```

`GET /admin/keys` lists all of them in the same shape. Neither returns a key or its hash.

## Change the limit of an existing key

```bash
curl -s -X PATCH http://127.0.0.1:3900/admin/keys/<id>/rate-limit \
  -H "x-admin-token: $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"rateLimit":120,"actor":"<who-you-are>","reason":"<one line, optional>"}'
# → {"id":"…","rateLimit":120,"previousRateLimit":60,…}
```

- `rateLimit`: integer 1..10000 (the same bounds as creation).
- `actor`: **required**. `ADMIN_TOKEN` is one shared secret, so it proves permission, not
  identity; `actor` is who made the change. Letters, digits and `. _ @ : / -` only.
- In force on the **next request** (the limiter's 10 s cache is invalidated on write).
- One `WARN [AdminService] admin: rateLimit changed keyId=… name=… 60 -> 120 active=…
actor=… ip=… reason=…` line lands in the container log. That line is the audit record;
  it never carries a key value.

## Prove a 429 can happen

`scripts/rate-limit-probe.mjs` mints two disposable keys, bursts one past a small limit
(default 2) against `GET /connectors` (no provider cost), requires `200 × limit` then `429`
with `Retry-After ≥ 1`, requires the other key to stay at `200`, and **always** revokes
both keys.

```bash
docker exec model-connector-model-connector-1 \
  node scripts/rate-limit-probe.mjs --via patch --actor <who-you-are>
# … limited (limit 2): 200 200 429[Retry-After 37] 429[Retry-After 37]
# … within  (limit 60): 200 200 200
# VERDICT PASS
```

| exit | meaning                                                                         |
| ---- | ------------------------------------------------------------------------------- |
| 0    | PASS — a 429 with Retry-After was observed and the other key was not throttled  |
| 1    | FAIL — e.g. no 429 at all (this is what a build without `RateLimitGuard` gives) |
| 2    | could not run — no `ADMIN_TOKEN`, admin API refused, key not minted             |

`--via patch` also exercises `PATCH /admin/keys/:id/rate-limit`; `--via create` (default)
sets the limit at creation and works on builds that predate that route. The two revoked
probe keys stay in `ApiKey` as `active=false` rows named `rl-probe-<timestamp>-*`.
