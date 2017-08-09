import React from 'react';
import Websocket from '../index.jsx';

class App extends React.Component {

  handleData(data) {
    alert(data);
  }
  handleOpen()  {
    alert("connected:)");
  }
  handleClose() {
    alert("disconnected:(");
  }
  render() {
    return (
      <Websocket url='ws://localhost:8888/live' onMessage={this.handleData}
              onOpen={this.handleOpen} onClose={this.handleClose}
              reconnect={true} debug={true}/>
    );
  }
}

export default App;
