---
title: 'Build a collaborative whiteboard with React and WebSockets'
description: 'A multiplayer whiteboard over one WebSocket: live cursors that expire, strokes others see while you draw them, saved shapes delivered once and in order with a snapshot for late joiners, offline drawing through an outbox, and shared notes with Yjs.'
---

# Build a collaborative whiteboard

This guide builds a whiteboard several people draw on at once. Each sees the others' cursors, sees their strokes while they draw them, and keeps drawing while offline. A drawing app makes the timing problems of real-time apps visible:

1. **Two kinds of data.** A cursor or a stroke being drawn is worth something only now, and the next update replaces it. A finished stroke must be saved, exactly once, and reach everyone in the same order.
2. **Late joiners.** Someone who opens the board now needs everything drawn so far, then every change after it.
3. **Drawing offline.** A train goes through a tunnel. The user keeps drawing, and the strokes are saved when the connection comes back, even after a reload.
4. **Sixty frames a second.** Pointer moves and other people's ink arrive faster than React should render. The canvas has to keep up without it.
5. **Ghosts.** Someone whose laptop died mid-stroke shouldn't leave a half-drawn line or a frozen cursor on everyone's screen.

| File | Runs in | |
| --- | --- | --- |
| `protocol.ts` | Both | The messages |
| `live.ts` | The browser | The connection, the saved shapes, the outbox, cursors and ink |
| `Board.tsx` | The browser | The canvas, drawn outside React |
| `server.ts` | Node | The board's numbered changes, edits saved once, and relaying cursors and ink |
| `notes.ts`, `notes-server.ts` | Both | Shared notes, with Yjs |

## The protocol

```ts
// protocol.ts: imported by the browser and the server.
export type Point = [x: number, y: number];

export type Stroke = { id: string; color: string; points: Point[] };
export type Shape = Stroke & { author: string }; // `author` is set by the server

export type Cursor = { x: number; y: number; color: string; name?: string }; // `name` too

/** What the outbox keeps until the server saves it. */
export type Edit = { kind: 'draw'; stroke: Stroke } | { kind: 'erase'; shape: string };

export type BoardIn =
  // The board's changes, numbered. `topic` is `board:<id>`.
  | { type: 'drawn'; topic: string; seq: number; shape: Shape }
  | { type: 'erased'; topic: string; seq: number; shape: string }
  // The whole board, for a newcomer or a client too far behind.
  | { type: 'board'; topic: string; seq: number; shapes: Shape[] }
  | { type: 'saved'; id: string }
  // Someone's stroke while they draw it, and their cursor.
  | { type: 'ink'; peer: string; stroke: Stroke }
  | { type: 'cursor'; peer: string; cursor: Cursor | null };

export type BoardOut =
  | { type: 'subscribe'; topic: string; after?: number }
  | { type: 'unsubscribe'; topic: string }
  | { type: 'edit'; id: string; edit: Edit }
  | { type: 'ink'; stroke: Stroke }
  | { type: 'cursor'; cursor: Cursor }
  | { type: 'leave' };
```

Saved changes are numbered on each board's topic, so a client can say where it left off. Cursors and ink aren't: they're relayed as they come, and the next one replaces them.

## The client

```ts
// live.ts
import {
  createWebSocket,
  createWebSocketFeeds,
  createWebSocketPresence,
  createWebSocketSendRate,
  createWebSocketState
} from 'react-websocket';
import { createWebSocketOutbox } from 'react-websocket/outbox';
import type { BoardIn, BoardOut, Cursor, Edit, Shape, Stroke } from './protocol';

export const boardId = new URLSearchParams(location.search).get('board') ?? 'main';
export const topic = `board:${boardId}`;

const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';

export const room = createWebSocket<BoardIn, BoardOut>(
  `${scheme}//${location.host}/board/${encodeURIComponent(boardId)}`,
  { json: true }
);

export const board = createWebSocketFeeds(room, {
  subscribe: (topic, after) => ({ type: 'subscribe', topic, after }),
  unsubscribe: topic => ({ type: 'unsubscribe', topic }),
  sequence: message =>
    message.type === 'drawn' || message.type === 'erased' ? message : undefined,
  snapshot: message => (message.type === 'board' ? message : undefined)
});

/** The saved shapes, oldest first: each change once, in order. */
export const shapes = createWebSocketState(board, {
  initialState: [] as Shape[],
  reduce: (list, message) => {
    if (message.type === 'board') return message.shapes;
    if (message.type === 'drawn') return [...list, message.shape];
    if (message.type === 'erased') return list.filter(shape => shape.id !== message.shape);
    return list;
  }
});

