# react-websocket: a reactjs websocket component

`react-websocket` is a simple to use component for ReactJS applications to setup websocket communication.
It basically is a very simple wrapper for `ws`. See https://github.com/websockets/ws

The component renders an empty <div> element in the DOM.
When mounting the component, a websocket connection is opened.
The connection will be closed when the component will be unmounted.

### Installing

```
npm install --save react-websocket
```

### Usage

```js
  var React = require('react');
  var Websocket = require('react-websocket');

  var Example = React.createClass({
  
    handleData: function(data) {
       // do something with the data
       this.setState({
          foo: bar
       });
    },
    
    render: function() {
      <Websocket url='ws://localhost:3000/messages'
                 onMessage={this.handleData}/>
    }
  });
```

### Properties

#### url

**required**
The url the websocket connection is listening to.

#### onMessage

**required**
The callback called when data is received. Data is `JSON.parse`'d

#### debug

default: **false**
Set to **true** to see console logging

#### reconnect

**optional**
If set to a number `n` of seconds, will try to re-establish the connection after a random `[0..n]`
 seconds delay until successful. If unset, there will be no automatic reconnection.