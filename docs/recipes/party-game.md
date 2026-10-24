---
title: 'Build a multiplayer party game with React and WebSockets'
description: 'A trivia party game over one WebSocket: rooms with a join code, a lobby that shows who is here, a countdown every screen agrees on, answers counted exactly once, and phones that rejoin after they sleep.'
---

# Build a multiplayer party game

This guide builds a trivia party game: a host screen on the TV shows a code, players join on their phones, and everyone races the same countdown. Turn-based games don't need 60 fps, but they meet real networks at their worst, on phones:

1. **Phones sleep.** A player locks their screen between questions. Their connection dies, sometimes without the server noticing, and they expect to be back in the game when they unlock.
2. **Everyone sees the same countdown.** Player clocks are often seconds apart. A countdown built on each phone's `Date.now()` ends at a different moment on every screen.
3. **An answer counts once.** A phone on a train sends its answer, then loses the connection before the reply. It must send it again, and the server must not count it twice.
4. **The host sees who's still here.** A phone that went dark should show as away, even when the server never saw it disconnect.
5. **Thirty phones answer in the same second.** The host's screen shouldn't render thirty times.

| File | Runs in | |
| --- | --- | --- |
| `protocol.ts` | Both | The messages |
| `live.ts` | The browser | The connection, the seat, presence, the clock, the room and the requests |
| `Countdown.tsx` | The browser | The countdown, on the server's clock |
| `Host.tsx`, `Phone.tsx` | The browser | The two screens |
| `server.ts`, `questions.ts` | Node | The rooms and the game |

## The protocol

The server sends the whole room, what every screen shows, whenever it changes. Requests carry an `id`, and their replies echo it.

```ts
// protocol.ts: imported by the browser and the server.
export type Phase =
  | { name: 'lobby' }
  | { name: 'question'; index: number; text: string; choices: string[]; endsAt: number }
  | { name: 'reveal'; index: number; text: string; choices: string[]; correct: number }
  | { name: 'final' };

export type Player = { id: string; name: string; score: number; answered: boolean };

/** Everything the screens show. Sent to everyone in the room whenever it changes. */
export type Room = { code: string; phase: Phase; players: Player[] };

/** A seat at a game: the host's, or a player's. Kept to sit down again after a reconnect. */
export type Seat = { token: string; code: string; playerId?: string; name?: string };

export type PartyIn =
  | { type: 'room'; room: Room }
  // The token didn't match a seat: the game is over, or the server restarted.
  | { type: 'unseated' }
  // Replies to requests.
  | { type: 'seated'; id: number; seat: Seat }
  | { type: 'locked'; id: number; question: number }
  | { type: 'refused'; id: number; error: string }
  // Presence: a player's phone is here, or it left.
  | { type: 'here'; peer: string; state: { name: string } | null }
  | { type: 'pong'; id: number; time: number };

export type PartyOut =
  | { type: 'create'; id: number }
  | { type: 'join'; id: number; code: string; name: string }
  | { type: 'answer'; id: number; question: number; choice: number }
  | { type: 'rejoin'; token: string }
  | { type: 'start' }
  | { type: 'next' }
  | { type: 'here'; state: { name: string } }
  | { type: 'ping'; id: number };
```

A `Seat` is what a phone needs to get back into the game: a token the server gave it when it joined.

## The client

### The connection and the seat

```ts
// live.ts
import {
  createWebSocket,
  createWebSocketLatency,
  createWebSocketPresence,
  createWebSocketRequests,
  createWebSocketState
} from 'react-websocket';
import type { PartyIn, PartyOut, Room, Seat } from './protocol';

const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';

export const party = createWebSocket<PartyIn, PartyOut>(() => `${scheme}//${location.host}/party`, {
  json: true,
  // A phone that sleeps can leave a dead connection behind: a ping nobody answers finds it.
  heartbeat: { interval: 10_000, pong: 'pong', timeout: 5_000 }
});

// The seat survives a reload in this tab. A phone that slept wakes up with it too.
let seat: Seat | undefined =
  JSON.parse(sessionStorage.getItem('party-seat') ?? 'null') ?? undefined;

function sit(next: Seat | undefined) {
  seat = next;
  if (next) sessionStorage.setItem('party-seat', JSON.stringify(next));
  else sessionStorage.removeItem('party-seat');
}

