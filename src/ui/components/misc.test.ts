import { describe, expect, it } from 'vitest';
import { resolveTheme, isThemePref } from '../theme';
import { friendlyError } from './errors';
import { nextVisitState } from './visits';

describe('resolveTheme', () => {
  it('follows the system only for "system"', () => {
    expect(resolveTheme('system', true)).toBe('light');
    expect(resolveTheme('system', false)).toBe('dark');
    expect(resolveTheme('dark', true)).toBe('dark');
    expect(resolveTheme('light', false)).toBe('light');
  });
  it('validates stored values', () => {
    expect(isThemePref('dark')).toBe(true);
    expect(isThemePref('blue')).toBe(false);
    expect(isThemePref(null)).toBe(false);
  });
});

describe('nextVisitState', () => {
  const H = 60 * 60 * 1000;
  it('starts with no previous visit', () => {
    expect(nextVisitState(undefined, 1000)).toEqual({ previous: 0, current: 1000 });
  });
  it('keeps the comparison point during one session', () => {
    const s = { previous: 10, current: 100 * H };
    expect(nextVisitState(s, 100 * H + 2 * H)).toBe(s);
  });
  it('moves the comparison point on a new visit', () => {
    expect(nextVisitState({ previous: 10, current: 100 * H }, 120 * H)).toEqual({ previous: 100 * H, current: 120 * H });
  });
});

describe('friendlyError', () => {
  const sourceError = (kind: string, extra: Record<string, unknown> = {}): Error =>
    Object.assign(new Error(`lichess: ${kind}`), { name: 'SourceError', kind, ...extra });

  it('names the account and site when known', () => {
    const e = friendlyError(sourceError('not-found', { account: { platform: 'chesscom', username: 'Hero' } }));
    expect(e.kind).toBe('not-found');
    expect(e.platform).toBe('chesscom');
    expect(e.title).toBe('No Chess.com account “Hero”');
    expect(e.suggestPgn).toBe(false);
  });

  it('suggests a PGN upload for network, CORS and rate limits', () => {
    expect(friendlyError(sourceError('network')).suggestPgn).toBe(true);
    expect(friendlyError(sourceError('rate-limited')).title).toContain('Lichess asked us to slow down');
    expect(friendlyError(new TypeError('Failed to fetch')).kind).toBe('network');
  });

  it('handles aborts and arbitrary values', () => {
    expect(friendlyError(new DOMException('x', 'AbortError')).kind).toBe('aborted');
    expect(friendlyError('boom')).toMatchObject({ kind: 'unknown', text: 'boom' });
    expect(friendlyError(undefined).kind).toBe('unknown');
  });
});

describe('About: licences shipped with the build', () => {
  it('links relative to the app base, so they resolve under any sub-path', async () => {
    const { ENGINE_LICENSE, SHIPPED_LICENSES, shippedUrl } = await import('../pages/About');
    expect(shippedUrl(SHIPPED_LICENSES, './')).toBe('./THIRD-PARTY-LICENSES.md');
    expect(shippedUrl(ENGINE_LICENSE, '/chess-analyzer/')).toBe('/chess-analyzer/engine/COPYING.txt');
    expect(shippedUrl(ENGINE_LICENSE, '/chess-analyzer')).toBe('/chess-analyzer/engine/COPYING.txt');
  });
});
