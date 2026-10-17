import { createController } from 'remix/router';
import { assets } from '../assets.ts';
import { issueToken } from '../live/token.ts';
import { routes } from '../routes.ts';
import { AboutPage } from './about-page.tsx';
import { HomePage } from './home-page.tsx';

export default createController(routes, {
  actions: {
    async assets(context) {
      return (await assets.fetch(context.request)) ?? new Response('Not Found', { status: 404 });
    },
    // The WebSocket URL function fetches a fresh token here before every connection attempt.
    // A real app would check the user's session first.
    token() {
      return Response.json({ token: issueToken() }, { headers: { 'Cache-Control': 'no-store' } });
    },
    home(context) {
      return context.render(<HomePage />);
    },
    about(context) {
      return context.render(<AboutPage />);
    }
  }
});
