# create-marcapony-app

Creates a new Marcapony app: a small web app with its own backend, connected to
your Marcapony account and hosted by Marcapony.

```sh
npx create-marcapony-app my-app --template booking
cd my-app
bun install
bun run link
bun run dev
```

When it is ready:

```sh
bun run deploy
```

`bun run link` and `bun run deploy` run the Marcapony CLI that the new project
pins in its `devDependencies`. `bun run link` also writes an `AGENTS.md` listing
exactly what the app is allowed to do, so an AI assistant can pick the project
up and build on it.

## Templates

| Template    | What it is                                                         | Runs in         |
| ----------- | ------------------------------------------------------------------ | --------------- |
| `blank`     | A starting point that lists your products (the default)            | Your site       |
| `booking`   | Signed-in customers see, book and cancel their appointments        | Customer portal |
| `shop`      | Products, a cart and a checkout that sends the buyer to pay        | Your site       |
| `team-tool` | Your team approves, rejects and completes the day's reservations | Dashboard       |

Each template's `README.md` says which placement, data access, scopes and
permissions to choose when you create the app under **My Apps** in the
dashboard, which routes it exposes and what to change first.

## Options

| Flag                    | Meaning                                                    |
| ----------------------- | ---------------------------------------------------------- |
| `--template`, `-t`      | Which template to use; asked in a terminal, else `blank`   |
| `--force`               | Write into a directory that already has files; never overwrites a file that is there |
| `-h`, `--help`          | Help                                                       |

Run without a directory name and it asks for one.

The scaffolder runs on Node 20 or newer and has no runtime dependencies. The app
it creates needs [Bun](https://bun.sh).

## License

Proprietary tool, unrestricted output: the app it creates is yours to license
and ship however you like. See [LICENSE.md](./LICENSE.md).