export const mySeat = () => seat;

// Sit down again on every connection, before anything queued goes out. Registered before the
// presence below, so the server knows who this is before the first presence update.
party.on('open', () => {
  if (seat) party.send({ type: 'rejoin', token: seat.token });
});
```

- **The heartbeat** pings every 10 seconds. A connection that a sleeping phone left behind answers nothing, and is replaced within 5 seconds of the next ping. Phones also reconnect at once when the network or the tab comes back. See [Heartbeats](../guide/reconnecting.md#heartbeats).
- **The seat** is kept in `sessionStorage`, so a reload in the same tab sits down again. A phone that slept and woke keeps it too. To keep it after the tab is closed, use `localStorage`, keyed by the room's code.
- **The `open` listener** sends `rejoin` first on every connection. Open listeners run before the send queue is flushed, so the server knows who this is before an answer queued while offline arrives. See [First-message auth](../guide/authentication.md#first-message-auth).

### Presence, the clock and the room

```ts
export const online = createWebSocketPresence(party, {
  send: (state: { name: string }) => ({ type: 'here', state }),
  receive: message => (message.type === 'here' ? message : undefined),
  // Phones refresh every 5 s. One that's gone quiet for 15 s is shown as away.
  timeout: 15_000
});
if (seat?.name) online.set({ name: seat.name });

export const latency = createWebSocketLatency(party, {
  ping: id => ({ type: 'ping', id }),
  pong: message => (message.type === 'pong' ? message : undefined)
});

export const room = createWebSocketState(party, {
  initialState: null as Room | null,
  reduce: (state, message) => {
    if (message.type === 'room') return message.room;
    if (message.type === 'unseated') return null;
    return state;
  },
  // Thirty phones answering in the same second: render the host's screen once per frame.
  batch: 'frame'
});

party.on('message', message => {
  if (message.type === 'unseated') sit(undefined);
});
```

- **`online`** shares each player's name with [presence](../guide/presence.md). It's refreshed every 5 seconds, a third of `timeout`, and a peer nobody hears from for 15 seconds goes away on its own. That catches a phone that went dark without the server noticing. It's created after the `open` listener above, so on a new connection `rejoin` goes out before the first presence update.
- **`latency`** pings every 2 seconds and estimates the offset between the server's clock and this one. `latency.serverNow()` is the server's time, here.
- **`room`** is the room as the server last sent it, in a [state store](../guide/state.md). `batch: 'frame'` renders a screen at most once per frame, however many answers arrive at once.

### Requests

```ts
/** The server said no: the code is wrong, the game has started, time's up. */
export class Refused extends Error {}

type Request =
  | { type: 'create' }
  | { type: 'join'; code: string; name: string }
  | { type: 'answer'; question: number; choice: number };

export const rpc = createWebSocketRequests(party, {
  send: (request: Request, id) => ({ ...request, id }),
  reply: message =>
    message.type === 'seated' || message.type === 'locked' || message.type === 'refused'
      ? message.id
      : undefined,
  error: message => (message.type === 'refused' ? new Refused(message.error) : undefined),
  timeout: 5_000
});

export async function createRoom() {
  const reply = await rpc.request({ type: 'create' });
  if (reply.type === 'seated') sit(reply.seat);
}

export async function joinRoom(code: string, name: string) {
  const reply = await rpc.request({ type: 'join', code: code.toUpperCase(), name });
  if (reply.type !== 'seated') return;
  sit({ ...reply.seat, name });
  online.set({ name });
}

/** Lock in an answer. If the connection drops before the server says so, ask again. */
export async function answer(question: number, choice: number) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await rpc.request({ type: 'answer', question, choice });
    } catch (error) {
      // "Time's up" is final. A lost connection isn't: the request waits for the next one.
      if (error instanceof Refused || attempt === 3) throw error;
    }
  }
}
```

- **Creating and joining** are [requests](../api/create-websocket-requests.md): they resolve with the reply, or reject with `Refused`, a timeout or a lost connection.
- **An answer is sent again** when its connection drops before the reply. The request rejects, and the next one waits in the send queue for the new connection, behind `rejoin`. The server keeps one answer per player per question, so asking twice can't count twice. "Time's up" is a `Refused`, which isn't sent again.

## The countdown

```tsx
// Countdown.tsx
import { useEffect, useState } from 'react';
import { latency } from './live';

