// Leaks: the repeated mistakes. Desktop: list (tabs, filters) on the left, the selected leak on the
// right. Phones: the list, then a detail screen with back / previous / next (and swipe).
// Keyboard: the list is one Tab stop (↑/↓ move between rows; on wide screens they also select), ←/→
// step through the moves (board focused, or nothing focused), and — unless turned off in Settings —
// j/k next/previous leak, f flips, ? shows help.
import '../styles/features.css';
import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import * as store from '../../state/store';
import type { Color, Mistake } from '../../core/types';
import { EmptyState } from '../components/EmptyState';
import { formatCount, plural } from '../components/format';
import { isKeyShortcut, useSwipe } from '../components/gestures';
import { useAction, useMediaQuery, useNow } from '../components/hooks';
import { Icon } from '../components/Icon';
import { shortcutsOn } from '../components/keyboard';
import { LeakFilters } from '../components/LeakFilters';
import { LeakListItem } from '../components/LeakListItem';
import {
  clearedFilters,
  groupByParent,
  parseLeakTab,
  sinceNeedsReanchor,
  sinceForMonths,
  monthsOfSince,
  tabList,
  tabOf,
  viewOfMistake,
  type LeakTab,
} from '../components/leakView';
import { Modal } from '../components/Modal';
import { ProgressCard } from '../components/ProgressCard';
import { SkeletonRows } from '../components/Skeleton';
import { Spinner } from '../components/Spinner';
import { TabPanel, Tabs } from '../components/Tabs';
import { href, navigate, type PageProps, type Route } from '../router';
import { NoGames } from './Dashboard';
import { changeStatus, LeakDetail, type LeakNav } from './LeakDetail';

const WIDE = '(min-width: 960px)';
/** Rows rendered at first (and added by "Show more"); the selected row is always rendered. */
export const ROW_PAGE = 50;
const TAB_LABEL: Readonly<Record<LeakTab, string>> = { active: 'Active', mastered: 'Mastered', ignored: 'Ignored', snoozed: 'Snoozed' };

interface Row {
  m: Mistake;
  k: number;
  n: number;
  depth: number;
  parent?: Mistake;
}

const leakHref = (shortId: string | undefined, tab: LeakTab): string => href('leaks', shortId, tab === 'active' ? undefined : { tab });
const opposite = (c: Color): Color => (c === 'white' ? 'black' : 'white');
/** Stable (module-level), so memoised rows are not re-rendered for a new handler. */
const restoreFromList = (m: Mistake): void => void changeStatus(m, 'restore');

const rowElement = (shortId: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`.leaks-list [data-short-id="${CSS.escape(shortId)}"]`);
const detailHeading = (): HTMLElement | null => document.getElementById('ld-title');
const focusIsIdle = (): boolean => {
  const a = document.activeElement;
  return !a || a === document.body || a === document.documentElement;
};

/** How many rows to render: a page at a time, and always far enough to include the selected row. */
export function rowsToRender(total: number, limit: number, selectedIndex: number): number {
  return Math.min(total, Math.max(limit, selectedIndex + 1));
}

/** `#/leaks?opening=…&color=…` (from the Openings page) sets the filters, then the URL is cleaned. */
function useQueryFilters(route: Route): void {
  const { opening, color } = route.query;
  useEffect(() => {
    if (opening === undefined && color === undefined) return;
    store.setFilters({
      ...(opening !== undefined ? { opening: opening || null } : {}),
      ...(color === 'white' || color === 'black' || color === 'both' ? { color } : {}),
    });
    const rest = { ...route.query, opening: undefined, color: undefined };
    navigate(href('leaks', route.id, rest), { replace: true });
  }, [opening, color]);
}

/**
 * Phones: the list keeps its scroll position across a visit to a leak's screen (the router scrolls
 * new paths to the top). The listener is removed before the router's scroll event is delivered.
 */
