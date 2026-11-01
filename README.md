# pokemart-edge

MIT-licensed **Edge Worker** for [PokeMart](https://pokemart.online) — Cloudflare Worker + D1 for magic-link accounts, nightly HMAC ladder ingest, **sold-evidence alerts**, and **portfolio with cost basis**.

Canonical open-source home: [`ZenkaiDeveloper/pokemart-edge`](https://github.com/ZenkaiDeveloper/pokemart-edge).  
A copy also lives at `public_site/worker/pokemart-edge/` next to the other handwritten Workers (never inside the generated deploy tree).

## What this Worker does

| Path | Role |
|------|------|
| `/account/*` | Magic-link sign-in, session cookie, logout, hard delete |
| `/account/alerts` | Create / list / disable sold-evidence alert rules |
| `/account/portfolio` | Holdings, cost basis, CSV import/export, migrate, share |
| `/account/portfolio/share/view?token=` | Read-only shared portfolio (cost hidden by default) |
| `/account/unsubscribe` | One-click email unsubscribe (no login) |
| `/account/alerts/rss.xml?token=` | Private RSS feed |
| `/api/user/me` | Current user JSON |
| `/api/user/alerts` | JSON CRUD for rules |
| `/api/user/portfolio` | JSON portfolio summary / add holding |
| `/api/user/delete` | Hard-delete (JSON) |
| `/api/internal/ladder-export` | Signed nightly ingest of `ladder_latest` (+ history while ≤20k writes) |
| Cron `0 10 * * *` UTC | Evaluate rules → deliver pending events |
| `/health` | Liveness |

**Write budget:** D1 free tier is tight (~10k sold-backed cells today). Nightly ingest upserts `ladder_latest` (count must match Mac `n>0`) and applies same-day `ladder_history_90d` rows only while total writes stay ≤ 20k. Alert evaluation worst-case event writes at 1,000 users × 10 rules = **10,000** (logged by cron).

Static card pages stay on the assets Worker. Attach this Worker to `/account/*`, `/api/user/*`, and `/api/internal/*` on `pokemart.online`.

## Alerts (M2.1)

- Kinds: `median_above` · `median_below` · `pct_move_7d` · `new_comp` · `passport_change`
- Fire **only** when Passport is A–C (headline-allowed). D-grade cells never alert.
- Channels: email (double opt-in + `List-Unsubscribe`), Discord webhook (AES-GCM at rest, URL validated), private RSS
- Caps: 20 active rules / free user; 1 digest email / day; 3 immediate threshold emails / day
- Idempotent events: `UNIQUE(rule_id, snapshot_date)`
- **Excluded:** live listings, “undervalued”, restocks, auction-ending alerts

## Portfolio (M2.2)

- Schema: `holding`, `sale`, `valuation_history`, `share_link` (`migrations/0003_portfolio.sql`)
- Value at `p50` only when Passport ≥ C; unpriced lines listed with reason (never zero / guess)
- Totals: “priced X of Y”; ranges p25–p75; unrealized = value − known cost; realized uses shared eBay fee table when fees omitted
- CSV import (generic mapping) + export; migrate `pokemart_watchlist_v1` / `pokemart_collection_v1`
- Share links: 128-bit token, revocable, cost hidden unless opted in
- Browser-local Collection UI also tracks optional cost (no account)

## Auth model

- No passwords. Magic-link tokens are 256-bit random, stored as SHA-256 hashes, single-use, 15-minute expiry.
- Session cookie `pm_session`: `HttpOnly; Secure; SameSite=Lax`, 30 days.
- Rate limits: **3** link requests / hour / email and **10** / hour / IP (D1 `rate_limits`).
- `/account/delete` removes the user and every dependent `user_id` row (including alert rules/events) in the same request.

## Secrets & DNS (Andy)

| Item | Where |
|------|--------|
| `SESSION_SECRET` | Worker secret |
| `WEBHOOK_ENC_SECRET` | Worker secret (Discord URL encryption; falls back to `SESSION_SECRET`) |
| `EXPORT_HMAC_SECRET` | Worker secret **and** Mac `.env` `EDGE_EXPORT_HMAC_SECRET` |
| `RESEND_API_KEY` or `POSTMARK_SERVER_TOKEN` | Worker secret |
| `EMAIL_FROM` | wrangler `vars` (default `PokeMart <noreply@mail.pokemart.online>`) |
| D1 `pokemart-edge` | `wrangler d1 create` → paste `database_id`; apply migrations **0001 + 0002** |
| R2 `pokemart-edge-archive` | optional nightly export receipt archive |
| Routes | `/account/*`, `/api/user/*`, `/api/internal/*` |
| Sending domain | SPF/DKIM/DMARC for `mail.pokemart.online` — verify with `scripts/check_sending_dns.sh` |
| Mac env | `EDGE_EXPORT_URL` + `EDGE_EXPORT_HMAC_SECRET` |

```bash
cd public_site/worker/pokemart-edge
npx wrangler login
npx wrangler d1 migrations apply pokemart-edge --remote   # includes 0002_alerts
npx wrangler secret put WEBHOOK_ENC_SECRET
npx wrangler deploy
./scripts/check_sending_dns.sh mail.pokemart.online pokemart.online
```

## Tests

```bash
npm test
```

Covers magic-link E2E, export HMAC, **alerts fixture (5 users / 12 rules / 2 snapshots → 7 events; re-run → 0)**, rule cap, unsubscribe without login, banned-phrase email copy, write-budget estimate ≤10k @ 1k×10.

## Do not

- Store passwords, card numbers, or postal addresses
- Send marketing mail or alert before double opt-in
- Let the Worker author price data (Mac export only)
- Alert on live listings / restocks / auction endings
- Put this code in the generated site repo

## License

MIT — see `LICENSE`.
