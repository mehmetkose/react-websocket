---
title: 'WebTransport behind the WebSocket API'
description: 'Use WebTransport from react-websocket with the same client and hooks: reliable messages on one stream, volatile sends as datagrams, and an automatic fallback to WebSocket.'
---

# WebTransport

[WebTransport](https://developer.mozilla.org/en-US/docs/Web/API/WebTransport_API) runs over HTTP/3 and QUIC. For real-time apps it adds one thing WebSockets can't do: **datagrams**, messages that are never queued or retransmitted. A lost cursor position or input doesn't hold up the ones after it, the way a lost packet holds up everything behind it on a WebSocket's TCP connection.

`react-websocket/webtransport` puts it behind the API you already use:

```ts
import { createWebSocket } from 'react-websocket';
import { createWebTransportSocket } from 'react-websocket/webtransport';

export const game = createWebSocket<GameIn, GameOut>('wss://game.example.com/play', {
  json: true,
  WebSocket: createWebTransportSocket()
});
```

Hooks, reconnects, the queue, topics, feeds and everything else work as before.

- **Ordinary sends** go on one reliable, ordered stream, so they behave exactly like WebSocket messages.
- **`volatile` sends** go as datagrams: `game.send({ type: 'aim', angle }, { volatile: true })`. One too big for a datagram, about 1,200 bytes, goes on the stream instead. A datagram can be lost even while connected, so send what must arrive, such as a shot, without `volatile`, or pass `datagrams: false` to keep every message on the stream.
- **The URL** is the client's, with `ws:` and `wss:` turned into `https:`, which WebTransport needs. Pass `url` to map it differently.

In Chrome, against a local HTTP/3 server, the session opened in 22 ms, stream messages and datagrams arrived as sent, and a server closing the session with code 4001 reached `shouldReconnect` as `4001`.

## Falling back to WebSocket

Some browsers don't have WebTransport, and some networks block the UDP it runs on. So when `WebTransport` isn't there, or a session can't be established within `timeout` (5 seconds by default), the client connects with a WebSocket to its own URL instead. Datagrams then become ordinary messages. It remembers: later connections go straight to WebSocket, without waiting for another attempt to fail.

Your server then has to answer both, at the same URL: WebSocket on TCP, and WebTransport on UDP. In Chrome, with nothing listening for WebTransport, the client fell back in 22 ms. With the address black-holed, it fell back after its 1.5 s `timeout`, and the next connection opened over WebSocket in 22 ms.

`fallback: false` turns this off, and `fallback: SomeWebSocket` picks the class. `Transport.fallingBack` says whether connections go over WebSocket at the moment.

## The server's side

WebTransport has no message framing of its own, so the client uses a small one. A server needs to:

1. Accept a WebTransport session at the URL's path.
2. Read **one bidirectional stream**, which the client opens right after the session starts. Each message on it, in both directions, is framed as:

   | Bytes | |
   | --- | --- |
   | 1 | Type: `0` for text (UTF-8), `1` for binary |
   | 4 | Length of the payload, big-endian |
   | n | Payload |

3. Read **datagrams**, each one message: 1 byte of type, then the payload. Send datagrams back the same way, for messages that may be dropped.
4. Close the session with a WebTransport close code and reason to close the connection: the client reports them as a WebSocket close code and reason. A session closed without a code reports `1005`, like a WebSocket closed without a status.

Libraries with WebTransport servers include [aioquic](https://github.com/aiortc/aioquic) (Python), [webtransport-go](https://github.com/quic-go/webtransport-go) (Go), and [@fails-components/webtransport](https://github.com/fails-components/webtransport) (Node.js).

## Development certificates

WebTransport needs TLS, even on `localhost`. Instead of a trusted certificate, a development server can use a self-signed ECDSA (P-256) certificate valid for at most 14 days, and the browser can trust it by its SHA-256 hash:

```ts
const hash = Uint8Array.from(atob(import.meta.env.VITE_CERT_HASH), char => char.charCodeAt(0));

createWebTransportSocket({
  transport: { serverCertificateHashes: [{ algorithm: 'sha-256', value: hash }] }
});
```

`transport` is passed to the `WebTransport` constructor as it is.

## Things to know

- **`bufferedAmount`** counts the bytes handed to the stream and not yet written, so `maxBuffered` works as on a WebSocket. Datagrams aren't counted: a full datagram queue drops them by itself.
- **Order.** Stream messages arrive in order. Datagrams can arrive out of order, or not at all, also relative to stream messages.
- **Subprotocols** aren't part of WebTransport. They're passed on to the WebSocket fallback.
- **Server rendering.** Like any `WebSocket` option, nothing connects during a server render.

## See also

- [`createWebTransportSocket`](../api/webtransport.md)
- [Real-time games](./games.md): volatile input and `maxBuffered`
