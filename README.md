# react-websocket [![contributions welcome](https://img.shields.io/badge/contributions-welcome-brightgreen.svg?style=flat)](https://github.com/mehmetkose/react-websocket/edit/master/README.md)

`react-websocket` is a simple to use component for ReactJS applications to setup websocket communication.

The component renders an empty element in the DOM.
When mounting the component, a websocket connection is opened.
The connection will be closed when the component will be unmounted.

### Installing

```
npm install --save react-websocket
```

### Usage

```js
  import React from 'react';
  import Websocket from 'react-websocket';

  class ProductDetail extends React.Component {

    constructor(props) {
      super(props);
      this.state = {
        count: 90
      };
    }

    handleData(data) {
      let result = JSON.parse(data);
      this.setState({count: this.state.count + result.movement});
    }

    render() {
      return (
        <div>
          Count: <strong>{this.state.count}</strong>

          <Websocket url='ws://localhost:8888/live/product/12345/'
              onMessage={this.handleData.bind(this)}/>
        </div>
      );
    }
  }

  export default ProductDetail;
```

### Properties

#### url

**required**
The url the websocket connection is listening to.

#### onMessage

**required**
The callback called when data is received. Data is `JSON.parse`'d

#### onOpen

The callback called when the connection is successfully opened.

#### onClose

The callback called when the connection is closed either due to server disconnect or network error.

#### debug

default: **false**
Set to **true** to see console logging

#### reconnect

default: **true**

accelerated reconnection time
