// Openings: your repertoire per colour (engine-free, from your games and the openings book) with your
// score and the leaks in each opening, plus the "book choices" — named lines the engine dislikes.
import '../styles/features.css';
import type { JSX } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import * as store from '../../state/store';
import { applyFilters, openingsSummary } from '../../core/filters';
import { loadOpeningBook, type OpeningBook } from '../../core/openings';
import type { Color, Mistake, ViewMistake } from '../../core/types';
import { EmptyState } from '../components/EmptyState';
import { messageOf } from '../components/errors';
import { colorName, describePawnDrop, formatCount, formatPercent, plural } from '../components/format';
import { useNow } from '../components/hooks';
import { Icon } from '../components/Icon';
import { groupFamilies, habitLabel, inOpening, openingFamily, viewOfMistake } from '../components/leakView';
import { ScoreBar } from '../components/ScoreBar';
import { SeverityPill } from '../components/SeverityPill';
import { SkeletonRows } from '../components/Skeleton';
import { TabPanel, Tabs } from '../components/Tabs';
import { href, type PageProps } from '../router';
import { changeStatus } from './LeakDetail';

type BookState = { book: OpeningBook } | { error: string } | null;

/** Families always listed, and the games a family needs to be listed beyond those. */
const MIN_SHOWN = 8;
const TAIL_GAMES = 3;

export default function Openings(_props: PageProps): JSX.Element {
  const [state, setState] = useState<BookState>(null);
  const [attempt, setAttempt] = useState(0);
  const [color, setColor] = useState<Color>(() => (store.games.value.filter(g => g.color === 'black').length > store.games.value.length / 2 ? 'black' : 'white'));
  useEffect(() => {
    let live = true;
    setState(null);
    loadOpeningBook()
      .then(book => live && setState({ book }))
      .catch(err => live && setState({ error: messageOf(err) }));
    return () => {
      live = false;
    };
  }, [attempt]);

  const games = store.games.value;
  const counts = { white: games.filter(g => g.color === 'white').length, black: games.filter(g => g.color === 'black').length };
  return (
    <div class="page openings-page">
      <div class="page-head">
        <div>
          <h1>Openings</h1>
          <p class="page-sub">What you play, how you score, and where your leaks are — from {plural(games.length, 'game')}.</p>
        </div>
      </div>
      {games.length === 0 ? (
        <EmptyState icon="openings" title="No games yet" actions={<a class="btn btn-primary" href={href('home')}>Go to Home</a>}>
          Your repertoire appears here once your games are downloaded.
        </EmptyState>
      ) : (
        <section class="card openings-card" aria-label="Repertoire">
          <Tabs<Color>
            items={(['white', 'black'] as const).map(c => ({ id: c, label: `As ${colorName(c)}`, count: counts[c] }))}
            value={color}
            onChange={setColor}
            label="Colour"
            idPrefix="openings"
          />
          <TabPanel id={color} idPrefix="openings">
            {state === null ? (
              <SkeletonRows rows={6} label="Loading the openings book" />
            ) : 'error' in state ? (
              <EmptyState
                icon="alert"
                title="The openings book didn’t load"
                actions={
                  <button type="button" class="btn" onClick={() => setAttempt(a => a + 1)}>
                    <Icon name="refresh" size={18} /> Try again
                  </button>
                }
              >
                {state.error}
              </EmptyState>
            ) : (
              <Repertoire book={state.book} color={color} total={counts[color]} />
            )}
          </TabPanel>
        </section>
      )}
      <BookChoices />
    </div>
  );
}

function Repertoire({ book, color, total }: { book: OpeningBook; color: Color; total: number }): JSX.Element {
  const now = useNow(60_000);
  const games = store.games.value;
  const plies = store.settings.value.openingPlies;
  const rows = useMemo(() => openingsSummary(games, book, plies), [games, book, plies]);
  const families = useMemo(() => groupFamilies(rows.filter(r => r.color === color)), [rows, color]);
  // Leaks per opening under your filters, ignoring the colour and opening filters (the links set those).
  const leaks = useMemo(
    () => applyFilters(store.mistakes.value, { ...store.filters.value, opening: null, color }, now),
    [store.mistakes.value, store.filters.value, color, now],
  );
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  if (families.length === 0) {
    return (
      <EmptyState icon="openings" title={`No named openings as ${colorName(color)}`}>
        {total === 0 ? `You have no games as ${colorName(color)} yet.` : 'None of these games reach a position named in the openings book.'}
      </EmptyState>
    );
  }
  const named = families.reduce((n, f) => n + f.games, 0);
  // The long tail of openings met once or twice stays folded away.
  const main = families.filter((f, i) => i < MIN_SHOWN || f.games >= TAIL_GAMES);
  const shown = showAll ? families : main;
  const toggle = (name: string): void => {
    const next = new Set(open);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setOpen(next);
  };
  return (
    <div class="rep">
      <table class="rep-table">
        <thead>
          <tr>
            <th scope="col">Opening</th>
            <th scope="col" class="rep-num">
              Games
            </th>
            <th scope="col" class="rep-num">
              Score
            </th>
            <th scope="col" class="rep-num">
              Leaks
            </th>
          </tr>
        </thead>
        <tbody>
          {shown.map(f => {
            const expandable = f.variations.length > 1 || f.variations[0]?.name !== f.name;
            const isOpen = open.has(f.name);
            const family = (
              <OpeningRow
                key={f.name}
                name={f.name}
                eco={f.eco}
                games={f.games}
                score={f.score}
                total={named}
                color={color}
                leaks={countIn(leaks, f.name)}
                expand={expandable ? { open: isOpen, onToggle: () => toggle(f.name), count: f.variations.length } : undefined}
              />
            );
            const variations = isOpen
              ? f.variations.map(v => (
                  <OpeningRow key={`${f.name}|${v.name}`} name={v.name} eco={v.eco} games={v.games} score={v.score} total={named} color={color} leaks={countIn(leaks, v.name)} child />
                ))
              : [];
            return [family, ...variations];
          })}
        </tbody>
      </table>
      {families.length > main.length ? (
        <button type="button" class="link-button small rep-more" onClick={() => setShowAll(x => !x)}>
          {showAll ? 'Show fewer openings' : `Show ${families.length - main.length} more played only once or twice`}
        </button>
      ) : null}
      <p class="tiny faint rep-foot">
        Grouped by the deepest named position within your first {plies / 2} moves. {total > named ? `${formatCount(total - named)} games leave the book before any named position.` : ''}{' '}
        Score = wins + ½ draws. Leaks follow your filters on the Leaks page.
      </p>
    </div>
  );
}

