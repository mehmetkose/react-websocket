import { routes } from '../routes.ts';
import { Document } from './document.tsx';

export function AboutPage() {
  return () => (
    <Document title="About the react-websocket Remix demo" current={routes.about.href()}>
      <article class="prose">
        <h2>The connection survived the navigation</h2>
        <p>
          The name next to the status above didn’t change: the server names every connection, so a
          new socket would have come back with a new name. Once the browser entry calls{' '}
          <code>run()</code>, Remix turns same-origin links into in-place navigations: it fetches
          the next page’s HTML and updates the document, so the JavaScript stays loaded, and the
          shared client with it. The status badge is in the header of both pages, so it stays
          mounted and holds the connection while the demo’s cards leave. Go{' '}
          <a href={routes.home.href()}>back to the demo</a> and the cards hydrate onto the same
          socket.
        </p>
        <p>
          A full page load, like the browser’s reload button, starts a new document and a new
          connection.
        </p>

        <h2>No React</h2>
        <p>
          Remix 3 components aren’t React components: a component’s setup function runs once and
          returns a render function, and it calls <code>handle.update()</code> to render again. So
          the hooks don’t apply, but <code>react-websocket/core</code> does. It has the client and
          every manager (topics, state, requests, latency and the responder), with no React
          dependency. Each hook is a small wrapper that subscribes to one of them, and{' '}
          <code>app/live/public/bindings.ts</code> has the same wrappers for Remix components.
        </p>

        <h2>Where the WebSocket server runs</h2>
        <p>
          The Remix router turns requests into responses, and a WebSocket upgrade isn’t one. So{' '}
          <code>server.ts</code> passes requests to the router and handles upgrades on the Node
          server underneath, on the same port. <code>/api/token</code> is an ordinary route: it
          issues the short-lived token the WebSocket URL carries, and the client fetches a fresh one
          before every connection attempt.
        </p>
      </article>
    </Document>
  );
}
