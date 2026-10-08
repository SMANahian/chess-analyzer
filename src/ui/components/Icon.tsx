// Small stroke icon set (24×24, currentColor). Decorative by default; pass `label` for a meaningful icon.
import type { JSX } from 'preact';

const PATHS = {
  home: 'M3.5 10.5 12 3.5l8.5 7V20a.5.5 0 0 1-.5.5h-5v-6H9v6H4a.5.5 0 0 1-.5-.5z',
  leaks: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 4.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zm0 3.6a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8z',
  train: 'M6.5 7v10M17.5 7v10M3.5 9.5v5M20.5 9.5v5M6.5 12h11',
  openings: 'M5 5.5A2.5 2.5 0 0 1 7.5 3H19v14H7.5A2.5 2.5 0 0 0 5 19.5zM5 19.5A2.5 2.5 0 0 0 7.5 22H19v-5',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  settings: 'M4 6.5h9M17 6.5h3M4 12h3M11 12h9M4 17.5h11M19 17.5h1M15 4.5v4M9 10v4M17 15.5v4',
  scout: 'M10 15.5a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0zM21 15.5a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0zM10 15h4M4 13l2.5-8h2l1.5 8M20 13l-2.5-8h-2L14 13',
  about: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5.5M12 7.6v.1',
  refresh: 'M20 12a8 8 0 1 1-2.35-5.65M20 4v4.5h-4.5',
  close: 'M6 6l12 12M18 6 6 18',
  check: 'M5 12.5l4.5 4.5L19 7',
  copy: 'M9 9h10.5v11.5H9zM5.5 15H4.5V3.5H15v1.5',
  download: 'M12 4v11M7 10.5l5 5 5-5M5 20h14',
  upload: 'M12 16V5M7 9.5l5-5 5 5M5 20h14',
  alert: 'M12 3.5 2.5 20h19zM12 10v4.5M12 17.3v.1',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  lock: 'M5.5 11h13v10h-13zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  chevron: 'M9 6l6 6-6 6',
  file: 'M6 3h8.5L19 7.5V21H6zM14 3v5h5',
  play: 'M8 5.5v13l10.5-6.5z',
  skip: 'M5.5 5.5v13l9-6.5zM18.5 5.5v13',
  repeat: 'M17 3l3 3-3 3M4 11.5V10a4 4 0 0 1 4-4h12M7 21l-3-3 3-3M20 12.5V14a4 4 0 0 1-4 4H4',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3.5 2',
  flip: 'M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  shield: 'M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z',
  search: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM15.5 15.5 20 20',
  filter: 'M4 5h16l-6 7.5V19l-4 1.5v-8z',
  back: 'M15 6l-6 6 6 6',
  first: 'M17 6l-6 6 6 6M7 6v12',
  last: 'M7 6l6 6-6 6M17 6v12',
  bulb: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2v.1h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z',
  flame: 'M12 21c3.9 0 6.5-2.6 6.5-6.2 0-3.2-2-5.6-4.2-7.8-.4 2-1.4 3.2-2.8 3.8.3-2.9-.8-5.6-3.3-7.8.2 3.2-1.4 5.1-2.7 6.8-.9 1.2-1.5 2.6-1.5 4.6C4 18.4 7.6 21 12 21z',
  keyboard: 'M3 6.5h18v11H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10',
  plus: 'M12 5v14M5 12h14',
} as const;

export type IconName = keyof typeof PATHS;

export interface IconProps {
  name: IconName;
  /** px, default 20. */
  size?: number;
  /** Accessible name; omit for decorative icons (aria-hidden). */
  label?: string;
  class?: string;
  strokeWidth?: number;
}

export function Icon({ name, size = 20, label, class: cls, strokeWidth = 1.8 }: IconProps): JSX.Element {
  const a11y = label ? { role: 'img' as const, 'aria-label': label } : { 'aria-hidden': true as const };
  return (
    <svg
      class={cls ? `icon ${cls}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      // 'more' is three zero-length strokes: round caps render them as dots.
      stroke-width={name === 'more' ? 3.2 : strokeWidth}
      stroke-linecap="round"
      stroke-linejoin="round"
      focusable="false"
      {...a11y}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
