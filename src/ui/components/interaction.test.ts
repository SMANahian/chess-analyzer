// Pure pieces of the UI's interaction fixes: confirmation guards, key handling, focus on navigation,
// list paging, page titles, search debounce, the training card copy and the status toasts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { focusesMain } from '../app';
import { pageTitle } from '../pageTitle';
import { parseHash } from '../router';
import { stepKey, statusToastText } from '../pages/LeakDetail';
import { ROW_PAGE, rowsToRender } from '../pages/Leaks';
import { trainCardView } from '../pages/Dashboard';
import { MIN_CONFIRM_MS, confirmStep, isDeliberateClick } from './buttons';
import { deleteSummary } from './DeleteAllData';
import { CHARACTER_SHORTCUTS, isKeyShortcut } from './gestures';
import { debounce } from './hooks';
import { statusBadge } from './leakView';
import { shallowEqual } from './memo';
import { NO_TRAINING, safeRead } from './safe';

const NOW = Date.UTC(2026, 9, 8, 12);

describe('two-step delete (ConfirmButton)', () => {
  it('a first click only arms it', () => {
    expect(confirmStep(null, NOW, 1)).toBe('arm');
  });
  it('the second click of a double-click, or one right after arming, does nothing', () => {
    expect(confirmStep(NOW, NOW + 120, 2)).toBe('ignore');
    expect(confirmStep(NOW, NOW + 120, 1)).toBe('ignore');
    expect(confirmStep(NOW, NOW + MIN_CONFIRM_MS - 1, 0)).toBe('ignore'); // auto-repeated Enter
  });
  it('a separate click later confirms (mouse or keyboard)', () => {
    expect(confirmStep(NOW, NOW + MIN_CONFIRM_MS, 1)).toBe('confirm');
    expect(confirmStep(NOW, NOW + 2000, 0)).toBe('confirm');
  });
  it('the dialog’s destructive button ignores clicks right after it opened and repeated clicks', () => {
    expect(isDeliberateClick(NOW, NOW + 100, 1)).toBe(false);
    expect(isDeliberateClick(NOW, NOW + 900, 2)).toBe(false);
    expect(isDeliberateClick(NOW, NOW + 900, 1)).toBe(true);
    expect(isDeliberateClick(NOW, NOW + 900, 0)).toBe(true);
  });
  it('names what “Delete all data” removes', () => {
    expect(deleteSummary({ games: 500, leaks: 47, reviews: 6, scouts: 0 })).toEqual([
      'your accounts and profile',
      '500 downloaded games',
      '47 leaks found by the analysis',
      'your training history (6 positions in training)',
      'your settings',
    ]);
    expect(deleteSummary({ games: 0, leaks: 0, reviews: 0, scouts: 2 })).toContain('2 scouted players and their games');
  });
});

describe('app shell', () => {
  it('reads through a failing view with a fallback instead of throwing', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(
      safeRead(() => {
        throw new TypeError('Cannot read properties of null (reading "filter")');
      }, NO_TRAINING),
    ).toBe(NO_TRAINING);
    expect(safeRead(() => 7, 0)).toBe(7);
    err.mockRestore();
  });
  it('moves focus to <main> on a page change, but not between leaks of the Leaks page', () => {
    expect(focusesMain(parseHash('#/'), parseHash('#/leaks'))).toBe(true);
    expect(focusesMain(parseHash('#/leaks'), parseHash('#/leaks/abc'))).toBe(false);
    expect(focusesMain(parseHash('#/leaks/abc'), parseHash('#/leaks/def'))).toBe(false);
    expect(focusesMain(parseHash('#/leaks/abc'), parseHash('#/train?leak=abc'))).toBe(true);
    expect(focusesMain(parseHash('#/leaks'), parseHash('#/leaks?tab=mastered'))).toBe(false);
  });
  it('titles every view', () => {
    expect(pageTitle(parseHash('#/'), { hasProfile: false })).toBe('Chess Analyzer — find and fix your opening mistakes');
    expect(pageTitle(parseHash('#/'), { hasProfile: true })).toBe('Home — Chess Analyzer');
    expect(pageTitle(parseHash('#/leaks'), { hasProfile: true })).toBe('Leaks — Chess Analyzer');
    expect(pageTitle(parseHash('#/leaks/x'), { hasProfile: true, leak: '2…c4??' })).toBe('2…c4?? · Leaks — Chess Analyzer');
    expect(pageTitle(parseHash('#/train?leak=x'), { hasProfile: true })).toBe('Training — Chess Analyzer');
    expect(pageTitle(parseHash('#/scout/p1'), { hasProfile: true, scout: 'Magnus' })).toBe('Magnus · Scout — Chess Analyzer');
    expect(pageTitle(parseHash('#/nope'), { hasProfile: true })).toBe('Page not found — Chess Analyzer');
  });
});