/** Seconds left until `endsAt`, on the server's clock: the same on every screen. */
const secondsLeft = (endsAt: number) =>
  Math.max(0, Math.ceil((endsAt - latency.serverNow()) / 1000));

export function Countdown({ endsAt }: { endsAt: number }) {
  const [left, setLeft] = useState(() => secondsLeft(endsAt));
  useEffect(() => {
    const timer = setInterval(() => setLeft(secondsLeft(endsAt)), 200);
    return () => clearInterval(timer);
  }, [endsAt]);
  return <p role="timer">{left}</p>;
}
```

The server sends `endsAt` on its own clock. Every screen subtracts `serverNow()`, so they all show the same number, whatever their own clocks say. The server still decides: an answer that arrives after `endsAt` is refused there.

## The screens

### The host

```tsx
// Host.tsx: the big screen.
import { useWebSocketLatency, useWebSocketPresence, useWebSocketState } from 'react-websocket';
import { Countdown } from './Countdown';
import { createRoom, latency, online, party, room } from './live';

export function Host() {
  const current = useWebSocketState(room);
  const here = useWebSocketPresence(online);
  useWebSocketLatency(latency); // measure the clock offset while the screen is up

  if (!current) return <button onClick={() => void createRoom()}>New game</button>;
  const { code, phase, players } = current;
  const away = (id: string) => !here.some(peer => peer.peer === id);

  return (
    <main>
      <p>
        Join at this address with code <strong>{code}</strong>
      </p>
      {phase.name === 'lobby' && (
        <button onClick={() => party.send({ type: 'start' })} disabled={!players.length}>
          Start
        </button>
      )}
      {phase.name === 'question' && (
        <>
          <h2>{phase.text}</h2>
          <Countdown endsAt={phase.endsAt} />
          <p>
            {players.filter(player => player.answered).length} of {players.length} answered
          </p>
        </>
      )}
      {phase.name === 'reveal' && (
        <>
          <h2>{phase.text}</h2>
          <p>The answer: {phase.choices[phase.correct]}</p>
          <button onClick={() => party.send({ type: 'next' })}>Next</button>
        </>
      )}
      {phase.name === 'final' && <h2>Final scores</h2>}
      <ol>
        {[...players]
          .sort((a, b) => b.score - a.score)
          .map(player => (
            <li key={player.id}>
              {player.name}: {player.score}
              {away(player.id) && ' (away)'}
            </li>
          ))}
      </ol>
    </main>
  );
}
```

A player shows as away when presence has no peer for them: they left, or nothing has arrived from their phone for 15 seconds.

### The phones

```tsx
// Phone.tsx: each player's screen.
import { useState } from 'react';
import { useWebSocketLatency, useWebSocketState, useWebSocketStatus } from 'react-websocket';
import { Countdown } from './Countdown';
import { Refused, answer, joinRoom, latency, mySeat, party, room } from './live';

