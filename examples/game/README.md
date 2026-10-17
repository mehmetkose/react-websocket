# react-websocket game example

A small multiplayer game: dots in an arena, a Node.js WebSocket server that runs the game at 20 ticks a second, and a Vite + React 19 client that draws it at 60 fps with [`react-websocket/timeline`](https://mehmetkose.github.io/react-websocket/api/create-websocket-timeline). A panel makes the network worse with [`react-websocket/chaos`](https://mehmetkose.github.io/react-websocket/guide/chaos), so you can see what interpolation and prediction do.

```sh
# From the repository root: build the library, install it here, and start both servers.
npm run example:game
```

Then open http://localhost:5180 and move with the arrow keys or WASD.

## What to try

1. **Open a second tab** and move in each. Three bots circle the arena too, so one tab already shows other players moving.
2. **Pick "Bad"** (100–300 ms each way). Your dot still moves the moment you press a key: that's prediction. The other tab's dot moves smoothly but behind: that's interpolation, rendered about 100 ms in the past. The dashed ring is where the server has you; prediction runs ahead of it by about one round trip.
3. **Turn off "Predict my moves"**. Now every key press waits for the round trip and the render delay. That's what prediction saves.
4. **Turn off "Interpolate others"**. Other dots jump 20 times a second, unevenly on a bad network.
5. **Turn on "Lose 5% of my inputs"**. The server never applies the lost ones, so your dot snaps back a little when its confirmations skip past them. That's reconciliation correcting a misprediction.
6. **Drop the connection**, or **stall** it (the heartbeat notices after three silent seconds). The last frame stays on screen while it reconnects, then the game resumes from a fresh snapshot.
7. **Set the delay to 0**. Other dots stutter, because there's rarely a newer snapshot to blend toward. "Buffered ahead" under the arena turns red when the render time runs out of snapshots. "Automatic delay" renders just far enough behind for the jitter it measures.

## Files

```
server.ts          The game server: applies inputs in order on a fixed tick, sends each player a snapshot
src/sim.ts         The rules, shared by the server and the client: move(), lerpWorld(), the bots
src/protocol.ts    The messages, shared by the server and the client
src/net.ts         The client, latency, the timeline, the roster store and the chaos class
src/Canvas.tsx     The render loop: samples the keys, sends inputs, draws at() and predicted()
src/Hud.tsx        Status, ping, the last confirmed input and the player list
src/DevPanel.tsx   Network faults and rendering switches
vite.config.ts     Forwards /ws to the game server in development
```

## What the server sends

The timeline needs three things from a server, and `server.ts` shows all of them:

- **A `time` on every snapshot**, from a clock that never goes backward (`performance.timeOrigin + performance.now()`). Pongs use the same clock, so `createWebSocketLatency` and the timeline agree.
- **An `ack` for each player**: the last input `seq` the server applied from that player. Each player gets their own snapshot, with `you` set to their id.
- **Inputs applied in `seq` order** with the same `move()` the client predicts with, on a fixed tick. A burst of inputs that arrives at once is spread over the next ticks, so nobody moves faster than real time.

The client sends one input per frame while a key is held, carrying how many 60 Hz steps it covers, so the game moves at the same speed on a 60 Hz or a 120 Hz display.

This server is for development only. It has no rooms, authentication or rate limiting, and players don't collide: collisions between players need lag compensation on the server, which is out of scope here.