/** Edits stored until the server saves them: through reconnects, reloads and offline spells. */
export const edits = createWebSocketOutbox(room, {
  name: `board:${boardId}`,
  send: (edit: Edit, id) => ({ type: 'edit', id, edit }),
  ack: message => (message.type === 'saved' ? message.id : undefined)
});

export const cursors = createWebSocketPresence(room, {
  send: (cursor: Cursor) => ({ type: 'cursor', cursor }),
  leave: () => ({ type: 'leave' }),
  receive: message =>
    message.type === 'cursor' ? { peer: message.peer, state: message.cursor } : undefined
});

/** Strokes being drawn, at a rate that adapts to the connection, the newest one only. */
export const ink = createWebSocketSendRate(room, { maxRate: 30, maxBuffered: 16 * 1024 });

/** Other people's strokes while they draw them, by peer. */
export const inks = new Map<string, { stroke: Stroke; at: number }>();
room.on('message', message => {
  if (message.type === 'ink') inks.set(message.peer, { stroke: message.stroke, at: Date.now() });
});
```

Each kind of data gets the tool that fits it:

| Data | Tool | Because |
| --- | --- | --- |
| Saved shapes | [`createWebSocketFeeds`](../guide/topics.md#numbered-feeds) and a state store | Each change once and in order after a reconnect, and the whole board for a late joiner |
| Your edits | [`createWebSocketOutbox`](../guide/outbox.md) | Stored until the server saves them, through reconnects and reloads |
| Cursors | [`createWebSocketPresence`](../guide/presence.md) | Throttled, refreshed, never queued, and forgotten when someone goes quiet |
| A stroke while it's drawn | [`createWebSocketSendRate`](../api/create-websocket-send-rate.md) | Sent at most 30 times a second, less on a congested link, and only the newest |

- **The stroke id is the edit's id.** The outbox may send an edit more than once, and the server saves each id once.
- **`maxBuffered: 16 * 1024`** lets a stroke of a few hundred points through. The send rate's default, 1 KB, suits a cursor.
- **`inks`** holds the others' strokes while they draw. It's a plain `Map` read by the canvas loop, not React state.

On sign-out, forget this user's unsaved edits before the next person signs in on the browser. The server saves each edit as the user whose socket sends it:

```ts
export function signOut() {
  void edits.clear();
  board.reset();
  shapes.reset();
  cursors.leave();
  room.close();
}
```

## The board

```tsx
// Board.tsx
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { useWebSocketOutbox, useWebSocketStatus, useWebSocketTopic } from 'react-websocket';
import { board, cursors, edits, ink, inks, room, shapes, topic } from './live';
import type { Cursor, Point, Stroke } from './protocol';

// The board's own coordinates, whatever its size on screen.
const WIDTH = 1600;
const HEIGHT = 1000;

export function Board() {
  useWebSocketTopic(board, topic);
  const status = useWebSocketStatus(room);
  const waiting = useWebSocketOutbox(edits);
  const [color, setColor] = useState('#1f6feb');
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef<Stroke>(undefined); // the stroke under the pointer
  const mine = useRef<string[]>([]); // for undo
  const dirty = useRef(true);

  // Draw at most once a frame, and only when something changed. React never re-renders for it.
  useEffect(() => {
    const context = canvas.current!.getContext('2d')!;
    const redraw = () => void (dirty.current = true);
    const stop = [
      shapes.subscribe(redraw),
      edits.subscribe(redraw),
      cursors.subscribe(redraw),
      room.on('message', message => message.type === 'ink' && redraw())
    ];
    let frame = requestAnimationFrame(function draw() {
      // A stroke whose author went quiet mid-stroke, say offline, goes after 5 s.
      for (const [peer, { at }] of inks) {
        if (Date.now() - at < 5000) continue;
        inks.delete(peer);
        redraw();
      }
      if (dirty.current) {
        dirty.current = false;
        paint(context, drawing.current);
      }
      frame = requestAnimationFrame(draw);
    });
    return () => {
      cancelAnimationFrame(frame);
      for (const off of stop) off();
    };
  }, []);

  return (
    <main>
      <p role="status">
        {status === 'open' ? 'Live' : 'Offline: you can keep drawing'}
        {waiting.length > 0 && `, ${waiting.length} not saved yet`}
      </p>
      <input type="color" value={color} onChange={event => setColor(event.target.value)} />
      <button
        onClick={() => {
          const shape = mine.current.pop();
          if (shape) edits.add({ kind: 'erase', shape }).catch(console.error);
        }}
      >
        Undo
      </button>
      <canvas
        ref={canvas}
        width={WIDTH}
        height={HEIGHT}
        style={{ width: '100%', touchAction: 'none' }}
        onPointerDown={event => {
          event.currentTarget.setPointerCapture(event.pointerId);
          drawing.current = { id: crypto.randomUUID(), color, points: [at(event)] };
        }}
        onPointerMove={event => {
          const [x, y] = at(event);
          cursors.set({ x, y, color });
          const stroke = drawing.current;
          if (!stroke) return;
          stroke.points.push([x, y]);
          // The whole stroke so far, so a message replaced or dropped costs nothing.
          ink.send({ type: 'ink', stroke }, 'ink');
          dirty.current = true;
        }}
        onPointerUp={() => {
          const stroke = drawing.current;
          if (!stroke) return;
          drawing.current = undefined;
          mine.current.push(stroke.id);
          // The stroke's id is the edit's id: the server saves it once, however often it's sent.
          edits.add({ kind: 'draw', stroke }, stroke.id).catch(console.error);
        }}
        onPointerLeave={() => cursors.leave()}
      />
    </main>
  );
}

