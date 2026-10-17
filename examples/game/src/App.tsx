import { Canvas } from './Canvas';
import { DevPanel } from './DevPanel';
import { Hud } from './Hud';

export default function App() {
  return (
    <main>
      <p className="muted">
        Move with the arrow keys or WASD, and aim with the mouse. Open a second tab to play against
        yourself, then make the network worse below.
      </p>
      <Hud />
      <Canvas />
      <DevPanel />
    </main>
  );
}
