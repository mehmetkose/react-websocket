'use strict';

Object.defineProperty(exports, "__esModule", {
    value: true
});
exports.Websocket = undefined;

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

var _react = require('react');

var _react2 = _interopRequireDefault(_react);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

function _possibleConstructorReturn(self, call) { if (!self) { throw new ReferenceError("this hasn't been initialised - super() hasn't been called"); } return call && (typeof call === "object" || typeof call === "function") ? call : self; }

function _inherits(subClass, superClass) { if (typeof superClass !== "function" && superClass !== null) { throw new TypeError("Super expression must either be null or a function, not " + typeof superClass); } subClass.prototype = Object.create(superClass && superClass.prototype, { constructor: { value: subClass, enumerable: false, writable: true, configurable: true } }); if (superClass) Object.setPrototypeOf ? Object.setPrototypeOf(subClass, superClass) : subClass.__proto__ = superClass; }
// import React from 'react';

// class Websocket extends React.Component {

//   render() {
//     return (
//       <div {... props}>ccc</div>
//     );
//   }

// }

// export default Websocket;

var Websocket = exports.Websocket = function (_React$Component) {
    _inherits(Websocket, _React$Component);

    function Websocket(props) {
        _classCallCheck(this, Websocket);

        var _this = _possibleConstructorReturn(this, Object.getPrototypeOf(Websocket).call(this, props));

        _this.state = {
            ws: new WebSocket(_this.props.url),
            partial: ''
        };
        return _this;
    }

    _createClass(Websocket, [{
        key: '_setupSocket',
        value: function _setupSocket() {
            var self = this;
            var ws = self.state.ws;
            var partial = self.state.partial;
            ws.addEventListener('onopen', function open() {
                self.log('Websocket connected');
            });
            ws.addEventListener('onmessage', function incoming(event) {
                try {
                    var data = JSON.parse(partial + event.data);
                    self.log('Websocket incoming data');
                    self.log(partial + event.data);
                    partial = '';
                    self.setState({ partial: partial });
                    self.props.onMessage(data);
                } catch (err) {
                    partial += event.data;
                    self.log('Websocket storing partial');
                    self.setState({ partial: partial });
                }
            });
            ws.addEventListener('onclose', function close() {
                self.log('Websocket disconnected');
                if (self.props.reconnect && !self.preventReconnection) {
                    var restartDelay = Math.random() * self.props.reconnect;
                    setTimeout(function later() {
                        self.state.ws.close();
                        self.log("Websocket reconnecting");
                        self.setState(self.getInitialState());
                        self._setupSocket();
                    }, restartDelay * 1000);
                }
            });
        }
    }, {
        key: 'componentWillMount',
        value: function componentWillMount() {
            this.preventReconnection = false;
            this._setupSocket();
        }
    }, {
        key: 'componentWillUnmount',
        value: function componentWillUnmount() {
            this.preventReconnection = true;
            this.state.ws.close();
        }
    }, {
        key: 'render',
        value: function render() {
            return _react2.default.createElement('div', this.props);
        }
    }]);

    return Websocket;
}(_react2.default.Component);

Websocket.propTypes = {
    url: _react2.default.PropTypes.string.isRequired,
    onMessage: _react2.default.PropTypes.func.isRequired,
    debug: _react2.default.PropTypes.bool,
    reconnect: _react2.default.PropTypes.number
};

exports.default = Websocket;