# Contributing

Thanks for helping improve react-websocket. Bug reports, documentation fixes, tests and features are all welcome, and so is help answering questions and reproducing bugs.

Everyone taking part in this project, in issues, discussions, pull requests and reviews, is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## A note on response times

This project is maintained in spare time, and the maintainer has a lot of other things to take care of. Please don't be discouraged if a question goes unanswered or a pull request waits a few days, or even weeks, for review. It's not a sign that your contribution isn't wanted.

The fastest way to move things along is to help each other: reviewing open pull requests, reproducing reported bugs, and answering questions in issues and [discussions](https://github.com/mehmetkose/react-websocket/discussions) all make a real difference.

## Ways to help

- **Answer questions and reproduce bugs.** A minimal reproduction is often the hardest part of a fix, and anyone can write one.
- **Review pull requests.** Trying a change in your own app and saying whether it works is useful, even if you don't know the codebase.
- **Improve the docs.** If something confused you, fix it while you still remember what was confusing. Pages on the [documentation site](https://mehmetkose.github.io/react-websocket/) link to their source, so you can edit them on GitHub.
- **Fix bugs and build features.** The [roadmap](ROADMAP.md) lists ideas that have been checked against the code. Say in an issue or discussion which one you'd like to take on, so two people don't build the same thing.

## Before you start

- **Questions** go in [discussions](https://github.com/mehmetkose/react-websocket/discussions), not issues.
- **Bugs:** search the [existing issues](https://github.com/mehmetkose/react-websocket/issues) first, then [open an issue](https://github.com/mehmetkose/react-websocket/issues/new/choose) with a minimal reproduction.
- **Features and API changes:** open an issue or discussion first, so we can agree on the design before you spend time on code.
- **Small fixes**, such as typos, broken links and clearer wording, don't need an issue. Open a pull request.
- **Security issues:** don't open a public issue. See [SECURITY.md](SECURITY.md).

## Setup

You need Node.js 22.18+ or 24.11+, the versions Vite+ supports. CI runs Node 22 and 24. The toolchain is [Vite+](https://viteplus.dev/), installed as a dev dependency, so `npm ci` is all the setup it needs. The Remix example needs Node.js 24.3 or later, and the Tornado example needs [uv](https://docs.astral.sh/uv/).

[Fork the repository](https://github.com/mehmetkose/react-websocket/fork), then:

```sh
git clone https://github.com/<your-username>/react-websocket.git
cd react-websocket
git remote add upstream https://github.com/mehmetkose/react-websocket.git
npm ci
npm test
```

Make your change on a branch named after it, such as `fix-reconnect-after-logout`. To bring in changes from `main`, run `git fetch upstream` and `git rebase upstream/main`.

## Scripts

| Script | What it does |
| --- | --- |
| `npm test` | Run the test suite once |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:coverage` | Run tests with a coverage report, and enforce the coverage thresholds as CI does |
| `npm run check` | Format check, lint and type-check in one pass (`vp check`) |
| `npm run lint` | Oxlint, including the React hooks and React Compiler rules |
| `npm run format` / `format:check` | Format with Oxfmt / check formatting |
| `npm run typecheck` | Type-check `src`, `test` and `examples/tornado` |
| `npm run build` | Build `dist/` (ESM, CJS and type definitions) with `vp pack` |
| `npm run check:package` | Build, then validate the package with publint and Are the Types Wrong |
| `npm run size` | Build, then check bundle sizes against the size-limit budgets |
| `npm run docs:dev` | Run the documentation site locally |
| `npm run docs:build` | Build the documentation site |
| `npm run example:tornado:server` | Start the Tornado example's WebSocket server with [uv](https://docs.astral.sh/uv/), which installs its dependencies |
| `npm run example:tornado` | Start the Tornado example's Vite app against that server |
| `npm run example:nextjs` | Build the library, install it into the Next.js example, and start the demo on http://localhost:3000 |
| `npm run example:hono` | Build the library, install it into the Hono example, and start its server and Vite app on http://localhost:5173 |
| `npm run example:astro` | Build the library, install it into the Astro example, and start the demo on http://localhost:4321 |
| `npm run example:remix` | Build the library, install it into the Remix 3 example, and start the demo on http://localhost:44100 |
| `npm run example:game` | Build the library, install it into the game example, and start its server and Vite app on http://localhost:5180 |

## Running the checks

Before opening a pull request, run what CI runs:

```sh
npm run check && npm run test:coverage && npm run check:package && npm run size
```

CI also runs the tests on Node 22, and against React 18. To test against React 18 locally:

```sh
npm i --no-save react@18 react-dom@18 @types/react@18 @types/react-dom@18
npm test
npm ci # back to React 19
```

## Project layout

```
src/
  types.ts      Public types, options and MessageError, with TSDoc: it's the IDE documentation
  client.ts     createWebSocket: connection, reconnect, queue, heartbeat, decoding, ready
  react.ts      The hooks, and the URL-keyed registry of shared clients
  core.ts       The react-websocket/core entry: the client and the managers, without React
  index.ts      The main entry (core + hooks), built with a 'use client' banner
  *.ts          One file per feature: topics.ts, state.ts, requests.ts, runs.ts, presence.ts, …
test/
  mock.ts       MockWebSocket: a controllable fake WebSocket
  *.test.ts(x)  core.test.ts for the client, react.test.tsx for the hooks, ssr.test.tsx for
                server rendering, and a file for each feature, named after it
docs/           The documentation site (Rspress): guide/, api/ and recipes/
examples/       Example apps: nextjs, astro, remix, hono, game and tornado
```

Some features ship as their own entry points, such as `react-websocket/chaos` and `react-websocket/outbox`, so apps that don't use them don't download them. A new entry point needs:

- an entry in `exports` in `package.json`,
- a build entry in `vite.config.ts`,
- a size budget in `size-limit` in `package.json`,
- an alias in `rspress.config.ts`, so demos in the docs use the source.

## Writing code

Oxfmt and Oxlint enforce formatting and the hooks rules. All the tool settings live in `vite.config.ts`. Beyond that:

- **Keep the library dependency-free and small.** Every entry point has a size budget. If a change needs more, trim what's cheap to trim, then raise the budget in the same pull request and say why.
- **Keep it safe in every React mode:** StrictMode, `<Activity>`, concurrent rendering and server rendering, on React 18 and 19.
- **Keep `react-websocket/core` free of React,** so it works in Node and in other frameworks.
- **Document public APIs with TSDoc** in `src/types.ts` or `src/react.ts`. It's what users see in their editor.
- **Avoid breaking changes.** The library follows [semver](https://semver.org/), so a breaking change means a major version. If you think one is needed, discuss it in an issue first.
- **Comment the why, not the what.** Match the existing style of short comments.

## Writing tests

- **Use `MockWebSocket`** from `test/mock.ts`, passed through the `WebSocket` option. Drive the server's side with `open()`, `receive(data)` and `finishClose(code, reason)`, and inspect `sent` and `closedWith`.
- **Use fake timers** (`vi.useFakeTimers()`) for anything involving reconnect delays, heartbeats or the deferred close after unmount. Pass `jitter: 0` for exact delays. Suspense tests need real timers, because React schedules retries itself.
- **Give each test a unique URL** (see `uniqueUrl()` in `react.test.tsx`), since hooks with the same URL share a client.
- **Wrap updates in `act()`** in React tests.
- **Keep React 18 working.** Tests that need React 19 APIs must be skipped on React 18, using the helpers at the top of `react.test.tsx`:

  ```ts
  const itReact19 = it.skipIf(typeof use !== 'function');
  const itActivity = it.skipIf(typeof Activity === 'undefined');
  ```

- **Name regression tests after the issue** they cover (`'#46: changing the url reconnects to the new one'`).

## Writing docs

- Guides are in `docs/guide/`, the API reference in `docs/api/`, and recipes in `docs/recipes/` and `docs/recipes.md`. Run `npm run docs:dev` to preview them, and make sure `npm run docs:build` succeeds.
- Demos in the docs import `react-websocket` by name and get the current source from `src/`, so they show your change without a build.
- When an option or behavior changes, update its guide page, its API page and its TSDoc together.
- Oxfmt doesn't format Markdown, so format tables and code examples by hand. Users copy the code examples, so make sure they're correct.

## Changing the examples

All the examples except Tornado install the built package from the repository root (`"react-websocket": "file:../.."`). `npm run example:<name>` rebuilds the library and reinstalls it before starting the example.

The root lint and type-check skip these examples, since they need their own dependencies. When you change one, run its own type-check:

```sh
npm --prefix examples/hono run typecheck
```

## Changelog

Add an entry under `## [Unreleased]` in `CHANGELOG.md` for every change users will notice: fixes, new features, behavior changes and documentation. The changelog follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), with the sections Added, Changed, Fixed, Removed, Security and Documentation.

Write entries for users: what changed and what it means for their app, with a link to the docs when there's a page about it. Tests, CI and refactors that users can't see don't need an entry. Don't change the version in `package.json`: it's set when a release is made.

## Commits and pull requests

- **Keep each pull request to one change.** One fix or feature per pull request is much quicker to review.
- **Write commit messages and pull request titles in the imperative and in sentence case**, without a prefix or a final period: `Reset per-user state on logout and account switch`. Use the commit body to explain why, when it isn't obvious.
- **Explain why in the description**, and link the issue it fixes (`Fixes #123`). The [pull request template](.github/PULL_REQUEST_TEMPLATE.md) has a checklist.
- **Leave "Allow edits by maintainers" on**, so small fixes can be pushed to your branch instead of going back and forth.
- **After a review, push new commits** instead of force-pushing, so reviewers can see what changed.
- **CI must pass** before a pull request is merged.

### Using AI tools

AI coding assistants are fine to use, but you're responsible for what you submit: understand every line, run the checks, and make sure the description says what the change does. Please don't open issues or pull requests you haven't reviewed yourself.

## Releasing

For maintainers:

1. Pick the version from the `[Unreleased]` entries, following semver: a patch when they only fix things, a minor when they add something, a major when they break something.
2. On a branch named `release-X.Y.Z`, open a release pull request that:
   - sets the version with `npm version X.Y.Z --no-git-tag-version`, which updates `package.json` and `package-lock.json`,
   - updates the `react-websocket` version in each `examples/*/package-lock.json`,
   - moves the `[Unreleased]` entries in `CHANGELOG.md` under `## [X.Y.Z] - YYYY-MM-DD`, adds the version's compare link, and points the `[Unreleased]` link at the new tag.
3. Merge it once CI passes, and wait for CI to pass on `main`.
4. Publish a GitHub release whose tag matches the version, without a `v` prefix, with the changelog entry as notes:

   ```sh
   gh release create X.Y.Z --target <merge commit> --title X.Y.Z --notes-file notes.md
   ```

Only number a version you're about to publish. A version the changelog lists but npm never got can't be installed, and its compare link has no tag to point at: until a release, changes stay under `[Unreleased]`.

Publishing the release runs `.github/workflows/release.yml`, which runs every check (`prepublishOnly`) and publishes to npm with [provenance](https://docs.npmjs.com/generating-provenance-statements) through npm trusted publishing. No npm token is stored in the repository. One-time setup: on npmjs.com, add a trusted publisher for this repository with the workflow `release.yml` and environment `npm`, and create the `npm` environment in the GitHub repository settings.

The documentation site deploys to GitHub Pages from `main` through `.github/workflows/docs.yml`.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
