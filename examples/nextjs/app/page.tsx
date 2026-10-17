// A Server Component: it renders the cards on the server, and each client component inside
// connects after hydration. View the page source to see them rendered as `idle`.
import { Suspense } from 'react';
import { Agent } from '@/components/agent';
import { Card } from '@/components/card';
import { Chat } from '@/components/chat';
import { Connection, FirstConnection } from '@/components/connection';
import { Cursors } from '@/components/cursors';
import { Latency } from '@/components/latency';
import { Prices } from '@/components/prices';
import { Requests } from '@/components/requests';
import { StatusBadge } from '@/components/status-badge';

export default function Page() {
  return (
    <main>
      <header>
        <h1>
          react-websocket <StatusBadge />
        </h1>
        <p className="muted">
          Every feature on one shared connection. Open a second tab to see the chat and cursors from
          both sides. The code for each card is in <code>components/</code>.
        </p>
      </header>

      <div className="grid">
        <Card
          title="Connection"
          uses={[
            'useWebSocket',
            'useWebSocketEvent',
            'reconnect',
            'heartbeat',
            'schema',
            'url()',
            'Suspense'
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
          <Suspense fallback={<p className="muted">Waiting for the first connection…</p>}>
            <FirstConnection />
          </Suspense>
        </Card>

        <Card
          title="AI agent: server requests"
          uses={['createWebSocketResponder', 'useAgentApproval']}
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
          uses={['send()', 'queue', 'useWebSocketEvent']}
          tryIt={
            <>close the connection, send a few messages, then reconnect. They go out in order.</>
          }
        >
          <Chat />
        </Card>

        <Card
          title="Prices: topics and state"
          uses={[
            'createWebSocketTopics',
            'useWebSocketTopic',
            'createWebSocketState',
            'useWebSocketState'
          ]}
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
          uses={['send(m, { volatile })', 'send(m, { key })', 'useWebSocketState']}
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
          uses={['createWebSocketLatency', 'useWebSocketLatency', 'serverNow()']}
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
    </main>
  );
}
