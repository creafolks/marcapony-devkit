# Marcapony developer kit

Tools for building apps on [Marcapony](https://marcapony.com) and publishing them to the platform.

| Package | npm | What it is |
|---|---|---|
| [`sdk`](./sdk) | [`marcapony-sdk`](https://www.npmjs.com/package/marcapony-sdk) | Typed client for the Marcapony external API (`/ext/v1`), used by an app's server code |
| [`cli`](./cli) | [`marcapony`](https://www.npmjs.com/package/marcapony) | Links a project to an app on your Marcapony account and deploys it (`npx marcapony app link`, `npx marcapony app deploy`) |
| [`create-app`](./create-app) | [`create-marcapony-app`](https://www.npmjs.com/package/create-marcapony-app) | Scaffolds a new app (`npx create-marcapony-app my-app`) |

Each package has its own README with usage details.

## Development

The repository is a [Bun](https://bun.sh) workspace with one lockfile at the root. Install once there:

```bash
bun install
bun run check   # Biome, then type check, build and test every package
```

`bun run typecheck`, `bun run build` and `bun run test` run that step in every package; inside a package directory the same scripts run for that package only. Formatting and linting use [Biome](https://biomejs.dev): `bun run format` rewrites files, `bun run lint` reports lint problems, and CI runs `bunx biome ci .`.

A change to a package's shipped files (`src`, `template`, `package.json`, `README.md`, `LICENSE.md`, or the shared `tsconfig.base.json`) needs a version bump in that package's `package.json`; CI checks this. Run `bun install` after a bump so the root `bun.lock` records the new version, and commit both. Releases are published to npm from `main` when the version changes.

## License

Copyright © 2026 Creafolks. All rights reserved. The source is published for transparency and to make installation convenient; it is not open source. Each package's `LICENSE.md` sets out what you may do with it.

We do not accept outside contributions at the moment. To report a problem, open an issue.
