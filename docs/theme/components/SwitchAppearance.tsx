import { useContext, useSyncExternalStore } from 'react';
import { ThemeContext } from '@rspress/core/runtime';
import { IconMoon, IconSun, SvgWrapper } from '@rspress/core/theme-original';
// The built-in component imports its styles (icon per mode, no transitions while switching);
// replacing it drops them from the bundle.
import '@rspress/core/dist/theme/components/SwitchAppearance/global.css';
import '@rspress/core/dist/theme/components/SwitchAppearance/index.css';

const subscribe = () => () => {};

/**
 * The built-in theme toggle is a <div> with a click handler: it can't be reached with the keyboard
 * and has no accessible name. This is the same toggle as a switch button.
 */
export function SwitchAppearance({ onClick }: { onClick?: () => void }) {
  const { theme, setTheme } = useContext(ThemeContext);
  const dark = theme === 'dark';
  // The static HTML is rendered without knowing the visitor's theme, and hydration doesn't patch
  // attributes, so report the real state only once hydrated. (The icons switch with CSS.)
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  );
  return (
    <button
      type="button"
      role="switch"
      aria-checked={hydrated && dark}
      aria-label="Dark theme"
      className="rp-switch-appearance"
      onClick={() => {
        setTheme?.(dark ? 'light' : 'dark');
        onClick?.();
      }}
    >
      <SvgWrapper
        className="rp-switch-appearance__icon rp-switch-appearance__icon--sun"
        icon={IconSun}
        fill="currentColor"
      />
      <SvgWrapper
        className="rp-switch-appearance__icon rp-switch-appearance__icon--moon"
        icon={IconMoon}
        fill="currentColor"
      />
    </button>
  );
}