function at(event: PointerEvent<HTMLCanvasElement>): Point {
  const box = event.currentTarget.getBoundingClientRect();
  const x = ((event.clientX - box.left) / box.width) * WIDTH;
  const y = ((event.clientY - box.top) / box.height) * HEIGHT;
  return [Math.round(x), Math.round(y)];
}

function paint(context: CanvasRenderingContext2D, own: Stroke | undefined) {
  context.clearRect(0, 0, WIDTH, HEIGHT);
  const saved = shapes.getState();
  const ids = new Set(saved.map(shape => shape.id));
  const pending = edits.getSnapshot().map(entry => entry.message);
  const erasing = new Set(pending.flatMap(edit => (edit.kind === 'erase' ? [edit.shape] : [])));

  for (const shape of saved) if (!erasing.has(shape.id)) line(context, shape);
  for (const [peer, { stroke }] of inks) {
    if (ids.has(stroke.id)) inks.delete(peer); // saved: drawn above
    else line(context, stroke);
  }
  // Your edits the server hasn't saved yet, faded.
  context.globalAlpha = 0.5;
  for (const edit of pending) {
    if (edit.kind === 'draw' && !ids.has(edit.stroke.id)) line(context, edit.stroke);
  }
  context.globalAlpha = 1;
  if (own) line(context, own);
  for (const { state } of cursors.getSnapshot()) pointer(context, state);
}

function line(context: CanvasRenderingContext2D, { color, points }: Stroke) {
  context.strokeStyle = color;
  context.lineWidth = 4;
  context.lineCap = context.lineJoin = 'round';
  context.beginPath();
  points.forEach(([x, y], i) => (i ? context.lineTo(x, y) : context.moveTo(x, y)));
  context.stroke();
}

function pointer(context: CanvasRenderingContext2D, { x, y, color, name }: Cursor) {
  context.fillStyle = color;
  context.beginPath();
  context.arc(x, y, 6, 0, 2 * Math.PI);
  context.fill();
  if (name) context.fillText(name, x + 10, y + 4);
}
```

- **The canvas loop** runs on `requestAnimationFrame`, and paints only when something changed: a saved shape, an edit, a cursor or ink. React renders the toolbar and the status line, and never a pointer move.
- **Your own stroke** is drawn from the pointer, with no round trip.
- **Others' strokes** are drawn from `inks` until the saved shape with the same id arrives, so there's no gap between the last ink and the saved stroke. One whose author went quiet goes after five seconds.
- **Unsaved edits** are drawn faded, from the outbox, until the server's copy arrives. An erase waiting in the outbox hides its shape right away.
- **Undo** erases your last stroke, through the outbox like any edit.

## The server

The server numbers each board's changes, keeps the last 2,000 to catch clients up, and relays cursors and ink to everyone else on the board. It runs in Node 22.18 or later without a build step, which is why it imports `.ts` files by name. Keep the boards and the saved edit ids in your database.

### The board and catching up

```ts
// server.ts
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { userFromCookie } from './auth.ts';
import type { BoardIn, BoardOut, Cursor, Edit, Shape, Stroke } from './protocol.ts';