describe('keyboard shortcuts', () => {
  const key = (k: string, extra: Partial<KeyboardEvent> = {}): KeyboardEvent =>
    ({ key: k, defaultPrevented: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, target: null, ...extra }) as KeyboardEvent;

  it('turns the single-character shortcuts off with the setting, and nothing else', () => {
    for (const k of CHARACTER_SHORTCUTS) {
      expect(isKeyShortcut(key(k), true)).toBe(true);
      expect(isKeyShortcut(key(k), false)).toBe(false);
    }
    expect(isKeyShortcut(key('ArrowDown'), false)).toBe(true);
    expect(isKeyShortcut(key('Escape'), false)).toBe(true);
    expect(isKeyShortcut(key('j', { ctrlKey: true }), true)).toBe(false);
  });
  it('steps through the moves with ←/→ on the board or the bare page, and Home/End only on the board', () => {
    expect(stepKey('ArrowRight', false, true)).toBe('forward');
    expect(stepKey('ArrowLeft', true, false)).toBe('back');
    expect(stepKey('End', false, true)).toBeNull(); // the page scrolls to its end instead
    expect(stepKey('Home', true, false)).toBe('start');
    expect(stepKey('End', true, false)).toBe('end');
    expect(stepKey('ArrowRight', false, false)).toBeNull(); // a list row, a button, a tab…
    expect(stepKey('ArrowDown', true, true)).toBeNull();
  });
});

describe('Leaks list', () => {
  it('renders a page of rows, more on request, and always the selected row', () => {
    expect(rowsToRender(570, ROW_PAGE, -1)).toBe(50);
    expect(rowsToRender(570, ROW_PAGE * 2, 3)).toBe(100);
    expect(rowsToRender(570, ROW_PAGE, 212)).toBe(213);
    expect(rowsToRender(12, ROW_PAGE, 5)).toBe(12);
  });
  it('labels the rows of the status tabs', () => {
    expect(statusBadge({ updatedAt: NOW, ignoreReason: 'repertoire' }, 'ignored')).toEqual({ tone: 'neutral', text: 'Your repertoire' });
    expect(statusBadge({ updatedAt: NOW }, 'mastered').tone).toBe('good');
    expect(statusBadge({ updatedAt: NOW, snoozedUntil: NOW }, 'snoozed').text).toMatch(/^Until /);
  });
  it('memoised rows compare their props shallowly', () => {
    const m = {};
    expect(shallowEqual({ m, k: 1, href: '#/leaks/a' }, { m, k: 1, href: '#/leaks/a' })).toBe(true);
    expect(shallowEqual({ m, k: 1 }, { m: {}, k: 1 })).toBe(false);
    expect(shallowEqual<{ m: object; k: number; tab?: string }>({ m, k: 1 }, { m, k: 1, tab: 'mastered' })).toBe(false);
  });
  it('names both leaks after a status change', () => {
    expect(statusToastText('mastered', '2…c4??', '3…Qa5?')).toBe('Marked as mastered. 2…c4?? moved to Mastered. Now showing 3…Qa5?.');
    expect(statusToastText('restore', '2…c4??')).toBe('Back in your active leaks. 2…c4?? moved to Active.');
  });
});

describe('search debounce', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('applies the search once typing pauses, with the last text', () => {
    const apply = vi.fn();
    const d = debounce(apply, 150);
    for (const q of ['N', 'Nx', 'Nxe', 'Nxe4']) {
      d(q);
      vi.advanceTimersByTime(60);
    }
    expect(apply).not.toHaveBeenCalled();
    vi.advanceTimersByTime(150);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith('Nxe4');
  });
  it('flush runs a pending call at once; cancel drops it', () => {
    const apply = vi.fn();
    const d = debounce(apply, 150);
    d('a');
    d.flush();
    expect(apply).toHaveBeenCalledWith('a');
    d('b');
    d.cancel();
    vi.advanceTimersByTime(500);
    expect(apply).toHaveBeenCalledTimes(1);
    d.flush(); // nothing pending
    expect(apply).toHaveBeenCalledTimes(1);
  });
});

describe('Training card (dashboard)', () => {
  it('tells due reviews from new positions and offers one button for both', () => {
    const v = trainCardView({ dueReviews: 5, newAvailable: 5, total: 10 }, { now: NOW, newLater: false });
    expect(v).toEqual({ line: '5 reviews due · 5 new positions', cta: 'Train now (10)' });
    expect(trainCardView({ dueReviews: 1, newAvailable: 0, total: 1 }, { now: NOW, newLater: true }).line).toBe('1 review due');
    expect(trainCardView({ dueReviews: 0, newAvailable: 3, total: 3 }, { now: NOW, newLater: false }).line).toBe('3 new positions');
  });
  it('offers nothing to click when nothing is left today, and says when to come back', () => {
    const v = trainCardView({ dueReviews: 0, newAvailable: 0, total: 0 }, { now: NOW, upcoming: NOW + 3 * 3_600_000, newLater: true });
    expect(v.cta).toBeUndefined();
    expect(v.line).toBe('Nothing to train right now — next review in 3 h; new positions tomorrow.');
    expect(trainCardView({ dueReviews: 0, newAvailable: 0, total: 0 }, { now: NOW, upcoming: NOW + 20_000, newLater: false }).line).toBe(
      'Nothing to train right now — next review in a moment.',
    );
    expect(trainCardView({ dueReviews: 0, newAvailable: 0, total: 0 }, { now: NOW, newLater: false }).line).toBe('Nothing to train right now.');
  });
});
