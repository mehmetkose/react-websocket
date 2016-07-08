import React from 'react';
import Websocket from '../index.jsx';

class App extends React.Component {  

  handleData(data) {
    console.log(data);
  }
  render() {
    return (
      <Websocket url='ws://localhost:8888/' onMessage={this.handleData} 
              reconnect={true} debug={true}/>
    );
  }
}

export default App;
