import { clientEntry, on, type Handle } from 'remix/component';
import { holdTopic, watchState } from '../../live/public/bindings.ts';
import { prices, topics } from '../../live/public/live.ts';
import { SYMBOLS } from '../../live/public/protocol.ts';

export const Prices = clientEntry(import.meta.url, function Prices(handle: Handle) {
  let watching: string[] = ['ACME', 'GLOBEX'];
  const toggle = (symbol: string) => {
    watching = watching.includes(symbol)
      ? watching.filter(s => s !== symbol)
      : [...watching, symbol];
    void handle.update();
  };

  return () => (
    <>
      <div class="row">
        {SYMBOLS.map(symbol => (
          <label key={symbol} class="check">
            <input
              type="checkbox"
              checked={watching.includes(symbol)}
              mix={on('change', () => toggle(symbol))}
            />
            {symbol}
          </label>
        ))}
      </div>
      <ul class="quotes">
        {watching.map(symbol => (
          <Quote key={symbol} symbol={symbol} />
        ))}
      </ul>
    </>
  );
});

function Quote(handle: Handle<{ symbol: string }>) {
  // Keyed by symbol, so it never changes for this instance.
  const { symbol } = handle.props;
  // Subscribed while mounted: `subscribe` is sent on mount, `unsubscribe` a tick after removal,
  // and the subscription is sent again after every reconnect.
  holdTopic(handle, topics, `price:${symbol}`);
  // Re-renders only when this symbol's price changes.
  const price = watchState(handle, prices, state => state[symbol]);
  return () => (
    <li>
      <span>{symbol}</span>
      <strong>{price()?.toFixed(2) ?? '–'}</strong>
    </li>
  );
}
