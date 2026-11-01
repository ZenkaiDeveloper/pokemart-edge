# pokemart-edge

MIT-licensed **Edge foundation** for [PokeMart](https://pokemart.online) — Cloudflare Worker + D1 for magic-link accounts and a nightly HMAC ingest of derived ladder tables from the Mac ledger.

Canonical open-source home: [`ZenkaiDeveloper/pokemart-edge`](https://github.com/ZenkaiDeveloper/pokemart-edge).  
A copy also lives at `public_site/worker/pokemart-edge/` next to the other handwritten Workers (never inside the generated deploy tree).

## What this Worker does

| Path | Role |
|------|------|
| `/account/*` | Magic-link sign-in, session cookie, logout, hard delete |
| `/api/user/me` | Current user JSON |
| `/api/user/delete` | Hard-delete (JSON) |
| `/api/internal/ladder-export` | Signed nightly ingest of `ladder_latest` (+ history while ≤20k writes) |
| `/health` | Liveness |

**Write budget:** D1 free tier is tight (~10k sold-backed cells today). Nightly ingest upserts `ladder_latest` (count must match Mac `n>0`) and applies same-day `ladder_history_90d` rows only while total writes stay ≤ 20k (logged in `export_log`). A dual full refresh would exceed the cap — chunked 90d history backfill is a follow-up.

Static card pages stay on the assets Worker. Attach this Worker only to `/account/*`, `/api/user/*`, and `/api/internal/*` on `pokemart.online` (or a staging hostname).

## Auth model

- No passwords. Magic-link tokens are 256-bit random, stored as SHA-256 hashes, single-use, 15-minute expiry.
- Session cookie `pm_session`: `HttpOnly; Secure; SameSite=Lax`, 30 days.
- Rate limits: **3** link requests / hour / email and **10** / hour / IP (D1 `rate_limits`).
- `/account/delete` removes the user and every dependent `user_id` row in the same request.

## Secrets & DNS (Andy)

| Item | Where |
|------|--------|
| `SESSION_SECRET` | Worker secret (reserved for future signed payloads) |
| `EXPORT_HMAC_SECRET` | Worker secret **and** Mac `.env` `EDGE_EXPORT_HMAC_SECRET` (same value) |
| `RESEND_API_KEY` or `POSTMARK_SERVER_TOKEN` | Worker secret |
| `EMAIL_FROM` | wrangler `vars` (default `PokeMart <noreply@mail.pokemart.online>`) |
| D1 `pokemart-edge` | `wrangler d1 create` → paste `database_id` into `wrangler.jsonc` |
| R2 `pokemart-edge-archive` | optional nightly export receipt archive |
| Routes | Cloudflare → Worker routes: `pokemart.online/account/*`, `/api/user/*`, `/api/internal/*` |
| Sending domain | SPF/DKIM/DMARC for `mail.pokemart.online` (Resend/Postmark) |
| Mac env | `EDGE_EXPORT_URL=https://pokemart.online/api/internal/ladder-export` |

```bash
cd public_site/worker/pokemart-edge
npx wrangler login
npx wrangler d1 create pokemart-edge
# edit wrangler.jsonc database_id
npx wrangler d1 migrations apply pokemart-edge --remote
npx wrangler r2 bucket create pokemart-edge-archive
npx wrangler secret put EXPORT_HMAC_SECRET
npx wrangler secret put RESEND_API_KEY
npx wrangler deploy
```

Mac nightly (after snapshots):

```bash
# .env
EDGE_EXPORT_URL=https://pokemart.online/api/internal/ladder-export
EDGE_EXPORT_HMAC_SECRET=…   # same as Worker secret
python3 -m src.export_to_edge
```

## Tests

```bash
npm test
```

Covers magic-link E2E (capture inbox + clock), rate limits, hard delete zero-rows, HMAC reject/accept, and write-budget logging.

## Do not

- Store passwords, card numbers, or postal addresses
- Send marketing mail
- Let the Worker author price data (Mac export only)
- Ship alerts or portfolio here (M2.1 / M2.2)
- Put this code in the generated site repo

## License

MIT — see `LICENSE`.
