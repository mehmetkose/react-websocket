import { defineConfig } from 'vitepress';
import { monochromeDark, monochromeLight } from './monochrome';

const repo = 'https://github.com/mehmetkose/react-websocket';

export default defineConfig({
  title: 'react-websocket',
  description:
    'Hooks-first WebSocket client for React: shared connections, auto-reconnect, typed messages, Suspense-ready.',
  // Served from GitHub Pages at https://mehmetkose.github.io/react-websocket/
  base: '/react-websocket/',
  cleanUrls: true,
  lastUpdated: true,
  head: [
    // `head` links aren't rewritten with `base`, so the icon path includes it.
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/react-websocket/favicon.svg' }],
    ['meta', { name: 'theme-color', media: '(prefers-color-scheme: light)', content: '#ffffff' }],
    ['meta', { name: 'theme-color', media: '(prefers-color-scheme: dark)', content: '#000000' }]
  ],
  markdown: {
    // Grayscale highlighting to match the black/white theme.
    theme: { light: monochromeLight, dark: monochromeDark }
  },
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started', activeMatch: '/guide/' },
      { text: 'API', link: '/api/', activeMatch: '/api/' },
      { text: 'Recipes', link: '/recipes', activeMatch: '/recipes' },
      {
        text: 'v3',
        items: [
          { text: 'Changelog', link: `${repo}/blob/main/CHANGELOG.md` },
          { text: 'Migrating from v2', link: '/migration' },
          { text: 'Contributing', link: `${repo}/blob/main/CONTRIBUTING.md` }
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
          { text: 'Topic subscriptions', link: '/guide/topics' },
          { text: 'Message state', link: '/guide/state' },
          { text: 'Real-time games', link: '/guide/games' },
          { text: 'AI agents', link: '/guide/agents' },
          { text: 'Suspense', link: '/guide/suspense' },
          { text: 'Server rendering and Next.js', link: '/guide/ssr' },
          { text: 'StrictMode, Activity and lifecycle', link: '/guide/lifecycle' },
          { text: 'Authentication', link: '/guide/authentication' },
          { text: 'Performance', link: '/guide/performance' },
          { text: 'Testing', link: '/guide/testing' },
          { text: 'Chaos testing', link: '/guide/chaos' },
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
          { text: 'useWebSocketTopic', link: '/api/use-websocket-topic' },
          { text: 'useWebSocketState', link: '/api/use-websocket-state' },
          { text: 'useWebSocketLatency', link: '/api/use-websocket-latency' },
          { text: 'useAgentApproval', link: '/api/use-agent-approval' },
          { text: 'createWebSocket', link: '/api/create-websocket' },
          { text: 'createWebSocketTopics', link: '/api/create-websocket-topics' },
          { text: 'createWebSocketState', link: '/api/create-websocket-state' },
          { text: 'createWebSocketRequests', link: '/api/create-websocket-requests' },
          { text: 'createWebSocketLatency', link: '/api/create-websocket-latency' },
          { text: 'createWebSocketResponder', link: '/api/create-websocket-responder' },
          { text: 'createChaosWebSocket', link: '/api/chaos' },
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
      pattern: `${repo}/edit/main/docs/:path`,
      text: 'Edit this page on GitHub'
    },
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © Mehmet Kose and contributors'
    }
  }
});