function useListScrollMemory(active: boolean): void {
  const saved = useRef(0);
  useEffect(() => {
    if (!active) return;
    if (saved.current > 0) window.scrollTo(0, saved.current);
    const onScroll = (): void => {
      saved.current = window.scrollY;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [active]);
}

/** A "last N months" filter is a rolling window: move a stored date that has drifted. */
function useRollingSince(now: number): void {
  const since = store.filters.value.since;
  useEffect(() => {
    if (sinceNeedsReanchor(since, now)) store.setFilters({ since: sinceForMonths(monthsOfSince(since, now), now) });
  }, [since, now]);
}

function rowsFor(tab: LeakTab, now: number): Row[] {
  const all = store.mistakes.value;
  if (tab === 'active') {
    return groupByParent(store.visibleMistakes.value, all).map(e => ({ m: e.m, k: e.m.viewCount, n: e.m.viewPositionCount, depth: e.depth, parent: e.parent }));
  }
  return tabList(all, tab, now).map(m => ({ m, k: m.count, n: m.positionCount, depth: 0 }));
}

export default function Leaks({ route }: PageProps): JSX.Element {
  const now = useNow(60_000);
  const wide = useMediaQuery(WIDE);
  const tab = parseLeakTab(route.query.tab);
  useQueryFilters(route);
  useRollingSince(now);
  useListScrollMemory(!wide && route.id === undefined);
  const [flipped, setFlipped] = useState(false);
  const [help, setHelp] = useState(false);
  const [limit, setLimit] = useState(ROW_PAGE);
  /** Phones: the row that holds the list's Tab stop (the last one focused or visited). */
  const [cursorId, setCursorId] = useState<string | null>(null);

  const mistakes = store.mistakes.value;
  const visible = store.visibleMistakes.value;
  const filters = store.filters.value;
  const rows = useMemo(() => rowsFor(tab, now), [tab, now, mistakes, visible]);
  const counts = useMemo(
    () => ({
      active: visible.length,
      mastered: tabList(mistakes, 'mastered', now).length,
      ignored: tabList(mistakes, 'ignored', now).length,
      snoozed: tabList(mistakes, 'snoozed', now).length,
    }),
    [mistakes, visible, now],
  );
  // A new filter or tab starts from the top of the list again.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) firstRender.current = false;
    else setLimit(ROW_PAGE);
  }, [filters, tab]);

  const selected = route.id ? store.getMistakeByShortId(route.id) : wide ? rows[0]?.m : undefined;
  const index = selected ? rows.findIndex(r => r.m.id === selected.id) : -1;
  const neighbour = (delta: number): Row | undefined => (index < 0 ? (delta > 0 ? rows[0] : undefined) : rows[index + delta]);
  const go = (row: Row | undefined): void => {
    if (row) navigate(leakHref(row.m.shortId, tab), { replace: wide });
  };
  const showDetailOnly = !wide && route.id !== undefined;
  const shown = rowsToRender(rows.length, limit, index);
  const tabStopId = wide ? (selected?.id ?? rows[0]?.m.id) : rows.some(r => r.m.id === cursorId) ? cursorId : rows[0]?.m.id;

  /** ↑/↓ (and j/k on the list): the next row gets focus; on wide screens it is also selected. */
  const moveInList = (fromShortId: string | undefined, delta: 1 | -1): void => {
    const from = fromShortId === undefined ? -1 : rows.findIndex(r => r.m.shortId === fromShortId);
    const next = from < 0 ? (delta > 0 ? rows[0] : undefined) : rows[from + delta];
    if (!next) return;
    const at = rows.indexOf(next);
    if (at >= shown) setLimit(l => Math.max(l, at + 1));
    setCursorId(next.m.id);
    if (wide) go(next);
    // At once when the row is rendered (fast repeated presses each move one row), else once it is.
    const focusRow = (): void => {
      rowElement(next.m.shortId)?.focus({ preventScroll: wide });
      if (wide) revealRow(next.m.shortId);
    };
    if (rowElement(next.m.shortId)) focusRow();
    else requestAnimationFrame(focusRow);
  };

  // After master / ignore / snooze / restore the leak leaves this tab: move on to its neighbour.
  const afterStatusChange = (m: Mistake, viaKeyboard: boolean): Mistake | undefined => {
    const i = rows.findIndex(r => r.m.id === m.id);
    const candidate = rows[i + 1] ?? rows[i - 1];
    const next = candidate && candidate.m.id !== m.id ? candidate.m : undefined;
    navigate(next ? leakHref(next.shortId, tab) : leakHref(undefined, tab), { replace: true });
    requestAnimationFrame(() => {
      // Phones: the next leak opens at the top with its title in view (a replace navigation keeps the scroll).
      if (!wide) window.scrollTo({ top: 0 });
      // From the keyboard, focus goes to the toast's Undo; otherwise to the leak now shown.
      if (!viaKeyboard) detailHeading()?.focus({ preventScroll: true });
    });
    return next;
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!isKeyShortcut(e, shortcutsOn.value)) return;
      const target = e.target instanceof Element ? e.target : null;
      const row = target?.closest<HTMLElement>('.leaks-list [data-short-id]');
      const listOnly = !wide && !showDetailOnly;
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && row) moveInList(row.dataset.shortId, e.key === 'ArrowDown' ? 1 : -1);
      else if (e.key === 'j' || e.key === 'k') {
        const delta = e.key === 'j' ? 1 : -1;
        // On the phone list, j/k only move the focus: they never open a leak's screen.
        if (listOnly || row) moveInList(row?.dataset.shortId ?? rows.find(r => r.m.id === tabStopId)?.m.shortId, delta);
        else go(neighbour(delta));
      } else if (e.key === 'f') setFlipped(x => !x);
      else if (e.key === '?') setHelp(true);
      else if (e.key === 'Escape' && showDetailOnly) navigate(leakHref(undefined, tab));
      else return;
      e.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  // Keep the selected row visible in the list pane (without scrolling the page).
  useEffect(() => {
    if (!wide || !selected) return;
    const id = requestAnimationFrame(() => revealRow(selected.shortId));
    return () => cancelAnimationFrame(id);
  }, [selected?.id, wide]);

  // Phones: opening a leak puts focus on its title (the row that had it is gone); coming back to the
  // list puts it on the row of the leak just seen.
  const previousId = useRef<string | undefined>(route.id);
  useEffect(() => {
    const before = previousId.current;
    previousId.current = route.id;
    if (wide || before === route.id) return;
    if (route.id !== undefined) {
      const pane = document.querySelector('.leaks-detail-pane');
      if (!pane?.contains(document.activeElement)) detailHeading()?.focus({ preventScroll: true });
      return;
    }
    if (before === undefined) return;
    const seen = store.getMistakeByShortId(before);
    if (seen) setCursorId(seen.id);
    requestAnimationFrame(() => {
      if (focusIsIdle() || document.activeElement === document.getElementById('main')) rowElement(before)?.focus({ preventScroll: true });
    });
  }, [route.id, wide]);

  const detail = selected ? (
    <LeakDetail
      key="detail"
      m={selected}
      view={viewOfMistake(selected, filters, now)}
      tab={tabOf(selected, now)}
      orientation={flipped ? opposite(selected.color) : selected.color}
      onFlip={() => setFlipped(x => !x)}
      now={now}
      nav={showDetailOnly ? mobileNav(index, rows.length, tab, neighbour(-1), neighbour(1)) : undefined}
      headingLevel={showDetailOnly ? 1 : 2}
      onStatusChange={afterStatusChange}
      onUndo={m => navigate(leakHref(m.shortId, tab), { replace: true })}
    />
  ) : route.id ? (
    <EmptyState
      icon="leaks"
      title="This leak isn’t in your list"
      headingLevel={showDetailOnly ? 1 : 2}
      actions={
        <a class="btn" href={leakHref(undefined, tab)}>
          See all leaks
        </a>
      }
    >
      It may have been removed by a newer analysis, or the link is from another browser.
    </EmptyState>
  ) : null;

  return (
    <div class={`page leaks-page${showDetailOnly ? ' is-detail' : ''}`}>
      {showDetailOnly ? null : <LeaksHead count={visible.length} onHelp={wide ? () => setHelp(true) : undefined} />}
      {showDetailOnly ? null : <SelfProgress />}
      <div class="leaks-layout">
        {showDetailOnly ? null : (
          <aside class="leaks-list-pane" aria-label="Leak list">
            <Tabs<LeakTab>
              items={(['active', 'mastered', 'ignored', 'snoozed'] as const).map(id => ({ id, label: TAB_LABEL[id], count: id === 'active' || counts[id] > 0 ? counts[id] : undefined }))}
              value={tab}
              onChange={t => navigate(leakHref(undefined, t), { replace: true })}
              label="Leak status"
              idPrefix="leaks"
            />
            <TabPanel id={tab} idPrefix="leaks">
              {tab === 'active' ? <LeakFilters now={now} /> : null}
              <LeakList
                rows={rows}
                shown={shown}
                tab={tab}
                selectedId={wide ? selected?.id : undefined}
                tabStopId={tabStopId ?? undefined}
                now={now}
                onMore={() => setLimit(l => l + ROW_PAGE)}
              />
            </TabPanel>
          </aside>
        )}
        {wide || showDetailOnly ? (
          <SwipeArea enabled={showDetailOnly} onNext={() => go(neighbour(1))} onPrev={() => go(neighbour(-1))}>
            {detail ?? <NothingSelected tab={tab} />}
          </SwipeArea>
        ) : null}
      </div>
      <ShortcutsHelp open={help} onClose={() => setHelp(false)} />
    </div>
  );
}

