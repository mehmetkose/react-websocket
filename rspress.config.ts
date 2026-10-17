import { defineConfig } from '@rspress/core';
import { rehypeAccessibility } from './docs/plugins/accessibility';
import { pluginSeo } from './docs/plugins/seo';
import { monochromeDark, monochromeLight } from './docs/theme/monochrome';

const repo = 'https://github.com/mehmetkose/react-websocket';
const siteUrl = 'https://mehmetkose.github.io/react-websocket/';

export default defineConfig({
  root: 'docs',
  themeDir: 'docs/theme',
  title: 'react-websocket',
  description:
    'Hooks-first WebSocket client for React: shared connections, auto-reconnect, typed messages, Suspense-ready.',
  // Served from GitHub Pages at https://mehmetkose.github.io/react-websocket/
  siteOrigin: 'https://mehmetkose.github.io',
  base: '/react-websocket/',
  icon: '/favicon.svg',
  // Tags for every page. The per-page ones (canonical URL, structured data) are added by the
  // theme's <SeoHead>.
  head: [
    ['meta', { name: 'theme-color', media: '(prefers-color-scheme: light)', content: '#ffffff' }],
    ['meta', { name: 'theme-color', media: '(prefers-color-scheme: dark)', content: '#000000' }],
    ['meta', { property: 'og:site_name', content: 'react-websocket' }],
    ['meta', { property: 'og:locale', content: 'en_US' }],
    ['meta', { property: 'og:image', content: `${siteUrl}og.png` }],
    ['meta', { property: 'og:image:width', content: '1200' }],
    ['meta', { property: 'og:image:height', content: '630' }],
    [
      'meta',
      { property: 'og:image:alt', content: 'react-websocket: WebSockets for React, done right' }
    ],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }]
  ],
  plugins: [pluginSeo({ siteUrl })],
  // llms.txt, llms-full.txt and a Markdown copy of every page, for AI assistants and agents. The
  // "Copy Markdown" buttons this would add under each title are turned off in themeConfig.
  llms: true,
  route: {
    // Only Markdown files are pages, so the theme and demo components can live under docs/.
    extensions: ['.md', '.mdx'],
    // GitHub Pages serves `/foo.html` for `/foo`.
    cleanUrls: true
  },
  markdown: {
    rehypePlugins: [rehypeAccessibility],
    // Grayscale highlighting to match the black/white theme. Both themes are emitted as CSS
    // variables and picked per mode in index.css.
    shiki: {
      themes: { light: monochromeLight, dark: monochromeDark },
      defaultColor: false
    }
  },
  builderConfig: {
    resolve: {
      // Demos in the docs import the library by name and get the current source, not a build.
      alias: {
        'react-websocket$': './src/index.ts',
        'react-websocket/core': './src/core.ts',
        'react-websocket/chaos': './src/chaos.ts',
        'react-websocket/timeline': './src/timeline.ts',
        'react-websocket/outbox': './src/outbox.ts',
        'react-websocket/ag-ui': './src/ag-ui.ts',
        'react-websocket/tabs': './src/tabs.ts',
        'react-websocket/replay': './src/replay.ts'
      }
    }
  },
  themeConfig: {
    llmsUI: false,
    nav: [
      { text: 'Guide', link: '/guide/getting-started', activeMatch: '/guide/' },
      { text: 'API', link: '/api/', activeMatch: '/api/' },
      { text: 'Recipes', link: '/recipes', activeMatch: '/recipes' },
      {
        text: 'v4',
        items: [
          { text: 'Changelog', link: `${repo}/blob/main/CHANGELOG.md` },
          { text: 'Migrating from v3', link: '/migration-v3' },
          { text: 'Migrating from v2', link: '/migration' },
          { text: 'Contributing', link: `${repo}/blob/main/CONTRIBUTING.md` }
        ]
      }
    ],
    sidebar: {
      '/': [
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
            { text: 'One connection across tabs', link: '/guide/tabs' },
            { text: 'Messages and types', link: '/guide/messages' },
            { text: 'Reconnecting and heartbeats', link: '/guide/reconnecting' },
            { text: 'Offline outbox', link: '/guide/outbox' },
            { text: 'Presence and live cursors', link: '/guide/presence' },
            { text: 'Topic subscriptions', link: '/guide/topics' },
            { text: 'Message state', link: '/guide/state' },
            { text: 'Real-time games', link: '/guide/games' },
            { text: 'AI agents', link: '/guide/agents' },
            { text: 'AG-UI', link: '/guide/ag-ui' },
            { text: 'Voice agents', link: '/guide/voice' },
            { text: 'Suspense', link: '/guide/suspense' },
            { text: 'Server rendering and Next.js', link: '/guide/ssr' },
            { text: 'StrictMode, Activity and lifecycle', link: '/guide/lifecycle' },
            { text: 'Authentication', link: '/guide/authentication' },
            { text: 'Performance', link: '/guide/performance' },
            { text: 'Testing', link: '/guide/testing' },
            { text: 'Chaos testing', link: '/guide/chaos' },
            { text: 'Recording and replay', link: '/guide/replay' },
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
            { text: 'useAgentRun', link: '/api/use-agent-run' },
            { text: 'useWebSocketStream', link: '/api/use-websocket-stream' },
            { text: 'useWebSocketOutbox', link: '/api/use-websocket-outbox' },
            { text: 'useWebSocketPresence', link: '/api/use-websocket-presence' },
            { text: 'useInView', link: '/api/use-in-view' },
            { text: 'createWebSocket', link: '/api/create-websocket' },
            { text: 'createWebSocketTopics', link: '/api/create-websocket-topics' },
            { text: 'createWebSocketFeeds', link: '/api/create-websocket-feeds' },
            { text: 'createWebSocketState', link: '/api/create-websocket-state' },
            { text: 'createWebSocketRequests', link: '/api/create-websocket-requests' },
            { text: 'createWebSocketLatency', link: '/api/create-websocket-latency' },
            { text: 'createWebSocketSendRate', link: '/api/create-websocket-send-rate' },
            { text: 'createWebSocketPresence', link: '/api/create-websocket-presence' },
            { text: 'createWebSocketResponder', link: '/api/create-websocket-responder' },
            { text: 'createWebSocketRuns', link: '/api/create-websocket-runs' },
            { text: 'createWebSocketTimeline', link: '/api/create-websocket-timeline' },
            { text: 'createWebSocketOutbox', link: '/api/create-websocket-outbox' },
            { text: 'react-websocket/ag-ui', link: '/api/ag-ui' },
            { text: 'createTabsWebSocket', link: '/api/tabs' },
            { text: 'createChaosWebSocket', link: '/api/chaos' },
            { text: 'react-websocket/replay', link: '/api/replay' },
            { text: 'Options', link: '/api/options' },
            { text: 'Types', link: '/api/types' }
          ]
        },
        {
          text: 'More',
          items: [
            { text: 'Recipes', link: '/recipes' },
            { text: 'Troubleshooting', link: '/troubleshooting' },
            { text: 'Migrating from v3', link: '/migration-v3' },
            { text: 'Migrating from v2', link: '/migration' }
          ]
        }
      ]
    },
    socialLinks: [
      { icon: 'github', mode: 'link', content: repo },
      { icon: 'npm', mode: 'link', content: 'https://www.npmjs.com/package/react-websocket' }
    ],
    editLink: { docRepoBaseUrl: `${repo}/tree/main/docs` },
    lastUpdated: true,
    footer: {
      message: 'Released under the MIT License. Copyright © Mehmet Kose and contributors.'
    }
  }
});
