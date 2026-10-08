// document.title per view, so each route identifies itself (browser tabs, history, screen readers).
import type { Route, RouteName } from './router';

export const APP_NAME = 'Chess Analyzer';
/** The title of the landing page (same as index.html). */
export const HOME_TITLE = `${APP_NAME} — find and fix your opening mistakes`;

const PAGE_NAMES: Readonly<Record<RouteName, string>> = {
  home: 'Home',
  leaks: 'Leaks',
  train: 'Training',
  openings: 'Openings',
  scout: 'Scout',
  settings: 'Settings',
  about: 'About & FAQ',
  'not-found': 'Page not found',
};

export interface TitleContext {
  /** An own profile exists (otherwise home is the landing / onboarding page). */
  hasProfile: boolean;
  /** The leak shown at #/leaks/<id>, as written in a sentence ('2…c4??'). */
  leak?: string;
  /** The scouted player shown at #/scout/<id>. */
  scout?: string;
}

/** '2…c4?? · Leaks — Chess Analyzer', 'Training — Chess Analyzer', the landing title for onboarding. */
export function pageTitle(r: Route, ctx: TitleContext): string {
  if (r.name === 'home' && !ctx.hasProfile) return HOME_TITLE;
  const page = PAGE_NAMES[r.name];
  const detail = r.name === 'leaks' ? ctx.leak : r.name === 'scout' ? ctx.scout : undefined;
  return detail ? `${detail} · ${page} — ${APP_NAME}` : `${page} — ${APP_NAME}`;
}