/** Scrolls the list pane (only) so the row is visible below its sticky tabs. */
function revealRow(shortId: string): void {
  const pane = document.querySelector<HTMLElement>('.leaks-list-pane');
  const row = pane?.querySelector<HTMLElement>(`[data-short-id="${CSS.escape(shortId)}"]`);
  if (!pane || !row) return;
  const top = pane.getBoundingClientRect().top + (pane.querySelector('.tabs')?.getBoundingClientRect().height ?? 0) + 8;
  const bottom = pane.getBoundingClientRect().bottom - 8;
  const r = row.getBoundingClientRect();
  if (r.top < top) pane.scrollTop -= top - r.top;
  else if (r.bottom > bottom) pane.scrollTop += r.bottom - bottom;
}

function mobileNav(index: number, total: number, tab: LeakTab, prev: Row | undefined, next: Row | undefined): LeakNav {
  return {
    back: leakHref(undefined, tab),
    prev: prev ? leakHref(prev.m.shortId, tab) : undefined,
    next: next ? leakHref(next.m.shortId, tab) : undefined,
    position: index >= 0 ? `${index + 1} of ${total}` : undefined,
  };
}

function SwipeArea({ enabled, onNext, onPrev, children }: { enabled: boolean; onNext(): void; onPrev(): void; children: JSX.Element }): JSX.Element {
  const ref = useSwipe<HTMLElement>({ onLeft: onNext, onRight: onPrev }, enabled);
  return (
    <section class="leaks-detail-pane" ref={ref} aria-label="Selected leak">
      {children}
    </section>
  );
}

