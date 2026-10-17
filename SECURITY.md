# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 4.x | Yes |
| < 4.0 | No |

Security fixes are released for the latest 4.x version. Please upgrade to it before reporting.

## Reporting a vulnerability

Please **don't** report security issues in public issues, discussions or pull requests.

Report them privately through GitHub: go to the repository's **Security** tab and choose **Report a vulnerability** ([direct link](https://github.com/mehmetkose/react-websocket/security/advisories/new)).

Include as much as you can:

- the affected version(s),
- a description of the issue and its impact,
- steps or a minimal proof of concept to reproduce it,
- any suggested fix or mitigation.

This is a volunteer-maintained project, so responses are best effort. The aim is to acknowledge a report within a week, keep you informed while a fix is prepared, and credit you in the advisory unless you'd rather not be named. Please give us a reasonable amount of time to release a fix before disclosing the issue publicly.

## Using react-websocket securely

The library moves data between your app and your server. Most WebSocket security depends on how that data is handled:

- **Always use `wss://` in production.** `ws://` is unencrypted: anyone on the network path can read and modify messages. Browsers also block `ws://` from `https://` pages.
- **Treat tokens in URLs as logged.** Browsers can't set headers on WebSockets, so tokens often go in the URL, and URLs end up in server, proxy and CDN logs. Use short-lived, single-purpose tokens, and pass a URL function so each attempt gets a fresh one. See the [authentication guide](https://mehmetkose.github.io/react-websocket/guide/authentication).
- **Check the `Origin` header on the server.** WebSockets aren't covered by CORS. If you authenticate with cookies, any website can try to open a socket to your server with your users' cookies unless the server rejects unexpected origins.
- **Validate incoming messages.** The type parameters (`useWebSocket<Message>`) are compile-time only. Use the `schema` option with a Standard Schema library (zod, valibot, arktype) to check messages at runtime; invalid ones are reported as a `MessageError` and never delivered.
- **Never render message content as HTML.** Render messages as text with JSX, which escapes them. Don't pass message content to `dangerouslySetInnerHTML`, `innerHTML`, `eval` or URLs (`href`, `src`) without sanitizing and validating it.
- **Don't trust the client on the server.** Anything the client sends can be forged. Authorize every message server-side.
- **Limit what you keep.** Messages queued while disconnected stay in memory until they're sent or the client is closed. Use `queue: { limit }` to bound it, and `close()` on logout to clear it.
