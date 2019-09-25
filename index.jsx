import React from 'react';
import PropTypes from 'prop-types';

class Websocket extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      ws: window.WebSocket
        ? new window.WebSocket(this.props.url, this.props.protocol)
        : new window.MozWebSocket(this.props.url, this.props.protocol),
      attempts: 1
    };
    this.sendMessage = this.sendMessage.bind(this);
    this.setupWebsocket = this.setupWebsocket.bind(this);
  }

  logging(logline) {
    if (this.props.debug === true) {
      console.log(logline);
    }
  }

  generateInterval(k) {
    if (this.props.reconnectIntervalInMilliSeconds > 0) {
      return this.props.reconnectIntervalInMilliSeconds;
    }
    return Math.min(30, Math.pow(2, k) - 1) * 1000;
  }

  setupWebsocket() {
    let websocket = this.state.ws;

    websocket.onopen = () => {
      this.logging('Websocket connected');
      if (typeof this.props.onOpen === 'function') this.props.onOpen();
    };

    websocket.onerror = e => {
      if (typeof this.props.onError === 'function') this.props.onError(e);
    };

    websocket.onmessage = evt => {
      this.props.onMessage(evt.data);
    };

    this.shouldReconnect = this.props.reconnect;
    websocket.onclose = evt => {
      this.logging(
        `Websocket disconnected,the reason: ${evt.reason},the code: ${evt.code}`
      );
      if (typeof this.props.onClose === 'function')
        this.props.onClose(evt.code, evt.reason);
      if (this.shouldReconnect) {
        let time = this.generateInterval(this.state.attempts);
        this.timeoutID = setTimeout(() => {
          this.setState({ attempts: this.state.attempts + 1 });
          this.setState({
            ws: window.WebSocket
              ? new window.WebSocket(this.props.url, this.props.protocol)
              : new window.MozWebSocket(this.props.url, this.props.protocol)
          });
          this.setupWebsocket();
        }, time);
      }
    };
  }

  componentDidMount() {
    this.setupWebsocket();
  }

  componentWillUnmount() {
    this.shouldReconnect = false;
    clearTimeout(this.timeoutID);
    let websocket = this.state.ws;
    websocket.close();
  }

  sendMessage(message) {
    let websocket = this.state.ws;
    websocket.send(message);
  }

  render() {
    return <div></div>;
  }
}

Websocket.defaultProps = {
  debug: false,
  reconnect: true
};

Websocket.propTypes = {
  url: PropTypes.string.isRequired,
  onMessage: PropTypes.func.isRequired,
  onOpen: PropTypes.func,
  onClose: PropTypes.func,
  onError: PropTypes.func,
  debug: PropTypes.bool,
  reconnect: PropTypes.bool,
  protocol: PropTypes.string,
  reconnectIntervalInMilliSeconds: PropTypes.number
};

export default Websocket;