function LeaksHead({ count, onHelp }: { count: number; onHelp?: () => void }): JSX.Element {
  const games = store.games.value.length;
  return (
    <div class="page-head">
      <div>
        <h1>Leaks</h1>
        <p class="page-sub">
          {plural(count, 'repeated mistake')} in {plural(games, 'game')} · the moves you keep playing that cost you
        </p>
      </div>
      {onHelp ? (
        <button type="button" class="btn btn-ghost btn-sm" onClick={onHelp}>
          <Icon name="keyboard" size={18} /> Shortcuts
        </button>
      ) : null}
    </div>
  );
}

/** Progress of the self profile's job only (a scout analysis has its own page). */
function SelfProgress(): JSX.Element | null {
  const self = store.selfProfile.value;
  const job = store.analysisProgress.value?.profileId ?? store.syncProgress.value?.profileId;
  if (!self || (job !== undefined && job !== self.id)) return null;
  return <ProgressCard showFinished={false} />;
}

function LeakList({
  rows,
  shown,
  tab,
  selectedId,
  tabStopId,
  now,
  onMore,
}: {
  rows: Row[];
  shown: number;
  tab: LeakTab;
  selectedId?: string;
  tabStopId?: string;
  now: number;
  onMore(): void;
}): JSX.Element {
  if (rows.length === 0) return <ListEmpty tab={tab} now={now} />;
  const status = tab === 'active' ? undefined : tab;
  const left = rows.length - shown;
  return (
    <>
      <ol class="leaks-list">
        {rows.slice(0, shown).map(r => (
          <LeakListItem
            key={r.m.id}
            m={r.m}
            href={leakHref(r.m.shortId, tab)}
            k={r.k}
            n={r.n}
            depth={r.depth}
            parent={r.parent}
            selected={r.m.id === selectedId}
            tabbable={r.m.id === tabStopId}
            now={now}
            tab={status}
            onRestore={status ? restoreFromList : undefined}
          />
        ))}
      </ol>
      {left > 0 ? (
        <button type="button" class="btn btn-ghost btn-block leaks-more" onClick={onMore}>
          Show {Math.min(left, ROW_PAGE)} more <span class="faint num">· {formatCount(left)} not shown</span>
        </button>
      ) : null}
      {tab === 'active' && store.busy.value ? (
        <p class="small faint leaks-live">
          <Spinner label="" size={14} /> Still analyzing — new leaks appear as they’re found.
        </p>
      ) : null}
    </>
  );
}

