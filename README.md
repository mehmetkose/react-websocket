# react-websocket [![contributions welcome](https://img.shields.io/badge/contributions-welcome-brightgreen.svg?style=flat)](https://github.com/mehmetkose/react-websocket/edit/master/README.md)

`react-websocket` is a simple to use component for ReactJS applications to setup websocket communication.

** Stability: 2 - Unstable **

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

default: **true**

accelerated reconnection time