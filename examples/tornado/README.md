# react-websocket Tornado example

A small broadcast chat: a [Tornado](https://www.tornadoweb.org/) WebSocket server plus a Vite + React 19 client.

```sh
# 1. WebSocket server on ws://localhost:8888/live
pip install -r examples/tornado/requirements.txt
npm run example:tornado:server

# 2. Client on http://localhost:5173
npm run example:tornado
```

Open it in two tabs and send messages. Stop the server to watch the client go to
`reconnecting`; messages you send meanwhile are queued and delivered once it's back.
