import type { ComponentProps } from 'react';
import {
  DocContent,
  HomeHero as BasicHomeHero,
  HomeLayout as BasicHomeLayout
} from '@rspress/core/theme-original';
// Self-hosted (bundled) so the docs make no third-party font requests.
import '@fontsource-variable/geist-mono/wght.css';
import '@fontsource-variable/geist-mono/wght-italic.css';
import './index.css';
import { ServerRingHero } from './components/ServerRingHero';

// The layouts import these from the theme, so overriding them here changes the built-in home page.

// The animation goes in the hero's image slot, beside the headline.
function HomeHero(props: ComponentProps<typeof BasicHomeHero>) {
  return <BasicHomeHero {...props} image={<ServerRingHero className="rws-hero" />} />;
}

// The built-in home page renders only the frontmatter. Render the page's Markdown body (the "At a
// glance" example) under the features too. `isOverviewPage` skips the fallback <h1>.
function HomeLayout(props: ComponentProps<typeof BasicHomeLayout>) {
  return (
    <BasicHomeLayout
      {...props}
      afterFeatures={
        <>
          <div className="rp-doc rws-home-content">
            <DocContent components={{}} isOverviewPage />
          </div>
          {props.afterFeatures}
        </>
      }
    />
  );
}

export * from '@rspress/core/theme-original';
export { HomeHero, HomeLayout };
