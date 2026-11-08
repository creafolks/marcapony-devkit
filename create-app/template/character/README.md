# Marcapony app: character

A character from your business that chats with visitors: a barista who
recommends a drink, a guide who answers questions about a tour, a shopkeeper in
a game. The page shows the character's greeting and starter questions and
streams its answers as they are written.

## Set up in the dashboard

1. Create the character under **Characters** in the dashboard, switch it on
   for apps and give it a daily budget. A character answers apps only with a
   daily budget, and this app has its own daily budget for characters too.
2. Create the app under **My Apps** with:
   - **Placement:** public (`"placement": "public"`)
   - **Data access:** visitor. Characters only read what the business has
     published, so they work with any data access; choose the narrowest.
   - **Scopes:** none to choose. Granting the character to the app (next
     step) adds `personas:chat`.
   - **Permissions:** none
3. Grant the character to this app in the character's settings ("Apps that can
   use this character"). That adds the `personas:chat` scope to the app's keys
   and gives the app its `MARCAPONY_APP_SECRET`, which signs the visitor
   cookie.
4. Set the character's slug as the environment setting `PERSONA_SLUG`, with
   the Marcapony CLI the project pins (`marcapony app env set PERSONA_SLUG`).
   For `bun run dev`, add `PERSONA_SLUG=<slug>` to `.env.local` as well.

Characters in apps need a package that includes them.

## Routes

| Route                                             | What it does                                         |
| ------------------------------------------------- | ---------------------------------------------------- |
| `GET /api/health`                                 | Answers `{ "ok": true }`                             |
| `GET /api/character`                              | The character: name, description, greeting, starter questions |
| `POST /api/chat/<slug>/conversations`             | Starts a conversation and sets the visitor cookie    |
| `POST /api/chat/<slug>/conversations/:id/messages` | Sends `{ text, history }` and streams the answer     |
| `POST /api/chat/<slug>/conversations/:id/reports` | Reports an answer: `{ messageId, reason }`           |

The `/api/chat/*` routes are `personasHandler` from `marcapony-sdk`. It gives
every visitor an anonymous id in the `mp_eu` cookie (HttpOnly, Secure, one
year), so the per-visitor limits apply, and it stores nothing: the browser
keeps the conversation's signed history in `sessionStorage` and sends it with
each message, so a new tab starts a new conversation.

## What to change first

1. The chat panel in `src/ui/App.tsx`: the character's avatar
   (`avatarUrl`), your styles, and what happens when it is resting.
2. Before a public launch, add a bot check: create a Turnstile widget for the
   app's address and set `TURNSTILE_SITE_KEY` (a setting) and
   `TURNSTILE_SECRET_KEY` (`marcapony app env set TURNSTILE_SECRET_KEY --secret`).
   Visitors then pass a check before their first message and after every 10
   messages; the interface already shows the widget when it is asked for.
3. Your privacy notice: you are the data controller for your visitors, their
   anonymous ids and everything they type to the character.

## Develop and publish

Requires [Bun](https://bun.sh).

```sh
bun install
bun run link     # paste the connection code from the app's page; writes .env.local and AGENTS.md
bun run dev      # interface and /api routes on your machine
bun run deploy   # build and publish; prints the address
```

`.env.local` holds the app key. Never commit it, and never send it to the
browser: the interface calls this app's own `/api` routes, and only those talk
to Marcapony. Locally there is no `MARCAPONY_APP_SECRET`, so the server signs
the cookie with a fixed development value; deployed, it refuses to run without
the real one.

While the app is in test mode, the character answers on a cheaper model,
nothing is charged and the app has 50 test messages a day.
