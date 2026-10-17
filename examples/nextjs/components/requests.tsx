'use client';

import { useRef, useState } from 'react';
import { rpc } from '@/lib/live';
import type { RpcMethod } from '@/lib/protocol';

const describe = (error: unknown) =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

export function Requests() {
  const [results, setResults] = useState<{ id: number; text: string }[]>([]);
  const abort = useRef(new AbortController());
  const nextId = useRef(0);
  const add = (text: string) => {
    const entry = { id: ++nextId.current, text };
    setResults(list => [entry, ...list].slice(0, 6));
  };

  async function request(method: RpcMethod) {
    const started = performance.now();
    try {
      // Resolves with the reply that carries this request's id, or rejects: on timeout (2 s),
      // an error reply, abort, or when the connection it went out on closes.
      const reply = await rpc.request(method, { signal: abort.current.signal });
      const ms = Math.round(performance.now() - started);
      add(`${method} → ${reply.type === 'reply' ? reply.value : '?'} (${ms} ms)`);
    } catch (error) {
      add(`${method} → ${describe(error)}`);
    }
  }

  function cancel() {
    abort.current.abort(new DOMException('Cancelled by you', 'AbortError'));
    abort.current = new AbortController();
  }

  return (
    <>
      <div className="row">
        <button onClick={() => request('roll')}>Roll a die</button>
        <button onClick={() => request('fail')}>Get an error</button>
        <button onClick={() => request('slow')}>Wait too long</button>
        <button onClick={cancel}>Cancel pending</button>
      </div>
      <ol className="log">
        {results.map(result => (
          <li key={result.id}>{result.text}</li>
        ))}
      </ol>
    </>
  );
}
