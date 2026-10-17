#!/usr/bin/env python
#-*- coding:utf-8 -*-

import asyncio, logging
import tornado.httpserver
import tornado.options
import tornado.web
import tornado.websocket

tornado.options.define("port", default=8888, help="port to listen on")

class Application(tornado.web.Application):

    def __init__(self):
        # The page itself is served by Vite (`npm run example:tornado`).
        tornado.web.Application.__init__(self, [
            tornado.web.url(r"/live", WebSocketHandler, name="websocket"),
        ], debug=True)

class WebSocketHandler(tornado.websocket.WebSocketHandler):
    listenners = []

    def check_origin(self, origin):
        return True

    def open(self):
        WebSocketHandler.listenners.append(self)

    def on_close(self):
        if self in WebSocketHandler.listenners:
            WebSocketHandler.listenners.remove(self)

    def on_message(self, wsdata):
        for listenner in WebSocketHandler.listenners:
            listenner.write_message(wsdata)


async def main():
    tornado.options.parse_command_line()
    http_server = tornado.httpserver.HTTPServer(Application())
    port = tornado.options.options.port
    http_server.listen(port)
    logging.info("websocket server running on ws://localhost:%d/live", port)
    await asyncio.Event().wait()

if __name__ == "__main__":
    asyncio.run(main())