type Board = {
  seq: number;
  shapes: Shape[];
  log: { seq: number; message: BoardIn }[]; // recent changes, to catch a client up
  sockets: Set<WebSocket>; // everyone on the board
  following: Set<WebSocket>; // the ones subscribed to its changes
  cursors: Map<string, Cursor>; // peer: the latest cursor, for newcomers
};

const KEPT = 2000;
const boards = new Map<string, Board>(); // use your database
const saved = new Set<string>(); // edit ids already applied

function boardFor(id: string) {
  let board = boards.get(id);
  if (!board) {
    board = {
      seq: 0,
      shapes: [],
      log: [],
      sockets: new Set(),
      following: new Set(),
      cursors: new Map()
    };
    boards.set(id, board);
  }
  return board;
}

function send(socket: WebSocket, message: BoardIn) {
  socket.send(JSON.stringify(message));
}

function others(board: Board, socket: WebSocket, message: BoardIn) {
  for (const other of board.sockets) if (other !== socket) send(other, message);
}

function subscribe(board: Board, socket: WebSocket, topic: string, after: number | undefined) {
  const oldest = board.log[0]?.seq ?? board.seq + 1;
  if (after === undefined || after < oldest - 1 || after > board.seq) {
    send(socket, { type: 'board', topic, seq: board.seq, shapes: board.shapes });
  } else {
    for (const { seq, message } of board.log) if (seq > after) send(socket, message);
  }
  board.following.add(socket);
}
```

A newcomer, a client too far behind, and one ahead of a server that lost its numbers get the whole board. Anyone else gets the changes after the number they have.

### Saving edits

```ts
/** Apply an edit once, however often it arrives, and number it. */
function apply(board: Board, topic: string, user: string, id: string, edit: Edit) {
  if (saved.has(id)) return;
  saved.add(id);
  let message: BoardIn;
  if (edit.kind === 'draw') {
    const shape = { ...edit.stroke, author: user };
    board.shapes.push(shape);
    message = { type: 'drawn', topic, seq: ++board.seq, shape };
  } else {
    // Only its author can erase a shape.
    const shape = board.shapes.find(shape => shape.id === edit.shape);
    if (shape?.author !== user) return;
    board.shapes = board.shapes.filter(other => other !== shape);
    message = { type: 'erased', topic, seq: ++board.seq, shape: shape.id };
  }
  board.log.push({ seq: board.seq, message });
  if (board.log.length > KEPT) board.log.shift();
  for (const socket of board.following) send(socket, message);
}
```

- **Each edit id is applied once.** An edit that arrives again, because its acknowledgement was lost or two tabs sent it, changes nothing.
- **Only its author can erase a shape.** Check whatever your app allows, and limit the stroke, such as how many points it has, before saving it.

### The connection

```ts
const isString = (value: unknown) => typeof value === 'string';
const isPoint = (point: unknown) =>
  Array.isArray(point) && point.length === 2 && point.every(Number.isFinite);
const isStroke = (stroke?: Partial<Stroke>) =>
  isString(stroke?.id) &&
  isString(stroke?.color) &&
  Array.isArray(stroke?.points) &&
  stroke.points.every(isPoint);
const isCursor = (cursor?: Partial<Cursor>) =>
  Number.isFinite(cursor?.x) && Number.isFinite(cursor?.y) && isString(cursor?.color);

/** A client's message, if it's JSON with the fields its type needs. */
function parse(data: string): BoardOut | undefined {
  try {
    const message = JSON.parse(data);
    const type = message?.type;
    if (type === 'subscribe' && isString(message.topic) && Number.isInteger(message.after ?? 0))
      return message;
    if (type === 'unsubscribe' || type === 'leave') return message;
    if (type === 'edit' && isString(message.id)) {
      const { edit } = message;
      if (edit?.kind === 'draw' && isStroke(edit.stroke)) return message;
      if (edit?.kind === 'erase' && isString(edit.shape)) return message;
    }
    if (type === 'ink' && isStroke(message.stroke)) return message;
    if (type === 'cursor' && isCursor(message.cursor)) return message;
  } catch {
    // Not JSON.
  }
  return undefined;
}

