import { clientEntry, on, type Handle } from 'remix/component';
import { rpc } from '../../live/public/live.ts';
import type { RpcMethod } from '../../live/public/protocol.ts';

const describe = (error: unknown) =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

export const Requests = clientEntry(import.meta.url, function Requests(handle: Handle) {
  let results: { id: number; text: string }[] = [];
  let nextId = 0;
  let abort = new AbortController();
  const add = (text: string) => {
    results = [{ id: ++nextId, text }, ...results].slice(0, 6);
    void handle.update();
  };

  async function request(method: RpcMethod) {
    const started = performance.now();
    try {
      // Resolves with the reply that carries this request's id, or rejects: on timeout (2 s),
      // an error reply, abort, or when the connection it went out on closes. Leaving the page
      // removes this component, which aborts `handle.signal` too.
      const signal = AbortSignal.any([abort.signal, handle.signal]);
      const reply = await rpc.request(method, { signal });
      const ms = Math.round(performance.now() - started);
      add(`${method} → ${reply.type === 'reply' ? reply.value : '?'} (${ms} ms)`);
    } catch (error) {
      if (!handle.signal.aborted) add(`${method} → ${describe(error)}`);
    }
  }

  function cancel() {
    abort.abort(new DOMException('Cancelled by you', 'AbortError'));
    abort = new AbortController();
  }

  return () => (
    <>
      <div class="row">
        <button type="button" mix={on('click', () => request('roll'))}>
          Roll a die
        </button>
        <button type="button" mix={on('click', () => request('fail'))}>
          Get an error
        </button>
        <button type="button" mix={on('click', () => request('slow'))}>
          Wait too long
        </button>
        <button type="button" mix={on('click', cancel)}>
          Cancel pending
        </button>
      </div>
      <ol class="log">
        {results.map(result => (
          <li key={result.id}>{result.text}</li>
        ))}
      </ol>
    </>
  );
});
