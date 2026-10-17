import { createAssetServer } from 'remix/assets';

const isDevelopment = (process.env.NODE_ENV ?? 'development') === 'development';

// Compiles the browser modules on demand. The allow lists are the security boundary: only
// `public/` directories under app/ and the listed packages can reach the browser, so
// app/live/token.ts (which holds the token secret) can't.
export const assets = createAssetServer({
  basePath: '/assets',
  rootDir: process.cwd(),
  allowFiles: ['app/routes.ts', 'app/**/public/**'],
  // `react-websocket/core` and the schema it validates with. React isn't listed: nothing in the
  // browser imports it.
  allowPackages: ['remix', 'react-websocket', 'zod'],
  sourceMaps: isDevelopment ? 'external' : undefined,
  minify: !isDevelopment,
  watch: isDevelopment
});

export const scriptEntry = await assets.getScriptEntry('app/actions/public/entry.ts');
export const stylesheet = await assets.getHref('app/ui/public/global.css');
