import type { ComponentProps } from 'react';
import {
  Button,
  DocContent,
  HomeBackground,
  HomeFeature,
  HomeFooter,
  HomeLayout as BasicHomeLayout,
  Layout as BasicLayout,
  renderHtmlOrText
} from '@rspress/core/theme-original';
// The built-in hero imports its styles; replacing it drops them from the bundle.
import '@rspress/core/dist/theme/components/HomeHero/index.css';
// Self-hosted (bundled) so the docs make no third-party font requests.
import '@fontsource-variable/geist-mono/wght.css';
import '@fontsource-variable/geist-mono/wght-italic.css';
import './index.css';
import { useFrontmatter } from '@rspress/core/runtime';
import { SeoHead } from './components/SeoHead';
import { ServerRingHero } from './components/ServerRingHero';
import { SocialLinks } from './components/SocialLinks';
import { SwitchAppearance } from './components/SwitchAppearance';

// The built-in layouts import their components from the theme, so the exports below replace them:
// the layout (to add the SEO tags), the home page's hero and layout, and accessible versions of the
// theme toggle and social links.

function Layout(props: ComponentProps<typeof BasicLayout>) {
  return (
    <BasicLayout
      {...props}
      top={
        <>
          <SeoHead />
          {props.top}
        </>
      }
    />
  );
}

/**
 * The built-in hero, with the package name and headline in an <h1> (the built-in one has no
 * heading) and the animation in the image slot. Only the frontmatter fields this site uses.
 */
function HomeHero() {
  const { frontmatter } = useFrontmatter();
  const { name = '', text = '', tagline = '', actions = [] } = frontmatter.hero ?? {};
  return (
    <div className="rp-home-hero">
      <div className="rp-home-hero__container">
        <div className="rp-home-hero__content">
          <h1 className="rp-home-hero__title">
            <span className="rp-home-hero__title-brand">{name}</span>{' '}
            <span className="rp-home-hero__subtitle">{text}</span>
          </h1>
        </div>
        <p className="rp-home-hero__tagline" {...renderHtmlOrText(tagline)} />
        <div className="rp-home-hero__actions">
          {actions.map(action => (
            <Button
              key={action.link}
              type="a"
              href={action.link}
              theme={action.theme}
              className="rp-home-hero__action"
              {...renderHtmlOrText(action.text)}
            />
          ))}
        </div>
      </div>
      <div className="rp-home-hero__image">
        <ServerRingHero className="rws-hero" />
      </div>
    </div>
  );
}

/**
 * The built-in home page renders only the frontmatter, with no <main>. This one puts the hero, the
 * features and the page's Markdown body (the "At a glance" example) in a <main>. `isOverviewPage`
 * skips the fallback <h1>. The Markdown version for llms.txt is the built-in one.
 */
function HomeLayout(props: ComponentProps<typeof BasicHomeLayout>) {
  if (import.meta.env.SSG_MD) return <BasicHomeLayout {...props} />;
  return (
    <>
      <HomeBackground />
      <main>
        <HomeHero />
        <HomeFeature />
        <div className="rp-doc rws-home-content">
          <DocContent components={{}} isOverviewPage />
        </div>
      </main>
      <HomeFooter />
    </>
  );
}

export * from '@rspress/core/theme-original';
export { HomeHero, HomeLayout, Layout, SocialLinks, SwitchAppearance };