function ListEmpty({ tab, now }: { tab: LeakTab; now: number }): JSX.Element {
  const [run, pending] = useAction();
  const self = store.selfProfile.value;
  if (tab === 'mastered') {
    return (
      <EmptyState icon="check" title="Nothing mastered yet">
        When you know the right move cold, mark the leak as mastered and it leaves your list.
      </EmptyState>
    );
  }
  if (tab === 'ignored') {
    return (
      <EmptyState icon="openings" title="Nothing ignored">
        Lines you play on purpose (“This is my repertoire”) are kept here, out of your way.
      </EmptyState>
    );
  }
  if (tab === 'snoozed') {
    return (
      <EmptyState icon="clock" title="Nothing snoozed">
        Snooze a leak to hide it for 30 days — handy when you’re working on other things first.
      </EmptyState>
    );
  }
  if (store.busy.value && store.mistakes.value.length === 0) {
    return (
      <div class="stack-sm">
        <p class="row muted small">
          <Spinner label="" size={16} /> Looking for leaks — they appear here as they’re found.
        </p>
        <SkeletonRows rows={4} label="Looking for leaks" />
      </div>
    );
  }
  if (store.mistakes.value.some(m => tabOf(m, now) === 'active')) {
    return (
      <EmptyState
        icon="filter"
        title="No leaks match these filters"
        actions={
          <button type="button" class="btn" onClick={() => store.setFilters(clearedFilters(store.filters.value))}>
            Clear filters
          </button>
        }
      >
        Try more time controls, a longer date range or fewer games.
      </EmptyState>
    );
  }
  if (store.games.value.length === 0) return <NoGames />;
  if (!self?.lastAnalysisAt) {
    return (
      <EmptyState
        icon="leaks"
        title="Not analyzed yet"
        actions={
          <button type="button" class="btn btn-primary" disabled={pending || store.busy.value} onClick={() => void run(() => store.refresh())}>
            Analyze my games
          </button>
        }
      >
        Download your games and let Stockfish look for the mistakes you repeat.
      </EmptyState>
    );
  }
  return (
    <EmptyState
      icon="check"
      tone="success"
      title="No repeated mistakes found"
      actions={
        <a class="btn" href={href('settings')}>
          Analysis settings
        </a>
      }
    >
      None of the moves you played in two or more games costs 5% or more. Add games or analyze more moves per game to dig
      deeper.
    </EmptyState>
  );
}

function NothingSelected({ tab }: { tab: LeakTab }): JSX.Element {
  return (
    <div class="ld-placeholder">
      <Icon name="leaks" size={32} />
      <p class="muted">{tab === 'active' ? 'Pick a leak to see the position and how to fix it.' : 'Pick a leak to see it.'}</p>
    </div>
  );
}

const SHORTCUTS: readonly [string[], string][] = [
  [['↓', '↑'], 'Next / previous leak (in the list)'],
  [['j', 'k'], 'Next / previous leak'],
  [['←', '→'], 'Step through the moves (board focused, or nothing focused)'],
  [['Home', 'End'], 'Start of the game / end of the best line (board focused)'],
  [['f'], 'Flip the board'],
  [['?'], 'This help'],
];

function ShortcutsHelp({ open, onClose }: { open: boolean; onClose(): void }): JSX.Element {
  return (
    <Modal open={open} onClose={onClose} title="Keyboard shortcuts">
      <dl class="shortcuts">
        {SHORTCUTS.map(([keys, what]) => (
          <div key={what} class="shortcut">
            <dt>
              {keys.map((k, i) => (
                <span key={k}>
                  {i > 0 ? <span class="faint"> / </span> : null}
                  <kbd>{k}</kbd>
                </span>
              ))}
            </dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
      <p class="small muted shortcuts-note">
        The single-key shortcuts (j, k, f, ?) can be turned off in <a href={href('settings')}>Settings → Appearance</a>.
      </p>
    </Modal>
  );
}
