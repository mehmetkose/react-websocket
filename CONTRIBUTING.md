# Contributing

Thanks for helping improve react-websocket. Bug reports, documentation fixes, tests and features are all welcome.

## A note on response times

This project is maintained in spare time, and the maintainer has a lot of other things to take care of. Please don't be discouraged if a question goes unanswered or a pull request waits a few days, or even weeks, for review. It's not a sign that your contribution isn't wanted.

The fastest way to move things along is to help each other: reviewing open pull requests, reproducing reported bugs, and answering questions in issues and [discussions](https://github.com/mehmetkose/react-websocket/discussions) all make a real difference.

## Before you start

- **Bugs:** [open an issue](https://github.com/mehmetkose/react-websocket/issues/new/choose) with a minimal reproduction, if there isn't one already.
- **Features and API changes:** open an issue or discussion first, so we can agree on the design before you spend time on code.
- **Security issues:** don't open a public issue. See [SECURITY.md](SECURITY.md).

## Setup

You need Node.js 22.18 or later. The toolchain is [Vite+](https://viteplus.dev/), installed as a dev dependency, so `npm ci` is all the setup it needs.

```sh
git clone https://github.com/mehmetkose/react-websocket.git
cd react-websocket
npm ci
npm test
```

## Scripts

| Script | What it does |
| --- | --- |
| `npm test` | Run the test suite once |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:coverage` | Run tests with a coverage report (and enforce the thresholds) |
| `npm run check` | Format check, lint and type-check in one pass (`vp check`) |
| `npm run lint` | Oxlint, including the React hooks and React Compiler rules |
| `npm run format` / `format:check` | Format with Oxfmt / check formatting |
| `npm run typecheck` | Type-check `src`, `test` and `examples/tornado` |
| `npm run build` | Build `dist/` (ESM, CJS and type definitions) with `vp pack` |
| `npm run check:package` | Build, then validate the package with publint and Are the Types Wrong |
| `npm run size` | Build, then check bundle sizes against the size-limit budgets |
| `npm run docs:dev` | Run the documentation site locally |
| `npm run example:tornado:server` | Start the Tornado example's WebSocket server (`pip install -r examples/tornado/requirements.txt` first) |
| `npm run example:tornado` | Start the Tornado example's Vite app against that server |
| `npm run example:nextjs` | Build the library, install it into the Next.js example, and start the demo on http://localhost:3000 |
| `npm run example:hono` | Build the library, install it into the Hono example, and start its server and Vite app on http://localhost:5173 |
| `npm run example:astro` | Build the library, install it into the Astro example, and start the demo on http://localhost:4321 |
| `npm run example:remix` | Build the library, install it into the Remix 3 example, and start the demo on http://localhost:44100 |
| `npm run example:game` | Build the library, install it into the game example, and start its server and Vite app on http://localhost:5180 |

Before opening a pull request, run:

```sh
npm run check && npm test && npm run check:package && npm run size
```

CI runs the same checks, plus the tests against React 18.

## Project layout

```
src/
  types.ts     Public types, options and MessageError (with TSDoc: it's the IDE documentation)
  client.ts    createWebSocket: connection, reconnect, queue, heartbeat, decoding, ready
  core.ts      The react-websocket/core entry (no React)
  react.ts     The hooks and the URL-keyed registry of shared clients
  sendrate.ts  createWebSocketSendRate: keyed sends at a rate that adapts to congestion
  feeds.ts     createWebSocketFeeds: topics with numbered messages, deduplicated and resumed
  runs.ts      createWebSocketRuns: streamed runs that resume after a reconnect or a reload
  index.ts     The main entry (core + hooks), built with a 'use client' banner
  chaos.ts     The react-websocket/chaos entry: a WebSocket wrapper that injects faults
  timeline.ts  The react-websocket/timeline entry: snapshot interpolation and input prediction
  outbox.ts    The react-websocket/outbox entry: messages stored until acknowledged
test/
  mock.ts          MockWebSocket: a controllable fake WebSocket
  core.test.ts     The client, without React
  react.test.tsx   The hooks (jsdom)
  ssr.test.tsx     Server rendering (Node environment)
  chaos.test.ts    The chaos WebSocket, alone and with the client
  timeline.test.ts The timeline, with fake timers standing in for the clock
  sendrate.test.ts The adaptive send rate, with a settable bufferedAmount and chaos latency
  outbox.test.tsx  The outbox, with memory storage and fake-indexeddb
  feeds.test.tsx   Numbered feeds: duplicates, gaps, snapshots and resuming
  runs.test.tsx    Resumable runs: reconnects, reloads, policies, and useAgentRun
docs/          The VitePress documentation site
examples/
  tornado/     Vite + React chat against a Tornado server, using src/ directly
  nextjs/      Next.js demo of every feature, with its own WebSocket server and the built package
  hono/        Vite + React chat against a Hono server, sharing message types, with the built package
  astro/       Astro islands demo of every feature, with its own WebSocket server and the built package
  remix/       Remix 3 demo of every feature with react-websocket/core (no React), with the built package
  game/        Multiplayer canvas game: a Node server with a fixed tick, the timeline and a chaos panel
```

## Writing tests

- **Use `MockWebSocket`** from `test/mock.ts`, passed through the `WebSocket` option. Drive the server's side with `open()`, `receive(data)` and `finishClose(code, reason)`, and inspect `sent` and `closedWith`.
- **Use fake timers** (`vi.useFakeTimers()`) for anything involving reconnect delays, heartbeats or the deferred close after unmount. Pass `jitter: 0` for exact delays. Suspense tests need real timers, because React schedules retries itself.
- **Give each test a unique URL** (see `uniqueUrl()` in `react.test.tsx`), since hooks with the same URL share a client.
- **Wrap updates in `act()`** in React tests.
- **Keep React 18 working.** CI also runs the suite against React 18. Tests that need React 19 APIs must be skipped there, using the helpers at the top of `react.test.tsx`:

  ```ts
  const itReact19 = it.skipIf(typeof use !== 'function');
  const itActivity = it.skipIf(typeof Activity === 'undefined');
  ```

- **Name regression tests after the issue** they cover (`'#46: changing the url reconnects to the new one'`).

## Pull request checklist

- [ ] Tests cover the change, and `npm test` passes.
- [ ] Lint, formatting, types, package checks and size budgets pass (see above).
- [ ] Public API changes have TSDoc in `src/types.ts` or `src/react.ts`, and the relevant pages in `docs/` are updated.
- [ ] `CHANGELOG.md` has an entry under the unreleased version.
- [ ] The PR description explains the why, and links the issue it fixes.

Keep pull requests focused: one fix or feature per PR is much quicker to review.

## Code style

Oxfmt and Oxlint enforce formatting and the hooks rules. All the tool settings live in `vite.config.ts`. Beyond that:

- Keep the library dependency-free and the bundles small; the size budgets will tell you.
- Match the existing comment style: short comments that explain *why*, not *what*.
- Behaviour must be safe under StrictMode, `<Activity>`, concurrent rendering and server rendering.

## Releasing

For maintainers:

1. Update `version` in `package.json` (`npm version <major|minor|patch> --no-git-tag-version`).
2. Move the `Unreleased` entries in `CHANGELOG.md` under the new version and date.
3. Commit, push, and make sure CI is green on `main`.
4. Create a GitHub release with a tag matching the version (for example `3.0.0`), using the changelog entry as notes.

Publishing the release runs `.github/workflows/release.yml`, which runs every check (`prepublishOnly`) and publishes to npm with [provenance](https://docs.npmjs.com/generating-provenance-statements) through npm trusted publishing. No npm token is stored in the repository. One-time setup: on npmjs.com, add a trusted publisher for this repository with the workflow `release.yml` and environment `npm`, and create the `npm` environment in the GitHub repository settings.

The documentation site deploys to GitHub Pages from `main` through `.github/workflows/docs.yml`.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
