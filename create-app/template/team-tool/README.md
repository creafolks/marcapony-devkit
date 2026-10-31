# Marcapony app: team tool

A tool for the business's team: the day's reservations, with buttons to
approve, reject, complete or cancel them. Team members open it from the
Marcapony dashboard.

## Set up in the dashboard

Create the app under **My Apps** with:

- **Placement:** portal (`"placement": "portal"`)
- **Data access:** team (`"dataAccess": "team"`)
- **Scopes:** `reservations:read`, `reservations:write`
- **Plugin:** the account needs reservations enabled
- **Permissions** (declared in `marcapony.json`; choose which members get them):
  - `view`, "See reservations": `reservations.read`
  - `manage`, "Approve, reject and complete reservations": `reservations.write`

A member who should change reservations needs both. A member's own role still
applies: someone who may only view reservations in the dashboard cannot change
them through this tool either.

## Routes

| Route                                | What it does                                                   |
| ------------------------------------ | -------------------------------------------------------------- |
| `GET /api/me`                        | The signed-in member; 401 if nobody, 403 for anyone but a team member |
| `GET /api/reservations?date=YYYY-MM-DD` | Reservations on that day, earliest first                    |
| `POST /api/reservations/:id/status`  | `{ status, rejectionReason? }`, status one of approved, rejected, cancelled, completed |

The status buttons only show for members with the `manage` permission. When
the owner previews the tool, a banner says that changes are simulated.

## What to change first

1. Which actions each status offers (`ACTIONS` in `src/ui/App.tsx`).
2. The columns of the list: customer phone, notes, service.
3. Test it on the deployed app: locally nobody is signed in, so `/api/me`
   answers 401.

## Develop and publish

Requires [Bun](https://bun.sh).

```sh
bun install
bun run link     # paste the connection code from the app's page; writes .dev.vars and AGENTS.md
bun run dev      # interface and /api routes on your machine
bun run deploy   # build and publish; prints the address
```

`.dev.vars` holds the app key. Never commit it, and never send it to the
browser: the interface calls this app's own `/api` routes, and only those talk
to Marcapony. `MARCAPONY_APP_ID` is set by Marcapony when the app is deployed;
locally there is none, so nobody is signed in during `bun run dev`.

New apps start in test mode: writes are simulated until you switch test mode off
on the app's page. Pass an `idempotencyKey` to every create call so a retry
cannot create the same thing twice.
