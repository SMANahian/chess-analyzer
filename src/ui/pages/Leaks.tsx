// Leaks: the repeated mistakes. Desktop: list (tabs, filters) on the left, the selected leak on the
// right. Phones: the list, then a detail screen with back / previous / next (and swipe).
// Keyboard: j/k or ↑/↓ move through the list, ←/→ step through moves, f flips, ? shows help.
import '../styles/features.css';
import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import * as store from '../../state/store';
import type { Color, Mistake } from '../../core/types';
import { EmptyState } from '../components/EmptyState';
import { plural, shortDate } from '../components/format';
import { isShortcut, useSwipe } from '../components/gestures';
import { useAction, useMediaQuery, useNow } from '../components/hooks';
import { Icon } from '../components/Icon';
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

  const mistakes = store.mistakes.value;
  const visible = store.visibleMistakes.value;
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

  const selected = route.id ? store.getMistakeByShortId(route.id) : wide ? rows[0]?.m : undefined;
  const index = selected ? rows.findIndex(r => r.m.id === selected.id) : -1;
  const neighbour = (delta: number): Row | undefined => (index < 0 ? (delta > 0 ? rows[0] : undefined) : rows[index + delta]);
  const go = (row: Row | undefined): void => {
    if (row) navigate(leakHref(row.m.shortId, tab), { replace: wide });
  };

  // After master / ignore / snooze / restore the leak leaves this tab: move on to its neighbour.
  const afterStatusChange = (m: Mistake): void => {
    const i = rows.findIndex(r => r.m.id === m.id);
    const next = rows[i + 1] ?? rows[i - 1];
    navigate(next && next.m.id !== m.id ? leakHref(next.m.shortId, tab) : leakHref(undefined, tab), { replace: true });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!isShortcut(e)) return;
      if (e.key === 'j' || e.key === 'ArrowDown') go(neighbour(1));
      else if (e.key === 'k' || e.key === 'ArrowUp') go(neighbour(-1));
      else if (e.key === 'f') setFlipped(x => !x);
      else if (e.key === '?') setHelp(true);
      else if (e.key === 'Escape' && !wide && route.id) navigate(leakHref(undefined, tab));
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

  const showDetailOnly = !wide && route.id !== undefined;
  const detail = selected ? (
    <LeakDetail
      key={selected.id}
      m={selected}
      view={viewOfMistake(selected, store.filters.value, now)}
      tab={tabOf(selected, now)}
      orientation={flipped ? opposite(selected.color) : selected.color}
      onFlip={() => setFlipped(x => !x)}
      now={now}
      nav={showDetailOnly ? mobileNav(index, rows.length, tab, neighbour(-1), neighbour(1)) : undefined}
      onStatusChange={afterStatusChange}
      onUndo={m => navigate(leakHref(m.shortId, tab), { replace: true })}
    />
  ) : route.id ? (
    <EmptyState
      icon="leaks"
      title="This leak isn’t in your list"
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
              <LeakList rows={rows} tab={tab} selectedId={wide ? selected?.id : undefined} now={now} />
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
  const row = pane?.querySelector<HTMLElement>(`[data-short-id="${shortId}"]`);
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

function LeakList({ rows, tab, selectedId, now }: { rows: Row[]; tab: LeakTab; selectedId?: string; now: number }): JSX.Element {
  if (rows.length === 0) return <ListEmpty tab={tab} now={now} />;
  return (
    <>
      <ol class="leaks-list">
        {rows.map(r => (
          <LeakListItem
            key={r.m.id}
            m={r.m}
            href={leakHref(r.m.shortId, tab)}
            k={r.k}
            n={r.n}
            depth={r.depth}
            parent={r.parent}
            selected={r.m.id === selectedId}
            now={now}
            status={tab === 'active' ? undefined : <StatusLine m={r.m} tab={tab} />}
            action={
              tab === 'active' ? undefined : (
                <button type="button" class="btn btn-sm btn-ghost" onClick={() => void changeStatus(r.m, 'restore')}>
                  Restore
                </button>
              )
            }
          />
        ))}
      </ol>
      {tab === 'active' && store.busy.value ? (
        <p class="small faint leaks-live">
          <Spinner label="" size={14} /> Still analyzing — new leaks appear as they’re found.
        </p>
      ) : null}
    </>
  );
}

function StatusLine({ m, tab }: { m: Mistake; tab: Exclude<LeakTab, 'active'> }): JSX.Element {
  if (tab === 'snoozed') return <span class="badge badge-neutral">Until {shortDate(m.snoozedUntil ?? 0)}</span>;
  if (tab === 'ignored') return <span class="badge badge-neutral">{m.ignoreReason === 'repertoire' ? 'Your repertoire' : 'Ignored'}</span>;
  return <span class="badge badge-good">Mastered {shortDate(m.updatedAt)}</span>;
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
  [['j', '↓'], 'Next leak'],
  [['k', '↑'], 'Previous leak'],
  [['←', '→'], 'Step through the moves'],
  [['Home', 'End'], 'Start of the game / end of the best line'],
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
    </Modal>
  );
}
