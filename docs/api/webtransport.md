---
description: 'createWebTransportSocket from react-websocket/webtransport: WebTransport behind the WebSocket API, with volatile sends as datagrams and a fallback to WebSocket.'
---

# createWebTransportSocket

A `WebSocket` class that connects over WebTransport: messages on one reliable stream, `volatile` sends as datagrams, and a WebSocket where WebTransport isn't available or can't connect. Pass it as the [`WebSocket`](./options.md#websocket) option.

```ts
function createWebTransportSocket(options?: {
  url?: (url: string) => string;
  transport?: WebTransportOptions;
  fallback?: typeof WebSocket | false;
  timeout?: number;
  datagrams?: boolean;
}): WebTransportWebSocket;
```

Available only from `react-websocket/webtransport`. It has no imports, and its size (about 1.7 kB min+gzip) is separate from the main entry's. The guide, with the wire format for servers, is [WebTransport](../guide/webtransport.md).

## Usage

```ts
import { createWebSocket } from 'react-websocket';
import { createWebTransportSocket } from 'react-websocket/webtransport';

export const game = createWebSocket(url, { json: true, WebSocket: createWebTransportSocket() });

game.send({ type: 'aim', angle }, { volatile: true }); // a datagram
```

## Parameters

| Option | Type | |
| --- | --- | --- |
| `url` | `(url: string) => string` | Optional. The WebTransport URL for the client's URL. Default: `ws:` and `wss:` become `https:` |
| `transport` | `WebTransportOptions` | Optional. Passed to the `WebTransport` constructor, e.g. `serverCertificateHashes` in development |
| `fallback` | `typeof WebSocket \| false` | Optional. The `WebSocket` to use, at the client's own URL, where WebTransport isn't available or a session can't be established. `false` fails the connection instead. Default: the global `WebSocket` |
| `timeout` | `number` | Optional. How long to wait for a session before falling back, in ms. Default `5000` |
| `datagrams` | `boolean` | Optional. Send `volatile` messages as datagrams, which can be lost even while connected. `false` keeps every message on the stream. Default `true` |

## Returns

A `WebTransportWebSocket`: a class with the `WebSocket` interface, plus:

| Member | |
| --- | --- |
| `fallingBack` | Whether connections go over WebSocket now: WebTransport is missing, or a session failed, after which later connections skip it |

## Behavior

| | |
| --- | --- |
| `send(data)` | A frame on the stream: 1 byte of type (`0` text, `1` binary), 4 bytes of length, the payload |
| `send(data, { volatile: true })` | A datagram: 1 byte of type, then the payload. On the stream instead when it's bigger than `maxDatagramSize` |
| Incoming | Frames from the stream and datagrams, as `message` events. Binary as an `ArrayBuffer` or a `Blob`, per `binaryType` |
| `close(code, reason)` | Closes the session with that code and reason |
| The session closes | A `close` event with its code and reason. Without a code, `1005`. When it fails, an `error` and `1006` |
| `bufferedAmount` | Bytes handed to the stream and not yet written |
| No session within `timeout`, or it fails | Falls back to a WebSocket for this connection and the ones after it |
| No `window` | The constructor throws, so nothing connects during a server render |