const countIn = (ms: readonly ViewMistake[], name: string): number => ms.filter(m => inOpening(m, name)).length;

interface RowProps {
  name: string;
  eco: string;
  games: number;
  total: number;
  score: number;
  color: Color;
  leaks: number;
  child?: boolean;
  expand?: { open: boolean; onToggle(): void; count: number };
}

function OpeningRow({ name, eco, games, total, score, color, leaks, child, expand }: RowProps): JSX.Element {
  const leaksHref = href('leaks', undefined, { opening: name, color });
  const shown = child ? name.slice(openingFamily(name).length).replace(/^:\s*/, '') || name : name;
  return (
    <tr class={child ? 'rep-child' : 'rep-family'}>
      <th scope="row">
        <span class="rep-name">
          {expand ? (
            <button type="button" class="rep-toggle" aria-expanded={expand.open} aria-label={`${expand.open ? 'Hide' : 'Show'} ${expand.count} variations of ${name}`} onClick={expand.onToggle}>
              <Icon name="chevron" size={16} />
            </button>
          ) : (
            <span class="rep-toggle-space" aria-hidden="true" />
          )}
          <span class="rep-label">
            <a href={leaksHref} class="rep-link">
              {shown}
            </a>
            <span class="rep-eco tiny faint num">{eco}</span>
          </span>
        </span>
      </th>
      <td class="rep-num">
        <span class="num">{formatCount(games)}</span>
        <span class="rep-share tiny faint num">{formatPercent(games / Math.max(1, total))}</span>
      </td>
      <td class="rep-num">
        <ScoreBar score={score} label={`Your score in ${name}`} compact />
      </td>
      <td class="rep-num">
        {leaks > 0 ? (
          <a class="rep-leaks num" href={leaksHref} aria-label={`${plural(leaks, 'leak')} in ${name}`}>
            {leaks}
          </a>
        ) : (
          <span class="faint">—</span>
        )}
      </td>
    </tr>
  );
}

// ── Book choices ────────────────────────────────────────────────────────

function BookChoices(): JSX.Element | null {
  const now = useNow(60_000);
  const all = store.mistakes.value;
  const f = store.filters.value;
  const book = useMemo(() => all.filter(m => m.kind === 'book' && m.status === 'active' && !m.dormant).sort((a, b) => b.impact - a.impact), [all]);
  const repertoire = useMemo(() => all.filter(m => m.status === 'ignored' && m.ignoreReason === 'repertoire'), [all]);
  if (book.length === 0 && repertoire.length === 0) return null;
  return (
    <section class="card book-card" aria-labelledby="book-title">
      <div class="card-head">
        <h2 id="book-title">Book choices</h2>
        <span class="small muted">{plural(book.length, 'line')}</span>
      </div>
      <p class="muted small book-intro">
        Named opening lines the engine dislikes: objectively dubious but a valid club repertoire choice. They stay out of your leaks and
        training. If one is a deliberate part of your repertoire, mark it — it won’t come back.
      </p>
      {book.length > 0 ? (
        <ul class="book-list">
          {book.map(m => (
            <BookItem key={m.id} m={m} view={viewOfMistake(m, f, now)} />
          ))}
        </ul>
      ) : (
        <p class="small muted">No book choices left to review.</p>
      )}
      {repertoire.length > 0 ? (
        <details class="book-rep">
          <summary class="small">Marked as your repertoire ({repertoire.length})</summary>
          <ul class="book-list">
            {repertoire.map(m => (
              <li key={m.id} class="book-item">
                <span class="book-main">
                  <a class="move book-move" href={href('leaks', m.shortId, { tab: 'ignored' })}>
                    {habitLabel(m)}
                  </a>
                  <span class="small muted">{m.openingName ?? 'Unnamed line'}</span>
                </span>
                <button type="button" class="btn btn-sm btn-ghost" onClick={() => void changeStatus(m, 'restore')}>
                  Restore
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function BookItem({ m, view }: { m: Mistake; view: ViewMistake }): JSX.Element {
  return (
    <li class="book-item">
      <SeverityPill severity={m.severity} kind="book" compact />
      <span class="book-main">
        <span class="book-top">
          <a class="move book-move" href={href('leaks', m.shortId)}>
            {habitLabel(m)}
          </a>
          <span class="small muted num">
            {view.viewCount} of {plural(view.viewPositionCount, 'game')}
          </span>
        </span>
        <span class="small muted">
          {m.openingName ?? 'Unnamed line'} · as {colorName(m.color)} · costs about {Math.round(m.winLoss)}% ({describePawnDrop(m.scoreBest, m.scorePlayed)})
        </span>
      </span>
      <button type="button" class="btn btn-sm" onClick={() => void changeStatus(m, 'repertoire')}>
        <Icon name="check" size={16} /> It’s my repertoire
      </button>
    </li>
  );
}
