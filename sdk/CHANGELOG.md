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
  `FormSubmissionReceipt`. The same applies to the reservation calls of
  `forRequest()` for team members. Code that cast these results may need its
  casts removed.
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

## [0.6.0]

- Scoped calls for signed-in people: `forRequest(request).me` for customers and
  the account groups for team members.
