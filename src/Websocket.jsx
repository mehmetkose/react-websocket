import React from 'react';
import Websocket from 'ws';

export class WebsocketComponent extends React.Component {
  
    constructor(props) {
        super(props);
        this.state = {
          ws: new WebSocket(this.props.url),
          partial: ''
        };
    }

    log(logline) {
      if (this.props.debug === true) {
            console.log(logline);
      }
    }

    _setupSocket() {
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
    }

    componentWillMount() {
        this.preventReconnection = false;
        this._setupSocket();
    }

    componentWillUnmount() {
        this.preventReconnection = true;
        this.state.ws.close();
    }
  
    render() {
        return (<div { ...this.props } />);
    }

}

WebsocketComponent.propTypes = {
    url: React.PropTypes.string.isRequired,
    onMessage: React.PropTypes.func.isRequired,
    debug: React.PropTypes.bool,
    reconnect: React.PropTypes.number
};

export default WebsocketComponent;

