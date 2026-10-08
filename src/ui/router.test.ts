import { describe, expect, it } from 'vitest';
import { href, parseHash } from './router';

describe('parseHash', () => {
  it('maps empty and root hashes to home', () => {
    expect(parseHash('')).toEqual({ name: 'home', query: {}, path: '/' });
    expect(parseHash('#')).toEqual({ name: 'home', query: {}, path: '/' });
    expect(parseHash('#/')).toEqual({ name: 'home', query: {}, path: '/' });
  });

  it('parses pages, ids and query strings', () => {
    expect(parseHash('#/leaks')).toMatchObject({ name: 'leaks', path: '/leaks' });
    expect(parseHash('#/leaks/')).toMatchObject({ name: 'leaks', path: '/leaks' });
    expect(parseHash('#/leaks/abc123def0')).toEqual({ name: 'leaks', id: 'abc123def0', query: {}, path: '/leaks/abc123def0' });
    expect(parseHash('#/scout/p%7C1?tab=prep')).toEqual({ name: 'scout', id: 'p|1', query: { tab: 'prep' }, path: '/scout/p|1' });
    expect(parseHash('#/?lichess=hero&chesscom=Hero%20X')).toEqual({
      name: 'home',
      query: { lichess: 'hero', chesscom: 'Hero X' },
      path: '/',
    });
    expect(parseHash('#settings')).toMatchObject({ name: 'settings' });
  });

  it('rejects unknown pages and ids on pages without ids', () => {
    expect(parseHash('#/nope').name).toBe('not-found');
    expect(parseHash('#/train/extra').name).toBe('not-found');
    expect(parseHash('#/leaks/a/b').name).toBe('not-found');
  });

  it('survives malformed escapes', () => {
    expect(parseHash('#/leaks/%E0%A4%A')).toMatchObject({ name: 'leaks', id: '%E0%A4%A' });
  });
});

describe('href', () => {
  it('builds hrefs that parse back', () => {
    expect(href('home')).toBe('#/');
    expect(href('leaks', 'abc')).toBe('#/leaks/abc');
    expect(href('home', undefined, { lichess: 'x y', chesscom: undefined, other: '' })).toBe('#/?lichess=x+y');
    const h = href('scout', 'p|1', { tab: 'prep' });
    expect(parseHash(h)).toMatchObject({ name: 'scout', id: 'p|1', query: { tab: 'prep' } });
  });
});
