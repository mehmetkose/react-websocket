import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { RouteMeta, RspressPlugin } from '@rspress/core';

const execFileAsync = promisify(execFile);

/** The date of the last commit that changed `file` (ISO 8601), or undefined if it has none. */
async function lastCommitDate(file: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['log', '-1', '--format=%cI', '--', file]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The search engine support that needs Node, at build time:
 *
 * - Adds `dateModified` to every page's data: the page's last commit date, for the structured data
 *   in the theme's <SeoHead>. The built-in `lastUpdatedTime` is a localized display string.
 * - Writes sitemap.xml after a production build. The site is served from a subdirectory of
 *   mehmetkose.github.io, where a robots.txt would be ignored, so the sitemap is submitted in
 *   Search Console instead of being listed there.
 */
export function pluginSeo({ siteUrl }: { siteUrl: string }): RspressPlugin {
  let routes: RouteMeta[] = [];
  const dates = new Map<string, Promise<string | undefined>>();
  const dateOf = (file: string) => {
    let date = dates.get(file);
    if (!date) dates.set(file, (date = lastCommitDate(file)));
    return date;
  };

  return {
    name: 'react-websocket-seo',
    routeGenerated(generated) {
      routes = generated;
    },
    async extendPageData(pageData) {
      Object.assign(pageData, { dateModified: await dateOf(pageData._filepath) });
    },
    async afterBuild(config, isProd) {
      if (!isProd) return;
      const urls = await Promise.all(
        [...routes]
          .sort((a, b) => a.routePath.localeCompare(b.routePath))
          .map(async ({ routePath, absolutePath }) => {
            const loc = new URL(routePath.slice(1), siteUrl).href;
            const lastmod = await dateOf(absolutePath);
            return `  <url>\n    <loc>${loc}</loc>\n${lastmod ? `    <lastmod>${lastmod}</lastmod>\n` : ''}  </url>`;
          })
      );
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
      await writeFile(path.resolve(config.outDir ?? 'doc_build', 'sitemap.xml'), xml);
    }
  };
}
