import { defineConfig } from 'vitepress';

const repo = 'https://github.com/mehmetkose/react-websocket';

export default defineConfig({
  title: 'react-websocket',
  description:
    'Hooks-first WebSocket client for React: shared connections, auto-reconnect, typed messages, Suspense-ready.',
  // Served from GitHub Pages at https://mehmetkose.github.io/react-websocket/
  base: '/react-websocket/',
  cleanUrls: true,
  lastUpdated: true,
  head: [['meta', { name: 'theme-color', content: '#3c8772' }]],
  markdown: {
    theme: { light: 'github-light', dark: 'github-dark' }
  },
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started', activeMatch: '/guide/' },
      { text: 'API', link: '/api/', activeMatch: '/api/' },
      { text: 'Recipes', link: '/recipes', activeMatch: '/recipes' },
      {
        text: 'v3',
        items: [
          { text: 'Changelog', link: `${repo}/blob/master/CHANGELOG.md` },
          { text: 'Migrating from v2', link: '/migration' },
          { text: 'Contributing', link: `${repo}/blob/master/CONTRIBUTING.md` }
        ]
      }
    ],
    sidebar: [
      {
        text: 'Introduction',
        items: [
          { text: 'Why react-websocket', link: '/guide/' },
          { text: 'Getting started', link: '/guide/getting-started' }
        ]
      },
      {
        text: 'Guide',
        items: [
          { text: 'Shared clients', link: '/guide/shared-clients' },
          { text: 'Messages and types', link: '/guide/messages' },
          { text: 'Reconnecting and heartbeats', link: '/guide/reconnecting' },
          { text: 'Suspense', link: '/guide/suspense' },
          { text: 'Server rendering and Next.js', link: '/guide/ssr' },
          { text: 'StrictMode, Activity and lifecycle', link: '/guide/lifecycle' },
          { text: 'Authentication', link: '/guide/authentication' },
          { text: 'Performance', link: '/guide/performance' },
          { text: 'Testing', link: '/guide/testing' },
          { text: 'Without React', link: '/guide/without-react' }
        ]
      },
      {
        text: 'API reference',
        items: [
          { text: 'Overview', link: '/api/' },
          { text: 'useWebSocket', link: '/api/use-websocket' },
          { text: 'useWebSocketEvent', link: '/api/use-websocket-event' },
          { text: 'useWebSocketStatus', link: '/api/use-websocket-status' },
          { text: 'createWebSocket', link: '/api/create-websocket' },
          { text: 'Options', link: '/api/options' },
          { text: 'Types', link: '/api/types' }
        ]
      },
      {
        text: 'More',
        items: [
          { text: 'Recipes', link: '/recipes' },
          { text: 'Troubleshooting', link: '/troubleshooting' },
          { text: 'Migrating from v2', link: '/migration' }
        ]
      }
    ],
    outline: { level: [2, 3] },
    search: { provider: 'local' },
    socialLinks: [
      { icon: 'github', link: repo },
      { icon: 'npm', link: 'https://www.npmjs.com/package/react-websocket' }
    ],
    editLink: {
      pattern: `${repo}/edit/master/docs/:path`,
      text: 'Edit this page on GitHub'
    },
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © Mehmet Kose and contributors'
    }
  }
});
