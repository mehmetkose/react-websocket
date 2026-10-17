import { socialLinks as icons, useSite } from '@rspress/core/runtime';
// The built-in component imports its styles; replacing it drops them from the bundle.
import '@rspress/core/dist/theme/components/SocialLinks/index.css';

const labels: Record<string, string> = { github: 'GitHub', npm: 'npm' };

/**
 * The built-in social links are icon-only <a> elements with no accessible name. Same markup, with
 * an aria-label. Only the `link` mode is used here.
 */
export function SocialLinks() {
  const { site } = useSite();
  const links = site.themeConfig.socialLinks ?? [];
  return (
    <div className="rp-social-links">
      {links.map(({ icon, content }) => {
        const name = typeof icon === 'string' ? icon : '';
        return (
          <a
            key={content}
            href={content}
            target="_blank"
            rel="noopener noreferrer"
            className="rp-social-links__item"
            aria-label={labels[name] ?? name}
          >
            <div className="rp-social-links__icon">
              <div
                className="rp-social-links__icon"
                dangerouslySetInnerHTML={{
                  __html: typeof icon === 'string' ? (icons[icon] ?? '') : icon.svg
                }}
              />
            </div>
          </a>
        );
      })}
    </div>
  );
}