function connected(socket: WebSocket, user: string, id: string) {
  const board = boardFor(id);
  const topic = `board:${id}`;
  const peer = randomUUID();
  board.sockets.add(socket);
  for (const [other, cursor] of board.cursors) {
    send(socket, { type: 'cursor', peer: other, cursor });
  }
  socket.on('error', console.error);

  socket.on('message', data => {
    const message = parse(String(data));
    if (!message) return socket.close(1003, 'Invalid message');
    switch (message.type) {
      case 'subscribe':
        if (message.topic === topic) subscribe(board, socket, topic, message.after);
        break;
      case 'unsubscribe':
        board.following.delete(socket);
        break;
      case 'edit':
        apply(board, topic, user, message.id, message.edit);
        // Acknowledge an id it has seen, too: the first acknowledgement may never have arrived.
        send(socket, { type: 'saved', id: message.id });
        break;
      case 'ink':
        others(board, socket, { type: 'ink', peer, stroke: message.stroke });
        break;
      case 'cursor': {
        const cursor = { ...message.cursor, name: user };
        board.cursors.set(peer, cursor);
        others(board, socket, { type: 'cursor', peer, cursor });
        break;
      }
      case 'leave':
        board.cursors.delete(peer);
        others(board, socket, { type: 'cursor', peer, cursor: null });
        break;
    }
  });

  socket.on('close', () => {
    board.sockets.delete(socket);
    board.following.delete(socket);
    board.cursors.delete(peer);
    others(board, socket, { type: 'cursor', peer, cursor: null });
  });
}

const server = createServer();
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', async (request, stream, head) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const [, path, id] = url.pathname.split('/');
  // Any site can open a socket to yours with the user's cookies: check where it comes from.
  if (path !== 'board' || !id || request.headers.origin !== process.env.APP_ORIGIN) {
    return stream.destroy();
  }
  const user = await userFromCookie(request.headers.cookie);
  wss.handleUpgrade(request, stream, head, socket => {
    if (user) connected(socket, user, decodeURIComponent(id));
    else socket.close(1008, 'Unauthorized'); // the client doesn't retry 1008
  });
});

server.listen(Number(process.env.PORT ?? 8080));
```

`parse` checks every message before the server uses it: JSON, a known `type`, and the fields that type needs, down to each stroke's points. Anything else closes only that socket, with `1003`, which the client doesn't retry. An error thrown in the listener would stop the server and drop every board.

Every acknowledgement goes out, even for an edit seen before, since the first one may never have arrived.

## Shared notes with Yjs

A whiteboard's shapes are whole objects: a stroke is drawn, or erased. Text that people edit at the same time, like the board's notes, needs merging character by character. A CRDT library such as [Yjs](https://yjs.dev/) does the merging, and only needs a way to pass its updates around. A react-websocket client carries them as binary messages:

```ts
// notes.ts: the board's notes as a Yjs document, on a socket of their own.
import { createWebSocket } from 'react-websocket';
import * as Y from 'yjs';
import { boardId } from './live';

export const doc = new Y.Doc();
export const notes = doc.getText('notes');

const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';

export const sync = createWebSocket<ArrayBuffer, Uint8Array>(
  `${scheme}//${location.host}/notes/${encodeURIComponent(boardId)}`,
  // Changes made while offline wait in the document, so nothing needs to wait in a queue.
  { binaryType: 'arraybuffer', queue: false }
);

// Each connection starts with the whole document: the server keeps what it was missing.
sync.on('open', () => sync.send(Y.encodeStateAsUpdate(doc)));

// Then every change, as it's made.
doc.on('update', (update: Uint8Array, origin: unknown) => {
  if (origin !== sync) sync.send(update);
});

// Changes from others. `sync` as the origin keeps them from being sent back.
sync.on('message', data => Y.applyUpdate(doc, new Uint8Array(data), sync));
```

- **On every connection**, the client sends its whole document, and the server keeps what it was missing. Edits made offline are in the document, so they need no queue, and the client is created with `queue: false`.
- **While connected**, each change goes out as Yjs makes it.
- **Changes from others** are applied with `sync` as their origin, so the `update` listener doesn't send them back.

Nothing holds this client by itself. Hold it from the component that shows the notes:

```tsx
// Notes.tsx
import { useWebSocketStatus } from 'react-websocket';
import { sync } from './notes';

export function Notes() {
  // Holds the notes' connection while they're on screen.
  const status = useWebSocketStatus(sync);
  // Bind `notes` to your editor with its Yjs binding, such as y-prosemirror.
  return <p role="status">{status === 'open' ? 'Notes saved' : 'Notes offline: edits are kept'}</p>;
}
```

The server keeps a document per board, applies what it receives, and passes on only what was new:

```ts
// notes-server.ts: a Yjs document per board, kept on the server.
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import * as Y from 'yjs';

