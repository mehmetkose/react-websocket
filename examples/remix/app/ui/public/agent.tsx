import { clientEntry, on, type Handle } from 'remix/component';
import { listen, watchRequests } from '../../live/public/bindings.ts';
import { live, tools } from '../../live/public/live.ts';

let lineId = 0;

export const Agent = clientEntry(import.meta.url, function Agent(handle: Handle) {
  let lines: { id: number; text: string }[] = [];
  listen(handle, live, 'message', message => {
    if (message.type !== 'agent') return;
    lines = [...lines, { id: ++lineId, text: message.text }].slice(-10);
    void handle.update();
  });

  // Volatile: starting a run is only meaningful now, so don't queue it while offline.
  const run = (task: 'email' | 'file' | 'stop') => {
    live.send({ type: 'agent', task }, { volatile: true });
  };

  return () => (
    <>
      <div class="row">
        <button type="button" mix={on('click', () => run('email'))}>
          Email my selection
        </button>
        <button type="button" mix={on('click', () => run('file'))}>
          Read a file
        </button>
        <button type="button" mix={on('click', () => run('stop'))}>
          Stop the run
        </button>
      </div>
      <Approval />
      <FilePrompt />
      <ol class="log">
        {lines.map(line => (
          <li key={line.id}>{line.text}</li>
        ))}
      </ol>
    </>
  );
});

/**
 * 'approve' has no handler, so its requests wait here for a person. The dialog disappears on
 * its own when the request is answered, times out (30 s, set by the server), or is cancelled.
 */
function Approval(handle: Handle) {
  const requests = watchRequests(handle, tools, 'approve');
  return () => {
    const [request] = requests();
    if (!request) return null;
    return (
      <div class="prompt" role="dialog" aria-label="The agent asks">
        <p>{request.params.summary}</p>
        <div class="row">
          <button
            type="button"
            class="primary"
            mix={on('click', () => {
              request.respond({ approved: true });
            })}
          >
            Approve
          </button>
          <button
            type="button"
            mix={on('click', () => {
              request.respond({ approved: false });
            })}
          >
            Deny
          </button>
        </div>
      </div>
    );
  };
}

/** Browsers only open the file picker on a click, so a handler can't do it: a person answers. */
function FilePrompt(handle: Handle) {
  const requests = watchRequests(handle, tools, 'pick_file');
  return () => {
    const [request] = requests();
    if (!request) return null;
    return (
      <div class="prompt" role="dialog" aria-label="The agent asks for a file">
        <p>{request.params.reason}</p>
        <div class="row">
          <input
            type="file"
            accept=".txt,.md,.json,.csv,text/*"
            mix={on('change', async event => {
              const file = event.currentTarget.files?.[0];
              if (!file) return;
              const text = await file.text();
              // Returns `false` if the run was stopped while the file was being read.
              request.respond({ name: file.name, size: file.size, lines: text.split('\n').length });
            })}
          />
          <button
            type="button"
            mix={on('click', () => {
              request.reject(new Error('The user declined'));
            })}
          >
            Decline
          </button>
        </div>
      </div>
    );
  };
}
