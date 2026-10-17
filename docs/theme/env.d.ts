// Stylesheets imported for their side effects, bundled by Rspress.
declare module '*.css';

// Defined by Rspress: true while it renders pages to Markdown for llms.txt.
interface ImportMeta {
  readonly env: { readonly SSG_MD: boolean };
}
