import type { Handle, RemixNode } from 'remix/component';

/**
 * A demo section: what it shows, the APIs it uses, and something to try. Not a client entry, so
 * it only renders on the server; the client entries inside it hydrate.
 */
export function Card(
  handle: Handle<{ title: string; uses: string[]; tryIt: RemixNode; children?: RemixNode }>
) {
  return () => {
    const { title, uses, tryIt, children } = handle.props;
    return (
      <section class="card">
        <h2>{title}</h2>
        <p class="uses">
          {uses.map(name => (
            <code key={name}>{name}</code>
          ))}
        </p>
        {children}
        <p class="try">
          <strong>Try it:</strong> {tryIt}
        </p>
      </section>
    );
  };
}
