# LicenseManagerTGG

Discord license-management bot for TGGLR. The Vercel backend (`api/`) remains
the source of truth for all license data; the bot is a separate persistent
Node.js process that talks to it through the existing management API.

## Setup

```bash
cd bot
npm install
copy .env.example .env   # (Windows) and fill in real values
npm start
```

`bot/.env` variables:

| Variable | Required | Purpose |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | yes | Bot token (reset it if it was ever shared anywhere) |
| `DISCORD_APPLICATION_ID` | yes | Discord application ID |
| `DISCORD_GUILD_ID` | no | Register slash commands instantly in one guild |
| `TGGLR_API_URL` | yes | Backend base URL (`https://tgglr.vercel.app`) |
| `TGGLR_API_SECRET` | yes | Same value as the backend's `LICENSE_ADMIN_TOKEN` |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | yes | Same Supabase project as the backend |
| `ADMIN_USER_IDS` | yes | Comma-separated Discord IDs allowed to use commands |
| `EVENT_POLL_INTERVAL_MS` | no | bot_events poll interval (default 3000) |
| `SESSION_GAP_MINUTES` | no | join/leave session gap (default 10) |

## Database

Apply `migrations/002_bot_support.sql` in the Supabase SQL editor once. It is
non-destructive (adds optional columns + new tables). Without it, the bot
starts and licenses keep working, but bans/events/alerts/audit degrade
gracefully with warnings.

## Commands

`/help`, `/license` (create/list/info/revoke/delete/enable/disable/clearhwid/
transfer/history/search/expiring/bulk-create + `sharing` group), `/hwid`
(ban/unban/lookup/list/info/history), `/login`, `/server`, `/notifications`,
`/admin`, `/system`.

## Notes

- `TGGLR_API_SECRET` must equal the backend's `LICENSE_ADMIN_TOKEN`.
- Sensitive output (keys, HWIDs) is masked everywhere except ephemeral admin
  replies and local `backups/` files (never committed).