// Persist the documents in production: Y.encodeStateAsUpdate(doc) is all there is to store.
const docs = new Map<string, { doc: Y.Doc; sockets: Set<WebSocket> }>();

function connected(socket: WebSocket, id: string) {
  let room = docs.get(id);
  if (!room) docs.set(id, (room = { doc: new Y.Doc(), sockets: new Set() }));
  const { doc, sockets } = room;
  sockets.add(socket);
  socket.send(Y.encodeStateAsUpdate(doc));
  socket.on('error', console.error);

  socket.on('message', data => {
    const before = Y.encodeStateVector(doc);
    try {
      Y.applyUpdate(doc, new Uint8Array(data as Buffer));
    } catch {
      return socket.close(1003, 'Invalid update'); // not a Yjs update
    }
    // Pass on only what was new: a client's first message is the whole document.
    const news = Y.encodeStateAsUpdate(doc, before);
    if (news.length <= 2) return; // an empty update
    for (const other of sockets) if (other !== socket) other.send(news);
  });
  socket.on('close', () => sockets.delete(socket));
}

const server = createServer();
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, stream, head) => {
  const [, path, id] = new URL(request.url ?? '/', 'http://localhost').pathname.split('/');
  if (path !== 'notes' || !id) return stream.destroy();
  // Check the user and the Origin as for the board.
  wss.handleUpgrade(request, stream, head, socket => connected(socket, decodeURIComponent(id)));
});

server.listen(Number(process.env.PORT ?? 8081));
```

A client's first message is its whole document, which is mostly what the server has already. `Y.encodeStateAsUpdate(doc, before)` keeps only what that message added, and an update with nothing in it is 2 bytes, so it isn't passed on. When `Y.applyUpdate` can't read a message, it throws, and only the client that sent it is closed. For large documents, send a state vector first and only the missing part, as Yjs's own sync protocol does.

## When things go wrong

| What happens | What the user sees | Why |
| --- | --- | --- |
| The connection drops | "Offline: you can keep drawing", then their strokes saved when it's back | The outbox keeps the edits, and sends them on the next connection |
| They reload while offline | Their unsaved strokes, faded, then saved | The outbox loads them from IndexedDB |
| An edit is sent twice | One stroke | The server applies each id once |
| Someone joins late | The whole board, then every change | The feed subscribes without a number, and the server sends a snapshot |
| A connection drops for a moment | Nothing missing, nothing twice | The feed subscribes again with the last number |
| Someone's laptop dies mid-stroke | Their half-stroke goes after 5 s, their cursor within 30 s | `inks` expire in the canvas loop. Presence forgets a quiet peer |
| A slow link | Others see the stroke in bigger steps | The send rate halves when the send buffer fills |
| Two people edit the notes offline | Both edits, merged | Yjs, and the whole document on every connection |

In Chrome, against the servers on this page, with two pages for two users:

- **Ink.** A stroke of 120 pointer moves over two seconds sent 61 ink messages, and the other page saw it with every point while it was drawn.
- **React.** Neither page rendered React during the stroke. The drawing page painted the canvas 117 times, and the watching page 81 times, at 60 frames a second.
- **Late joiners.** A third page opened later got the saved shape in the board's snapshot.
- **Offline.** Two strokes drawn while the client was closed showed "2 not saved yet", survived a reload, and were saved once each when the page connected again.
- **Undo** erased the last stroke for both pages. An erase of someone else's shape was acknowledged and changed nothing.
- **Yjs.** Edits made on both pages while one was offline merged into the same text on both once it reconnected.

## Testing it

Open the board in two browser profiles, and draw in one while watching the other. Call `room.close()` to draw offline, and `room.connect()` to come back, or stop the server. To exercise the send rate, slow the link with [`react-websocket/chaos`](../guide/chaos.md), `latency: [100, 300]`, and watch the ink arrive in bigger steps.

## See also

- [Presence and live cursors](../guide/presence.md) and [`createWebSocketPresence`](../api/create-websocket-presence.md)
- [Numbered feeds](../guide/topics.md#numbered-feeds), [Offline outbox](../guide/outbox.md) and [`createWebSocketSendRate`](../api/create-websocket-send-rate.md)
- [Real-time games](../guide/games.md): the send rate and drawing outside React, for games
- [Build a team chat app](./team-chat.md): the same feeds, outbox and presence for chat
