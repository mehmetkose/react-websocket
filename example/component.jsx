import React from 'react';
import Websocket from '../index.jsx';

class App extends React.Component {

  handleData(data) {
    alert(data);
  }
  render() {
    return (
      <Websocket url='ws://localhost:8888/live' onMessage={this.handleData}
              reconnect={true} debug={true}/>
    );
  }
}

export default App;