export function Phone() {
  const current = useWebSocketState(room);
  const status = useWebSocketStatus(party);
  useWebSocketLatency(latency);
  const [sending, setSending] = useState<number>();
  const [error, setError] = useState<string>();

  if (!current) return <JoinForm />;
  const { phase, players } = current;
  const me = players.find(player => player.id === mySeat()?.playerId);

  async function choose(question: number, choice: number) {
    setSending(question);
    setError(undefined);
    try {
      await answer(question, choice);
    } catch (reason) {
      setError(reason instanceof Refused ? reason.message : 'Not sent. Check your connection.');
    } finally {
      setSending(undefined);
    }
  }

  return (
    <main>
      {status !== 'open' && <p role="status">Reconnecting…</p>}
      {error && <p role="alert">{error}</p>}
      {phase.name === 'lobby' && <p>You're in, {me?.name}. Waiting for the host…</p>}
      {phase.name === 'question' && (
        <>
          <Countdown endsAt={phase.endsAt} />
          {me?.answered ? (
            <p>Answer locked in.</p>
          ) : (
            phase.choices.map((choice, i) => (
              <button
                key={choice}
                disabled={sending === phase.index}
                onClick={() => void choose(phase.index, i)}
              >
                {choice}
              </button>
            ))
          )}
        </>
      )}
      {phase.name === 'reveal' && <p>The answer: {phase.choices[phase.correct]}</p>}
      {phase.name === 'final' && <p>Game over</p>}
      <p>Your score: {me?.score ?? 0}</p>
    </main>
  );
}

function JoinForm() {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string>();
  return (
    <form
      onSubmit={event => {
        event.preventDefault();
        joinRoom(code, name).catch((reason: unknown) =>
          setError(reason instanceof Refused ? reason.message : "Couldn't join. Try again.")
        );
      }}
    >
      <input value={code} onChange={event => setCode(event.target.value)} placeholder="Code" />
      <input value={name} onChange={event => setName(event.target.value)} placeholder="Name" />
      <button>Join</button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
```

"Answer locked in" comes from the room, `answered` on this player, not from local state. After a reload, or on a phone that slept, the screen is right as soon as the room arrives.

## The server

The server keeps every game in memory, and runs in Node 22.18 or later without a build step, which is why it imports `.ts` files by name. Keep games in your database or Redis to survive a restart, and delete them, with their seats, when they end.

### Rooms and seats

```ts
// server.ts
import { randomInt, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { PartyIn, PartyOut, Phase, Room } from './protocol.ts';
import { questions } from './questions.ts';

const QUESTION_MS = 15_000;
const now = () => Date.now(); // the clock every countdown follows

type Seated = {
  id: string;
  name: string;
  score: number;
  socket?: WebSocket; // the phone, while it's connected
  here?: { name: string }; // its last presence update
  answers: Map<number, { choice: number; at: number }>; // by question
};

type Game = {
  code: string;
  phase: Phase;
  host?: WebSocket;
  players: Map<string, Seated>;
  timer?: ReturnType<typeof setTimeout>;
};

const games = new Map<string, Game>(); // by code
const seats = new Map<string, { code: string; playerId?: string }>(); // by token
const sockets = new Map<WebSocket, { game: Game; playerId?: string }>(); // who's on each one

function send(socket: WebSocket | undefined, message: PartyIn) {
  socket?.send(JSON.stringify(message));
}

function refuse(socket: WebSocket, id: number, error: string) {
  send(socket, { type: 'refused', id, error });
}

/** Everyone in the room: the host's screen and every phone. */
function everyone(game: Game) {
  return [game.host, ...[...game.players.values()].map(player => player.socket)];
}

function view(game: Game): Room {
  const question = game.phase.name === 'question' ? game.phase.index : -1;
  const players = [...game.players.values()].map(({ id, name, score, answers }) => ({
    id,
    name,
    score,
    answered: answers.has(question)
  }));
  return { code: game.code, phase: game.phase, players };
}

/** Who's here, for a screen that just connected: it shouldn't wait for the next refresh. */
function greet(socket: WebSocket, game: Game) {
  for (const player of game.players.values()) {
    if (player.here && player.socket !== socket) {
      send(socket, { type: 'here', peer: player.id, state: player.here });
    }
  }
}

function publish(game: Game) {
  const message: PartyIn = { type: 'room', room: view(game) };
  for (const socket of everyone(game)) send(socket, message);
}
```

- **Three maps**: games by code, seats by token, and who's on each socket. A seat outlives its socket. A player whose phone disconnected is still in the game, with their score.
- **`greet`** sends a screen that just connected everyone's presence, so a host that reloads doesn't show every player as away until their next refresh.
- **`now`** is the clock the countdowns follow, the same one the pongs carry.

### Questions and scores

```ts
function ask(game: Game, index: number) {
  const question = questions[index];
  if (!question) {
    game.phase = { name: 'final' };
    return publish(game);
  }
  const { text, choices } = question;
  game.phase = { name: 'question', index, text, choices, endsAt: now() + QUESTION_MS };
  game.timer = setTimeout(() => reveal(game), QUESTION_MS);
  publish(game);
}

function reveal(game: Game) {
  if (game.phase.name !== 'question') return;
  clearTimeout(game.timer);
  const { index, text, choices, endsAt } = game.phase;
  const { correct } = questions[index]!;
  for (const player of game.players.values()) {
    const answer = player.answers.get(index);
    // 500 for a right answer, and up to 500 more for a fast one.
    if (answer?.choice !== correct) continue;
    player.score += 500 + Math.round((500 * (endsAt - answer.at)) / QUESTION_MS);
  }
  game.phase = { name: 'reveal', index, text, choices, correct };
  publish(game);
}

function newCode() {
  const letters = 'BCDFGHJKLMNPQRSTVWXZ'; // no vowels: no words, no 0/O mix-ups
  let code;
  do code = Array.from({ length: 4 }, () => letters[randomInt(letters.length)]).join('');
  while (games.has(code));
  return code;
}
```

A question ends when its time runs out, or when everyone has answered. Scores change only at the reveal, so nobody can tell from the scoreboard who got it right before then.

### Messages

```ts
function received(socket: WebSocket, message: PartyOut) {
  const seat = sockets.get(socket);
  const game = seat?.game;
  const player = seat?.playerId ? game?.players.get(seat.playerId) : undefined;

  switch (message.type) {
    case 'ping':
      return send(socket, { type: 'pong', id: message.id, time: now() });

    case 'create': {
      const created: Game = {
        code: newCode(),
        phase: { name: 'lobby' },
        host: socket,
        players: new Map()
      };
      const token = randomUUID();
      games.set(created.code, created);
      seats.set(token, { code: created.code });
      sockets.set(socket, { game: created });
      send(socket, { type: 'seated', id: message.id, seat: { token, code: created.code } });
      return publish(created);
    }

    case 'join': {
      const joining = games.get(message.code);
      const name = message.name.trim().slice(0, 20);
      if (!joining) return refuse(socket, message.id, 'No game has that code.');
      if (joining.phase.name !== 'lobby') return refuse(socket, message.id, 'It has started.');
      if (!name) return refuse(socket, message.id, 'Pick a name.');
      const playerId = randomUUID();
      const token = randomUUID();
      joining.players.set(playerId, { id: playerId, name, score: 0, socket, answers: new Map() });
      seats.set(token, { code: joining.code, playerId });
      sockets.set(socket, { game: joining, playerId });
      const seat = { token, code: joining.code, playerId };
      send(socket, { type: 'seated', id: message.id, seat });
      publish(joining);
      return greet(socket, joining);
    }

    case 'rejoin': {
      const seat = seats.get(message.token);
      const back = seat && games.get(seat.code);
      const seated = seat?.playerId ? back?.players.get(seat.playerId) : undefined;
      if (!back || (seat.playerId && !seated)) return send(socket, { type: 'unseated' });
      if (seated) seated.socket = socket;
      else back.host = socket;
      sockets.set(socket, { game: back, playerId: seated?.id });
      // Whatever happened while this phone slept: the question, the countdown, the scores.
      send(socket, { type: 'room', room: view(back) });
      return greet(socket, back);
    }
```

- **`rejoin`** puts a new socket in an old seat, and sends the room as it is now: the question, the countdown and the scores, whatever happened while the phone slept. An unknown token gets `unseated`, and the phone goes back to the join form.
- **Every request gets exactly one reply**: `seated`, `locked` or `refused`, with the request's `id`.

```ts
    case 'start':
      if (game?.host === socket && game.phase.name === 'lobby') ask(game, 0);
      return;

    case 'next':
      if (game?.host === socket && game.phase.name === 'reveal') ask(game, game.phase.index + 1);
      return;

    case 'answer': {
      if (!game || !player) return refuse(socket, message.id, 'Join a game first.');
      const { id, question, choice } = message;
      // Answered already: the phone lost the reply and asked again. Same reply, no new answer.
      if (player.answers.has(question)) return send(socket, { type: 'locked', id, question });
      const { phase } = game;
      if (phase.name !== 'question' || phase.index !== question || now() > phase.endsAt) {
        return refuse(socket, id, "Time's up.");
      }
      player.answers.set(question, { choice, at: now() });
      send(socket, { type: 'locked', id, question });
      const all = [...game.players.values()].every(other => other.answers.has(question));
      return all ? reveal(game) : publish(game);
    }

    case 'here':
      // Presence: tell the rest of the room this phone is here.
      if (!game || !player) return;
      player.here = message.state;
      for (const other of everyone(game)) {
        if (other !== socket) send(other, { type: 'here', peer: player.id, state: message.state });
      }
      return;
  }
}
```

- **The duplicate check comes first.** An answer sent again after a lost reply gets the same `locked` reply, even if the question has ended since.
- **Presence is relayed** to the rest of the room, with the player's id as the peer. That id stays the same across reconnects, so a phone that comes back doesn't show up as a second player.

### The connection

```ts
function closed(socket: WebSocket) {
  const seat = sockets.get(socket);
  sockets.delete(socket);
  if (!seat) return;
  const { game } = seat;
  if (game.host === socket) game.host = undefined;
  const player = seat.playerId ? game.players.get(seat.playerId) : undefined;
  // A phone that came back on a new connection already replaced this one.
  if (!player || player.socket !== socket) return;
  player.socket = undefined;
  player.here = undefined;
  for (const other of everyone(game)) send(other, { type: 'here', peer: player.id, state: null });
}

const isString = (value: unknown) => typeof value === 'string';

/** A client's message, if it's JSON with the fields its type needs. */
function parse(data: string): PartyOut | undefined {
  try {
    const message = JSON.parse(data);
    const type = message?.type;
    if (type === 'create' || type === 'start' || type === 'next' || type === 'ping') return message;
    if (type === 'join' && isString(message.code) && isString(message.name)) return message;
    if (type === 'answer' && Number.isInteger(message.question) && Number.isInteger(message.choice))
      return message;
    if (type === 'rejoin' && isString(message.token)) return message;
    if (type === 'here' && isString(message.state?.name)) return message;
  } catch {
    // Not JSON.
  }
  return undefined;
}

const server = createServer();
const wss = new WebSocketServer({ server, path: '/party' });

wss.on('connection', socket => {
  socket.on('error', console.error);
  socket.on('message', data => {
    if (String(data) === 'ping') return socket.send('pong'); // the client's heartbeat
    const message = parse(String(data));
    if (!message) return socket.close(1003, 'Invalid message');
    received(socket, message);
  });
  socket.on('close', () => closed(socket));
});

server.listen(Number(process.env.PORT ?? 8080));
```

`parse` checks every message before `received` sees it: JSON, a known `type`, and the fields that type needs. Anything else closes only that socket, with `1003`, which the client doesn't retry. An error thrown in the listener would stop the server and end every game.

When a phone's socket closes, the others hear it left. Its seat stays. A phone that reconnected before its old socket closed has already replaced it, so the late close changes nothing.

## When things go wrong

| What happens | What they see | Why |
| --- | --- | --- |
| A phone sleeps through a question | The host shows it as away. When it wakes, the current question and countdown | Presence times out. `rejoin` and the room bring it back |
| The connection drops after an answer was sent | "Answer locked in", once | The answer is sent again on the next connection, and the server keeps one per question |
| The answer arrives after the countdown | "Time's up." | The server checks `endsAt` on its own clock |
| A player's clock is seconds off | The same countdown as everyone else | `serverNow()` |
| The host reloads | The game, as it was, with everyone here | The host's seat, the room, and `greet` |
| The server restarts | Everyone back at the start: "New game" and the join form | The seats were in memory, so `rejoin` gets `unseated` |
| A wrong code, or a game that has started | "No game has that code." or "It has started." | `Refused` |

In Chrome, against the server on this page with its clock set 2.5 s fast, and a host and two players in separate browser profiles: all three estimated the offset as 2.5 s, to within 1 ms, and their countdowns agreed, where one built on `Date.now()` would have run 2.5 s long. An answer whose connection was dropped right after it was sent went out twice, was recorded once, and got the same reply both times. A player taken offline mid-question showed as away on the host 12.3 s later, though the server never saw the connection close. Back online, that phone had the current question 3 ms later, with a countdown that matched the host's. A reloaded host showed both players as here within 500 ms.

## Testing it

Skew the server's clock, `const now = () => Date.now() + 2500`, to see that every countdown still agrees. To drop a phone's connection right after it answers, call `party.reconnect()` just after `answer()`: the server's log shows the second copy arriving. Chrome's DevTools can take one browser profile offline to play a phone that sleeps. To test a flaky connection for longer, wrap the socket in [`react-websocket/chaos`](../guide/chaos.md).

## See also

- [Real-time games](../guide/games.md): requests, ping and server time, and rejoining
- [Presence and live cursors](../guide/presence.md) and [`createWebSocketPresence`](../api/create-websocket-presence.md)
- [`createWebSocketLatency`](../api/create-websocket-latency.md) and [`createWebSocketRequests`](../api/create-websocket-requests.md)
- [Build a real-time action game](./action-game.md): prediction, interpolation and a 60 fps canvas
