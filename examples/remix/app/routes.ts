import { get, route } from 'remix/routes';

// The URL contract, shared by the server and the browser: live.ts builds the token URL from it.
export const routes = route({
  assets: get('/assets/*path'),
  token: get('/api/token'),
  home: get('/'),
  about: get('/about')
});
