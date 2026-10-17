import { useState } from 'react';
import { useWebSocketState, useWebSocketTopic } from 'react-websocket';
import { prices, topics } from '../lib/live';
import { SYMBOLS } from '../lib/protocol';

export function Prices() {
  const [watching, setWatching] = useState<string[]>(['ACME', 'GLOBEX']);
  const toggle = (symbol: string) =>
    setWatching(list =>
      list.includes(symbol) ? list.filter(s => s !== symbol) : [...list, symbol]
    );

  return (
    <>
      <div className="row">
        {SYMBOLS.map(symbol => (
          <label key={symbol} className="check">
            <input
              type="checkbox"
              checked={watching.includes(symbol)}
              onChange={() => toggle(symbol)}
            />
            {symbol}
          </label>
        ))}
      </div>
      <ul className="quotes">
        {watching.map(symbol => (
          <Quote key={symbol} symbol={symbol} />
        ))}
      </ul>
    </>
  );
}

function Quote({ symbol }: { symbol: string }) {
  // Subscribed while mounted: `subscribe` is sent on mount, `unsubscribe` a tick after unmount,
  // and the subscription is sent again after every reconnect.
  useWebSocketTopic(topics, `price:${symbol}`);
  // Re-renders only when this symbol's price changes.
  const price = useWebSocketState(prices, state => state[symbol]);
  return (
    <li>
      <span>{symbol}</span>
      <strong>{price === undefined ? '–' : price.toFixed(2)}</strong>
    </li>
  );
}
