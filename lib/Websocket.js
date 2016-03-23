'use strict';

var React = require('react');
var WebSocket = require('ws');

module.exports = React.createClass({

    propTypes: {
        url: React.PropTypes.string.isRequired,
        onMessage: React.PropTypes.func.isRequired,
        debug: React.PropTypes.bool
    },

    getDefaultProps: function () {
        return {
            debug: false
        }
    },

    getInitialState: function () {
        return {
            ws: new WebSocket(this.props.url),
            partial: ''
        }
    },

    log: function (logline) {
        if (this.props.debug === true) {
            console.log(logline);
        }
    },

    componentWillMount: function () {
        this.log('Websocket componentWillMount');
        var self = this;
        var ws = self.state.ws;
        var partial = self.state.partial;
        ws.addEventListener('open', function open() {
            self.log('Websocket connected');
        });
        ws.addEventListener('message', function incoming(event) {
            try {
                var data = JSON.parse(partial + event.data);
                self.log('Websocket incoming data');
                self.log(partial + event.data);
                partial = '';
                self.setState({partial:partial});
                self.props.onMessage(data);
            } catch (err) {
                partial += event.data;
                self.log('Websocket storing partial');
                self.setState({partial:partial});
            }
        });
        ws.addEventListener('close', function close() {
            self.log('Websocket disconnected');
        });
    },

    componentWillUnmount: function () {
        this.log('Websocket componentWillUnmount');
        this.state.ws.close();
    },

    render: function () {
        return React.createElement("div", React.__spread({}, this.props))
    }
});
