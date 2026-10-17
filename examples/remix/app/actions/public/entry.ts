// The browser entry: hydrates every client entry on the page. After that, the runtime turns
// same-origin links into in-place navigations, so this module and the shared client in
// app/live/public/live.ts stay loaded from page to page.
import { run } from 'remix/component';
import {
  detectMultipleImportMapSupport,
  importModule,
  preloadShim
} from 'remix/multiple-import-maps-polyfill';

const app = run({
  async loadModule(moduleUrl, exportName) {
    const module = await importModule(moduleUrl);
    const Component = module[exportName];
    if (typeof Component !== 'function') {
      throw new Error(`Unknown component: ${moduleUrl}#${exportName}`);
    }
    return Component;
  },
  async processClientEntryPreloads(preloads) {
    if (await detectMultipleImportMapSupport()) return preloads;
    preloadShim(preloads);
    return [];
  }
});

app.addEventListener('error', event => console.error('Component error:', event.error));
