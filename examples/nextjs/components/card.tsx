import type { ReactNode } from 'react';

/** A demo section: what it shows, the APIs it uses, and something to try. */
export function Card(props: {
  title: string;
  uses: string[];
  tryIt: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card">
      <h2>{props.title}</h2>
      <p className="uses">
        {props.uses.map(name => (
          <code key={name}>{name}</code>
        ))}
      </p>
      {props.children}
      <p className="try">
        <strong>Try it:</strong> {props.tryIt}
      </p>
    </section>
  );
}
