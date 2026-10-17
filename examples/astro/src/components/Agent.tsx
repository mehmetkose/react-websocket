import { useState, type ChangeEvent } from 'react';
import { useAgentApproval, useWebSocketEvent } from 'react-websocket';
import { live, tools } from '../lib/live';

let lineId = 0;

export function Agent() {
  const [lines, setLines] = useState<{ id: number; text: string }[]>([]);
  useWebSocketEvent(live, 'message', message => {
    if (message.type !== 'agent') return;
    const line = { id: ++lineId, text: message.text };
    setLines(list => [...list, line].slice(-10));
  });

  // Volatile: starting a run is only meaningful now, so don't queue it while offline.
  const run = (task: 'email' | 'file' | 'stop') =>
    live.send({ type: 'agent', task }, { volatile: true });

  return (
    <>
      <div className="row">
        <button onClick={() => run('email')}>Email my selection</button>
        <button onClick={() => run('file')}>Read a file</button>
        <button onClick={() => run('stop')}>Stop the run</button>
      </div>
      <Approval />
      <FilePrompt />
      <ol className="log">
        {lines.map(line => (
          <li key={line.id}>{line.text}</li>
        ))}
      </ol>
    </>
  );
}

/**
 * 'approve' has no handler, so its requests wait here for a person. The dialog disappears on
 * its own when the request is answered, times out (30 s, set by the server), or is cancelled.
 */
function Approval() {
  const [request] = useAgentApproval(tools, 'approve');
  if (!request) return null;
  return (
    <div className="prompt" role="dialog" aria-label="The agent asks">
      <p>{request.params.summary}</p>
      <div className="row">
        <button className="primary" onClick={() => request.respond({ approved: true })}>
          Approve
        </button>
        <button onClick={() => request.respond({ approved: false })}>Deny</button>
      </div>
    </div>
  );
}

/** Browsers only open the file picker on a click, so a handler can't do it: a person answers. */
function FilePrompt() {
  const [request] = useAgentApproval(tools, 'pick_file');
  if (!request) return null;

  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    // Returns `false` if the run was stopped while the file was being read.
    request.respond({ name: file.name, size: file.size, lines: text.split('\n').length });
  };

  return (
    <div className="prompt" role="dialog" aria-label="The agent asks for a file">
      <p>{request.params.reason}</p>
      <div className="row">
        <input type="file" accept=".txt,.md,.json,.csv,text/*" onChange={choose} />
        <button onClick={() => request.reject(new Error('The user declined'))}>Decline</button>
      </div>
    </div>
  );
}
