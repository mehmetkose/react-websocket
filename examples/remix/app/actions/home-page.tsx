// Rendered on the server. Each component from app/ui/public/ is a client entry: it hydrates on
// its own and joins the shared connection. Everything else on the page stays static HTML.
import { routes } from '../routes.ts';
import { Card } from '../ui/card.tsx';
import { Agent } from '../ui/public/agent.tsx';
import { Chat } from '../ui/public/chat.tsx';
import { Connection, FirstConnection } from '../ui/public/connection.tsx';
import { Cursors } from '../ui/public/cursors.tsx';
import { Latency } from '../ui/public/latency.tsx';
import { Prices } from '../ui/public/prices.tsx';
import { Requests } from '../ui/public/requests.tsx';
import { Document } from './document.tsx';

export function HomePage() {
  return () => (
    <Document title="react-websocket Remix demo" current={routes.home.href()}>
      <p class="muted">
        Every feature on one shared connection, in a Remix 3 app with no React. Each card is a
        client entry that hydrates on its own, and all of them use the same client from{' '}
        <code>react-websocket/core</code>. Open a second tab to see the chat and cursors from both
        sides. The code for each card is in <code>app/ui/public/</code>.
      </p>

      <div class="grid">
        <Card
          title="Connection"
          uses={[
            'acquire()',
            'subscribe()',
            'getSnapshot()',
            'on()',
            'reconnect',
            'heartbeat',
            'schema',
            'url()',
            'ready'
          ]}
          tryIt={
            <>
              drop the connection and watch the backoff, go silent until the heartbeat gives up, or
              get refused (close code 4003, which <code>shouldReconnect</code> doesn’t retry). Bad
              data is reported as a <code>MessageError</code>.
            </>
          }
        >
          <Connection />
          <FirstConnection />
        </Card>

        <Card
          title="AI agent: server requests"
          uses={['createWebSocketResponder', 'onRequest()', 'getSnapshot()']}
          tryIt={
            <>
              select some text on this page, then ask the agent to email it. It reads the selection
              and your time zone through handlers, then waits for your approval. Stop the run to see
              the server cancel its request.
            </>
          }
        >
          <Agent />
        </Card>

        <Card
          title="Chat: the send queue"
          uses={['send()', 'queue', 'on()']}
          tryIt={
            <>close the connection, send a few messages, then reconnect. They go out in order.</>
          }
        >
          <Chat />
        </Card>

        <Card
          title="Prices: topics and state"
          uses={['createWebSocketTopics', 'acquire(topic)', 'createWebSocketState']}
          tryIt={
            <>
              toggle symbols to subscribe and unsubscribe, then drop the connection: the feed
              resumes on its own.
            </>
          }
        >
          <Prices />
        </Card>

        <Card
          title="Cursors: volatile and keyed sends"
          uses={['send(m, { volatile })', 'send(m, { key })', 'createWebSocketState']}
          tryIt={
            <>
              close the connection, move the pointer and pick a few colors, then reconnect. Only the
              last color is sent.
            </>
          }
        >
          <Cursors />
        </Card>

        <Card
          title="Requests"
          uses={['createWebSocketRequests', 'request()', 'AbortSignal']}
          tryIt={
            <>
              the slow request outlasts its 2 s timeout. Close the connection while one is pending:
              it rejects.
            </>
          }
        >
          <Requests />
        </Card>

        <Card
          title="Latency and server time"
          uses={['createWebSocketLatency', 'serverNow()']}
          tryIt={
            <>
              the demo server’s clock runs 2.5 s fast on purpose. The offset is measured from the
              pings.
            </>
          }
        >
          <Latency />
        </Card>
      </div>
    </Document>
  );
}
