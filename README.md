# Marcapony developer kit

Tools for building apps on [Marcapony](https://marcapony.com) and publishing them to the platform.

| Package | npm | What it is |
|---|---|---|
| [`sdk`](./sdk) | [`marcapony-sdk`](https://www.npmjs.com/package/marcapony-sdk) | Typed client for the Marcapony external API (`/ext/v1`), used by an app's server code |
| [`cli`](./cli) | [`marcapony`](https://www.npmjs.com/package/marcapony) | Links a project to an app on your Marcapony account and deploys it (`npx marcapony app link`, `npx marcapony app deploy`) |
| [`create-app`](./create-app) | [`create-marcapony-app`](https://www.npmjs.com/package/create-marcapony-app) | Scaffolds a new app (`npx create-marcapony-app my-app`) |

Each package has its own README with usage details.

## Development

Every package is self-contained and uses [Bun](https://bun.sh):

```bash
cd sdk   # or cli, create-app
bun install
bunx tsc --noEmit && bun run build
bun test
```

A change to a package's shipped files (`src`, `template`, `package.json`, `README.md`, `LICENSE.md`) needs a version bump in that package's `package.json`; CI checks this. Releases are published to npm from `main` when the version changes.

## License

Copyright © 2026 Creafolks. All rights reserved. The source is published for transparency and to make installation convenient; it is not open source. Each package's `LICENSE.md` sets out what you may do with it.

We do not accept outside contributions at the moment. To report a problem, open an issue.
