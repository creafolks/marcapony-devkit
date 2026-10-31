# Changelog

All notable changes to `marcapony-sdk` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The SDK is 0.x, so a
minor release may contain breaking changes; each one is listed below.

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
