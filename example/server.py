#!/usr/bin/env python
#-*- coding:utf-8 -*-

import logging, os.path, time, copy, json, random, string
import tornado.httpserver
import tornado.ioloop
import tornado.options
import tornado.web
import tornado.websocket
import tornado.gen
import tornado.escape


class Application(tornado.web.Application):

    def __init__(self):
        app_settings = {
            "debug": False,
        }
        tornado.web.Application.__init__(self, [
            tornado.web.url(r"/", WebSocketHandler, name="websocket"),
        ], **app_settings)


class WebSocketHandler(tornado.websocket.WebSocketHandler):
    listenners = []
    
    def check_origin(self, origin):
        return True

    @tornado.gen.engine
    def open(self):
        WebSocketHandler.listenners.append(self)

    def on_close(self):
        if self in WebSocketHandler.listenners:
            WebSocketHandler.listenners.remove(self)

    @tornado.gen.engine
    def on_message(self, wsdata):
        for listenner in WebSocketHandler.listenners:
            listenner.write_message(wsdata)


@tornado.gen.coroutine
def main():
    tornado.options.parse_command_line()
    http_server = tornado.httpserver.HTTPServer(Application())
    http_server.listen(8888)
    logging.info("application running on http://localhost:8888")

if __name__ == "__main__":
    tornado.ioloop.IOLoop.current().run_sync(main)
    tornado.ioloop.IOLoop.current().start()
