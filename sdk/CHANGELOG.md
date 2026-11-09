# Changelog

All notable changes to `marcapony-sdk` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The SDK is 0.x, so a
minor release may contain breaking changes; each one is listed below.

## [0.9.0] - 2026-11-09

### Added

- `renderPersonaMarkdown(text)`: renders a character's answer, which is
  Markdown, as safe HTML. Only the subset characters write becomes markup:
  paragraphs and line breaks, bold, emphasis, strikethrough, inline code,
  links, bare http(s) URLs and one level of bullet or numbered lists.
  Everything else, raw HTML included, is escaped text. Links open in a new tab
  with `rel="noopener noreferrer"`; only http, https, mailto, tel and relative
  URLs become links, and any other scheme leaves just the label.
- `personaMarkdownToText(text)`: the same answer as plain text, with a link
  written as `label (url)`.
- Both are also exported from `marcapony-sdk/markdown`, for browser bundles
  that need nothing else from the SDK.

## [0.8.0] - 2026-11-08

### Added

- `personas`: conversations with the account's characters from an app's
  server. `list()` and `get(slug)` read the characters granted to the app;
  `start(slug, options)` begins a conversation and
  `resume(slug, id, { history, storesTranscripts, endUser })` continues a
  stored one without a request. A chat has `send` (the whole answer), `stream`
  (the answer as events), `report`, `verify` and `transcript`. Needs the
  `personas:chat` scope. Only on the client from `createClient`, not on
  `forRequest()`.
- `chat.endUser`: a conversation started with `endUser` belongs to it, and
  every later call (message, verify, report, transcript) must name the same
  one or answers `NotFoundError`. The chat sends it for you; pass it to
  `resume` as `{ endUser }`.
- `chat.history`: the signed entries each message carries when the character
  keeps no transcript, at most 30. Visitor messages are kept up to
  `PERSONA_HISTORY_MAX_USER_CHARS` (2,000) characters and answers up to
  `PERSONA_HISTORY_MAX_ANSWER_CHARS` (32,768). A failed turn adds nothing.
- Messages are never sent twice, with one exception: when the API refuses the
  history (`invalid_history`), a chat from `start` begins a new conversation
  with the same options and sends the message there once, so `chat.id`
  changes. A chat from `resume` throws `ValidationError` instead.
- `personasHandler(mp, options)`: a request handler for the app's own chat
  route. It keeps an anonymous visitor id in a signed `mp_eu` cookie (signed
  with `MARCAPONY_APP_SECRET`) and names it on every call, forwards messages
  and history, streams answers through, passes `Retry-After` on to the
  browser, and supports an optional Turnstile check. `clientIp` sets where the
  visitor's address comes from; the default, `cf-connecting-ip`, is only
  trustworthy on Cloudflare.
- Error classes `PersonaUnavailableError`, `PersonaLimitError` and
  `VerificationRequiredError`, and the `PERSONA_LIMIT_CODES` list.
  `invalid_history` maps to `ValidationError` and `service_unavailable` to
  `ServerError`.

### Changed

- No request is retried on a character limit or pause (`PersonaLimitError`,
  `PersonaUnavailableError`), whatever its status. Other retries are
  unchanged, including waiting for `Retry-After` before an idempotent call is
  sent again.
- Every request sends `Accept: application/json`.

## [0.7.1] - 2026-10-31

### Changed

- Source formatted with Biome and built from a shared compiler config. No
  change to behaviour or types.

## [0.7.0] - 2026-10-31

### Changed

- Creates and status updates that resolved to `unknown` now resolve to typed
  records: `reservations.create` to `CreatedReservation`,
  `reservations.updateStatus` to `ReservationStatusChange`, `orders.create` to
  `CreatedOrder`, `paymentLinks.create` to `CreatedPaymentLink` (with the
  `paymentUrl` to send the customer) and `formSubmissions.create` to
  `FormSubmissionReceipt`, each wrapped in `WriteResult<T>`. The same applies
  to the reservation calls of `forRequest()` for team members, and
  `forRequest().me.reservations.create` and `.cancel` now resolve to
  `WriteResult<OwnReservation>` and `WriteResult<{ id, status }>`: writes made
  while the owner previews an app are simulated too. Code that cast
  these results may need its casts removed.
- `WriteResult<T>` is either the saved record or, in test mode (where every new
  app starts), a `SimulatedWrite<T>`: the input echoed back with an id,
  timestamps and `simulated: true`, without the fields the server computes
  (no `paymentUrl` on a simulated payment link). Check `result.simulated`
  before reading those fields.
- `posts.delete`, `blogAuthors.delete` and `blogCategories.delete` resolve to
  `void`. Their response bodies differed between resources and were never part
  of the contract.
- Retries wait a random time between zero and the exponential backoff (full
  jitter), so many clients failing together do not retry in step. A
  `Retry-After` from the server is still honored up to 60 seconds.

### Fixed

- Every record id and locale in a request path is now percent-encoded as one
  path segment, and an empty, `.` or `..` id throws before any request is
  sent. Before, most account calls (`products.get`, `posts.get`,
  `blogAuthors.get`, `media.get` and others) put the id into the path as given,
  so an id containing `/`, `?` or `..` could reach a different route.
- Trailing slashes on `baseUrl` are all removed, not only the last one.

### Added

- Exported resource types (`ProductsResource`, `PostsResource`, and one per
  resource group) and `ListPostsParams`, so a function can accept one part of
  the client.

## [0.6.0] and earlier

Not recorded here; see the repository history.
