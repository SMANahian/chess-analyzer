// Tiny hash router: `#/leaks/<shortId>?opening=Sicilian` → { name: 'leaks', id: '<shortId>', query: { opening: 'Sicilian' } }.
// Links are plain `<a href={href(...)}>`; the current route is a signal.
import { signal, type ReadonlySignal } from '@preact/signals';

export type RouteName = 'home' | 'leaks' | 'train' | 'openings' | 'scout' | 'settings' | 'about' | 'not-found';

export interface Route {
  name: RouteName;
  /** Second path segment: a mistake shortId (`#/leaks/<id>`) or a scouted profile id (`#/scout/<id>`). */
  id?: string;
  query: Readonly<Record<string, string>>;
  /** The normalised path, e.g. '/leaks/abc123'. */
  path: string;
}

/** Props every page component receives (pages default-export a component taking these). */
export interface PageProps {
  route: Route;
}

const NAMES: Readonly<Record<string, RouteName>> = {
  '': 'home',
  leaks: 'leaks',
  train: 'train',
  openings: 'openings',
  scout: 'scout',
  settings: 'settings',
  about: 'about',
};
/** Routes that accept an id segment. */
const WITH_ID: ReadonlySet<RouteName> = new Set(['leaks', 'scout']);

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function parseQuery(qs: string): Record<string, string> {
  const query: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(qs)) query[k] = v;
  return query;
}

/** Parses `location.hash` ('#/leaks/abc?x=1', '#leaks', '', '#/') into a route. Never throws. */
export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '');
  const q = raw.indexOf('?');
  const pathPart = q >= 0 ? raw.slice(0, q) : raw;
  const query = parseQuery(q >= 0 ? raw.slice(q + 1) : '');
  const segments = pathPart.split('/').filter(Boolean).map(decode);
  const name = NAMES[segments[0] ?? ''] ?? 'not-found';
  const id = WITH_ID.has(name) ? segments[1] : undefined;
  const tooDeep = segments.length > (WITH_ID.has(name) ? 2 : name === 'home' ? 0 : 1);
  if (name === 'not-found' || tooDeep) return { name: 'not-found', query, path: `/${segments.join('/')}` };
  const path = `/${[segments[0] ?? '', id].filter(Boolean).join('/')}`;
  return id ? { name, id, query, path } : { name, query, path };
}

/** Builds a hash href: href('leaks', 'abc') → '#/leaks/abc'; href('home', undefined, { lichess: 'x' }) → '#/?lichess=x'. */
export function href(name: Exclude<RouteName, 'not-found'>, id?: string, query?: Record<string, string | undefined>): string {
  const first = name === 'home' ? '' : name;
  const path = `#/${[first, id === undefined ? '' : encodeURIComponent(id)].filter(Boolean).join('/')}`;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== '') params.set(k, v);
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

const currentHash = (): string => (typeof location === 'undefined' ? '' : location.hash);

const routeSignal = signal<Route>(parseHash(currentHash()));
export const route: ReadonlySignal<Route> = routeSignal;

/** Goes to a hash href (e.g. href('leaks')). `replace` avoids a history entry (redirects, filter changes). */
export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  const target = to.startsWith('#') ? to : `#${to}`;
  if (target === currentHash()) return;
  if (opts.replace) {
    history.replaceState(history.state, '', target);
    routeSignal.value = parseHash(target);
  } else {
    location.hash = target;
  }
}

/** Starts listening to hash changes; returns the unsubscribe function. */
export function startRouter(): () => void {
  const onChange = (): void => {
    const next = parseHash(currentHash());
    const prev = routeSignal.value;
    routeSignal.value = next;
    // A new page starts at the top; same-page query changes (filters) keep the scroll position.
    if (next.path !== prev.path) window.scrollTo({ top: 0 });
  };
  window.addEventListener('hashchange', onChange);
  onChange();
  return () => window.removeEventListener('hashchange', onChange);
}
