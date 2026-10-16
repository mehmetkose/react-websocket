# react-websocket example

A small broadcast chat: a [Tornado](https://www.tornadoweb.org/) WebSocket server plus a Vite + React 19 client.

```sh
# 1. WebSocket server on ws://localhost:8888/live
pip install -r example/requirements.txt
npm run example:server

# 2. Client on http://localhost:5173
npm run example
```

Open it in two tabs and send messages. Stop the server to watch the client go to
`reconnecting`; messages you send meanwhile are queued and delivered once it's back.
