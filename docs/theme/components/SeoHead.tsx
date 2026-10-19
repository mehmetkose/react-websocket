import { useHead, usePage, useSite } from '@rspress/core/runtime';

const repo = 'https://github.com/mehmetkose/react-websocket';
const npm = 'https://www.npmjs.com/package/react-websocket';

// The sections that have an index page, for the breadcrumbs: their name and the index's path.
const sections: Record<string, [name: string, path: string]> = {
  guide: ['Guide', 'guide/'],
  api: ['API reference', 'api/'],
  recipes: ['Recipes', 'recipes']
};

/**
 * Per-page tags for search engines and link previews that Rspress doesn't add: the canonical URL,
 * og:url and og:type, and schema.org structured data (JSON-LD). The tags shared by every page are
 * in `head` in rspress.config.ts.
 *
 * Structured data: the home and doc pages describe the site, its author and the library. Doc pages
 * add a TechArticle (with the last commit date from docs/plugins/seo.ts) and a BreadcrumbList.
 */
export function SeoHead() {
  const { page } = usePage();
  const { site } = useSite();

  const siteUrl = `${site.siteOrigin}${site.base}`;
  const url = new URL(page.routePath.replace(/^\//, ''), siteUrl).href;
  const isHome = page.pageType === 'home';
  const isDoc = page.pageType === 'doc' || page.pageType === 'doc-wide';
  const indexable = isHome || isDoc;
  const description = page.description || site.description;
  const dateModified = page.dateModified as string | undefined;

  const author = {
    '@type': 'Person',
    '@id': `${siteUrl}#author`,
    name: 'Mehmet Kose',
    url: 'https://sourcream.uk/',
    sameAs: ['https://github.com/mehmetkose']
  };
  const graph: Record<string, unknown>[] = [
    {
      '@type': 'WebSite',
      '@id': `${siteUrl}#website`,
      url: siteUrl,
      name: site.title,
      description: site.description,
      inLanguage: 'en',
      publisher: { '@id': author['@id'] }
    },
    author,
    {
      '@type': 'SoftwareSourceCode',
      '@id': `${siteUrl}#software`,
      name: 'react-websocket',
      description: site.description,
      url: siteUrl,
      codeRepository: repo,
      programmingLanguage: ['TypeScript', 'JavaScript'],
      runtimePlatform: 'React 18, React 19',
      license: 'https://opensource.org/licenses/MIT',
      author: { '@id': author['@id'] },
      sameAs: [npm, repo]
    }
  ];

  if (isDoc) {
    graph.push({
      '@type': 'TechArticle',
      '@id': `${url}#article`,
      headline: page.title,
      description,
      url,
      mainEntityOfPage: url,
      inLanguage: 'en',
      image: `${siteUrl}og.png`,
      ...(dateModified && { dateModified }),
      author: { '@id': author['@id'] },
      publisher: { '@id': author['@id'] },
      isPartOf: { '@id': `${siteUrl}#website` },
      about: { '@id': `${siteUrl}#software` }
    });

    const crumbs = [{ name: site.title, item: siteUrl }];
    const [sectionName, sectionPath] = sections[page.routePath.split('/')[1] ?? ''] ?? [];
    const sectionUrl = `${siteUrl}${sectionPath}`;
    if (sectionName && url !== sectionUrl) crumbs.push({ name: sectionName, item: sectionUrl });
    // The page's <h1>, which is shorter than its title.
    crumbs.push({ name: page.headingTitle || page.title, item: url });
    graph.push({
      '@type': 'BreadcrumbList',
      itemListElement: crumbs.map((crumb, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        ...crumb
      }))
    });
  }

  useHead({
    link: indexable ? [{ rel: 'canonical', href: url }] : [],
    meta: [
      indexable ? { property: 'og:url', content: url } : undefined,
      isDoc ? { property: 'og:type', content: 'article' } : undefined,
      page.pageType === '404' ? { name: 'robots', content: 'noindex' } : undefined
    ],
    script: indexable
      ? [
          {
            type: 'application/ld+json',
            // `<` escaped so no string in the data can close the script element.
            innerHTML: JSON.stringify({
              '@context': 'https://schema.org',
              '@graph': graph
            }).replace(/</g, '\\u003c')
          }
        ]
      : []
  });

  return null;
}
