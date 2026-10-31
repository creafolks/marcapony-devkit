# Marcapony app: booking

Lets a signed-in customer see their appointments, book a new one and cancel one.
It runs inside the customer portal of the business's site.

## Set up in the dashboard

Create the app under **My Apps** with:

- **Placement:** customer portal (`"placement": "portal"`)
- **Data access:** customer (`"dataAccess": "customer"`)
- **Scopes:** `reservations:read`, `reservations:write`
- **Plugin:** the account needs reservations enabled
- **Permissions** (declared in `marcapony.json`; choose who gets them):
  - `view-bookings`, "See my appointments": `reservations.own.read`
  - `book`, "Book and cancel appointments": `reservations.own.create`, `reservations.own.cancel`

## Routes

| Route                                | What it does                                    |
| ------------------------------------ | ----------------------------------------------- |
| `GET /api/me`                        | Who is signed in and what they may do; 401 if nobody |
| `GET /api/reservations`              | The customer's own appointments                 |
| `POST /api/reservations`             | Book: `{ requestId, date, time, notes? }`       |
| `POST /api/reservations/:id/cancel`  | Cancel one of the customer's appointments       |

Every call is made for the signed-in customer only, so one customer can never
see another's bookings. When the owner previews the page, a banner says that
changes are simulated.

## What to change first

1. The booking form in `src/ui/App.tsx`: add the fields the business needs
   (pass them as `customFields` in `src/server/index.ts`) and a duration if
   appointments are not the default length.
2. The menu title in `marcapony.json` (`portal.title`).
3. Test sign-in flows on the deployed app: locally nobody is signed in, so
   `/api/me` answers 401.

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
