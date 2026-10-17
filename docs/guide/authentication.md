---
title: 'WebSocket authentication in React'
description: 'Authenticate a WebSocket from the browser with a token in the URL, a sub-protocol, cookies or a first message, and keep credentials fresh across reconnects.'
---

# Authentication

This page shows how to authenticate a WebSocket connection from the browser, and how to keep credentials fresh across reconnects.

## Browsers can't set headers

The browser `WebSocket` constructor takes a URL and optional sub-protocols. Nothing else. You can't add an `Authorization` header, so the token has to travel some other way:

| Approach | When to use it |
| --- | --- |
| [Token in the URL](#token-in-the-url) | The most common choice. Works with any server. |
| [Token as a sub-protocol](#token-as-a-sub-protocol) | When your server reads `Sec-WebSocket-Protocol`. |
| [Cookies](#cookies) | When the socket is on the same site as your app. |
| [First-message auth](#first-message-auth) | When the protocol expects an `auth` message after connecting. |

## Token in the URL

Pass a function as the URL. It runs before **every** connection attempt, reconnects included, so each attempt can use a fresh token. It may be async:

```ts
import { createWebSocket } from 'react-websocket';
import { getFreshToken } from './auth';

export const live = createWebSocket(async () => {
  const token = await getFreshToken();
  return `wss://api.example.com/live?token=${encodeURIComponent(token)}`;
});
```

The same works with the hook: `useWebSocket(url)` takes a string, so put the function in a module-level client as above and pass that to `useWebSocket(live)`.

If the function throws or its promise rejects (for example the token refresh failed), that counts as a failed attempt. You get an `error` event (`onError`) with the thrown `Error`, and the client retries with the usual [backoff](./reconnecting.md). After `reconnect.maxAttempts` failures it gives up and the status becomes `closed`.

While the function is pending, the status is `connecting` (or `reconnecting`), and `send()` calls are queued as usual.

:::warning Tokens in URLs are logged
URLs often end up in server and proxy access logs. Prefer short-lived, single-purpose tokens over long-lived session tokens. See [SECURITY.md](https://github.com/mehmetkose/react-websocket/blob/main/SECURITY.md).
:::

## Token as a sub-protocol

Some servers accept a token through the `Sec-WebSocket-Protocol` header, which you can set with `protocols`:

```ts
const live = createWebSocket('wss://api.example.com/live', {
  protocols: ['v1', `token.${token}`]
});
```

The server must echo back one of the protocols it accepts (usually `v1`), or the browser closes the connection.

`protocols` is fixed when the client is created, so this suits tokens that don't change during the client's life. For rotating tokens, use the URL function.

## Cookies

The browser sends cookies with the WebSocket handshake, like any other request to that origin. If your API is on the same site as your app (for example `app.example.com` and `api.example.com`), session cookies authenticate the socket without any client code.

Check the `Origin` header on the server. Unlike `fetch`, WebSockets are not covered by CORS, so any site can try to open a socket to your server with the user's cookies.

## First-message auth

Some protocols expect credentials as the first message after connecting. Send them from an `open` listener, which runs after every successful connection and reconnection.

Open listeners run **before** the send queue is flushed. A message sent synchronously from an open listener therefore goes out first, ahead of anything you queued while disconnected. Fetch the token in a `url` function, which runs before every attempt, so the open listener can send it without waiting:

```ts
import { createWebSocket } from 'react-websocket';
import { getFreshToken } from './auth';

type Out = { type: 'auth'; token: string } | { type: 'chat'; text: string };

let token = '';

export const live = createWebSocket<unknown, Out>(
  async () => {
    token = await getFreshToken(); // before every attempt, including reconnects
    return 'wss://api.example.com/live';
  },
  { json: true }
);

// Sent before any queued `chat` messages, on every (re)connection.
live.on('open', () => live.send({ type: 'auth', token }));
```

:::warning Don't `await` inside the open listener
If the listener awaits something before sending, the queue is flushed while it waits, and queued messages reach the server before `auth`. Get what you need beforehand, as above, or set `queue: false` so nothing is queued while disconnected.
:::

With hooks, use `onOpen`. Prefer the module-level `live.on('open', …)` when several components use the client, so the auth message is sent once per connection rather than once per component:

```tsx
useWebSocket(live, {
  onOpen: () => live.send({ type: 'auth', token })
});
```

If your server needs time to verify the credentials before it accepts other messages, wait for its acknowledgement (for example an `auth-ok` message) before sending application messages.

## Stop retrying when credentials are rejected

Retrying with a rejected token is pointless. The simplest way to stop is to have the server close with `1008` (policy violation), which the client doesn't retry by default.

If your server uses a code of its own (in the `4000`–`4999` range), stop on that too. Combine it with `retryableClose`, the default rule, to keep stopping on `1008`:

```ts
import { createWebSocket, retryableClose } from 'react-websocket';

const live = createWebSocket(getUrl, {
  reconnect: {
    // 4001: unauthorized, by your server's convention
    shouldReconnect: close => close.code !== 4001 && retryableClose(close)
  }
});

live.on('close', close => {
  if (close.code === 4001 || close.code === 1008) redirectToLogin();
});
```

When `shouldReconnect` returns `false`, the status becomes `closed` and [`ready`](./suspense.md) rejects, which a Suspense error boundary can catch.

A server that rejects [first-message auth](#first-message-auth) with some other close is still backed off: a connection counts as successful only once it stays open for [`minUptime`](./reconnecting.md#servers-that-close-right-after-accepting) (5 seconds by default), so each retry waits longer than the last.

:::tip
Code `4000` is used by this library for a [heartbeat timeout](./reconnecting.md). Pick other codes for your own meanings.
:::

## Refreshing credentials

When your app gets a new token (the user switched accounts, a token was revoked), call `reconnect()`. It drops the current socket and connects again right away, calling your URL function for a new URL:

```ts
onTokenChanged(() => live.reconnect());
```

`reconnect()` also restarts a client that gave up or was closed.

After the user logs out, call `live.close()`. That closes the socket, stops reconnecting and clears the send queue. Mounted components stay mounted; the status stays `closed` until `connect()` or `reconnect()` is called.
