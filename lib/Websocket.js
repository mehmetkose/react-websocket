'use strict';

var React = require('react');
var WebSocket = require('ws');

module.exports = React.createClass({

    propTypes: {
        url: React.PropTypes.string.isRequired,
        onMessage: React.PropTypes.func.isRequired,
        debug: React.PropTypes.bool,
        reconnect: React.PropTypes.number
    },

    getDefaultProps: function () {
        return {
            debug: false
        }
    },

    getInitialState: function () {
        return {
            ws: new WebSocket(this.props.url)
        }
    },

    log: function (logline) {
        if (this.props.debug === true) {
            console.log(logline);
        }
    },

    _setupSocket: function () {
        var self = this;
        var ws = self.state.ws;
        ws.addEventListener('open', function open() {
            self.log('Websocket connected');
        });
        ws.addEventListener('message', function incoming(event) {
            var data = JSON.parse(event.data);
            self.log('Websocket incoming data');
            self.log(event.data);
            self.props.onMessage(data);
        });
        ws.addEventListener('close', function close() {
            self.log('Websocket disconnected');
            if (self.props.reconnect && !self.preventReconnection) {
                var restartDelay = Math.random()*self.props.reconnect;
                setTimeout(function later() {
                    self.state.ws.close();
                    self.log("Websocket reconnecting");
                    self.setState(self.getInitialState());
                    self._setupSocket();
                }, restartDelay*1000);
            }
        });
    },

    componentWillMount: function () {
        this.log('Websocket componentWillMount');
        this.preventReconnection = false;
        this._setupSocket();
    },

    componentWillUnmount: function () {
        this.log('Websocket componentWillUnmount');
        // we need to prevent reconnection! or we'll set state on an unmounted component
        this.preventReconnection = true;
        this.state.ws.close();
    },

    render: function () {
        return React.createElement("div", React.__spread({}, this.props))
    }
});
