import type { Handle, RemixNode } from 'remix/component';
import { ImportMap } from 'remix/component/server';
import { scriptEntry, stylesheet } from '../assets.ts';
import { routes } from '../routes.ts';
import { StatusBadge } from '../ui/public/status-badge.tsx';

interface DocumentProps {
  title: string;
  /** The page's href, to mark its link in the navigation. */
  current: string;
  children?: RemixNode;
}

export function Document(handle: Handle<DocumentProps>) {
  return () => {
    const { title, current, children } = handle.props;
    const { href, importMap, preloads } = scriptEntry;
    const link = (to: string, label: string) => (
      <a href={to} aria-current={to === current ? 'page' : undefined}>
        {label}
      </a>
    );

    return (
      <html lang="en">
        <head>
          <meta charSet="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta
            name="description"
            content="Every react-websocket feature in a Remix 3 app, with react-websocket/core and no React."
          />
          <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
          <link rel="stylesheet" href={stylesheet} />
          <title>{title}</title>
          <ImportMap value={importMap} />
          {preloads.map(preload => (
            <link key={preload} rel="modulepreload" href={preload} />
          ))}
          <script type="module" src={href}></script>
        </head>
        <body>
          <main>
            <header class="top">
              <h1>
                react-websocket + Remix
                {/* The same client entry at the same place on every page, so client navigation
                    keeps it mounted instead of hydrating a new one. */}
                <StatusBadge />
              </h1>
              <nav>
                {link(routes.home.href(), 'Demo')}
                {link(routes.about.href(), 'About')}
              </nav>
            </header>
            {children}
          </main>
        </body>
      </html>
    );
  };
}
