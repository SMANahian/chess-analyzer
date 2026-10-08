// Filter bar for the Leaks list: search, colour and sort inline; everything else in a "Filters"
// dialog (a bottom sheet on phones). Every change applies live through store.setFilters.
import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import * as store from '../../state/store';
import { DEFAULT_FILTERS, type Severity, type Speed, type ViewFilters } from '../../core/types';
import { Segmented, Toggle } from './forms';
import { formatCount, plural, speedName } from './format';
import { debounce } from './hooks';
import { Icon } from './Icon';
import {
  RANGE_MONTHS,
  clearedFilters,
  filterChips,
  monthsOfSince,
  openingOptions,
  sinceForMonths,
  toggleSpeed,
  type RangeMonths,
} from './leakView';
import { Modal } from './Modal';

const SORTS: readonly { value: ViewFilters['sort']; label: string }[] = [
  { value: 'impact', label: 'Biggest impact' },
  { value: 'frequency', label: 'Most frequent' },
  { value: 'loss', label: 'Worst loss' },
  { value: 'recent', label: 'Most recent' },
  { value: 'due', label: 'Due for review' },
];
const SEVERITIES: readonly { value: Severity; label: string }[] = [
  { value: 'inaccuracy', label: '?! and worse' },
  { value: 'mistake', label: '? and ??' },
  { value: 'blunder', label: '?? only' },
];
const RANGE_LABEL: Readonly<Record<RangeMonths, string>> = { 0: 'All time', 3: '3 months', 6: '6 months', 12: '12 months' };
const MIN_GAMES = [2, 3, 4, 5, 6, 8, 10] as const;
const SPEED_ORDER: readonly Speed[] = DEFAULT_FILTERS.speeds;
/** The search applies (and is saved) once typing pauses this long, not on every keystroke. */
export const SEARCH_DEBOUNCE_MS = 150;

/** Speeds that occur in the player's games (always at least one, so the chips never vanish). */
function presentSpeeds(): Speed[] {
  const seen = new Set(store.games.value.map(g => g.speed));
  const list = SPEED_ORDER.filter(s => seen.has(s));
  return list.length > 0 ? list : ['blitz'];
}

export function LeakFilters({ now }: { now: number }): JSX.Element {
  const f = store.filters.value;
  const [open, setOpen] = useState(false);
  const present = useMemo(presentSpeeds, [store.games.value]);
  const chips = filterChips(f, present, now);
  return (
    <div class="leak-filters">
      <div class="lf-row">
        <SearchBox query={f.query} />
        <button type="button" class="btn lf-more" onClick={() => setOpen(true)} aria-haspopup="dialog">
          <Icon name="filter" size={18} />
          Filters
          {chips.length > 0 ? <span class="lf-badge num">{chips.length}</span> : null}
        </button>
      </div>
      <div class="lf-row">
        <Segmented<ViewFilters['color']>
          label="Colour"
          hideLabel
          options={[
            { value: 'both', label: 'Both' },
            { value: 'white', label: 'White' },
            { value: 'black', label: 'Black' },
          ]}
          value={f.color}
          onChange={color => store.setFilters({ color })}
        />
        <label class="lf-sort">
          <span class="sr-only">Sort by</span>
          <select class="select" value={f.sort} onChange={e => store.setFilters({ sort: e.currentTarget.value as ViewFilters['sort'] })}>
            {SORTS.map(s => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {chips.length > 0 ? (
        <div class="lf-chips" role="group" aria-label="Active filters">
          {chips.map(c => (
            <span key={c} class="chip">
              {c}
            </span>
          ))}
          <button type="button" class="link-button small" onClick={() => store.setFilters(clearedFilters(f))}>
            Clear filters
          </button>
        </div>
      ) : null}
      <FilterDialog open={open} onClose={() => setOpen(false)} f={f} present={present} now={now} />
    </div>
  );
}

/** The text search: shown as typed, applied to the list once typing pauses (SEARCH_DEBOUNCE_MS). */
function SearchBox({ query }: { query: string }): JSX.Element {
  const [text, setText] = useState(query);
  const typing = useRef(false);
  const apply = useMemo(
    () =>
      debounce((q: string) => {
        typing.current = false;
        store.setFilters({ query: q });
      }, SEARCH_DEBOUNCE_MS),
    [],
  );
  useEffect(() => () => apply.flush(), [apply]);
  // A query changed elsewhere (cleared, or restored) shows here unless the user is typing.
  useEffect(() => {
    if (!typing.current) setText(query);
  }, [query]);
  return (
    <label class="lf-search">
      <span class="sr-only">Search leaks</span>
      <Icon name="search" size={18} class="lf-search-icon" />
      <input
        class="input"
        type="search"
        placeholder="Search"
        title="Search by move (Nxe4) or opening name"
        value={text}
        onInput={e => {
          typing.current = true;
          setText(e.currentTarget.value);
          apply(e.currentTarget.value);
        }}
      />
    </label>
  );
}

function FilterDialog({ open, onClose, f, present, now }: { open: boolean; onClose(): void; f: ViewFilters; present: readonly Speed[]; now: number }): JSX.Element {
  const shown = store.visibleMistakes.value.length;
  const openings = useMemo(() => openingOptions(store.mistakes.value.filter(m => m.status === 'active')), [store.mistakes.value]);
  const months = monthsOfSince(f.since, now);
  const speedOn = (s: Speed): boolean => f.speeds.length === 0 || f.speeds.includes(s);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Filter leaks"
      variant="sheet"
      actions={
        <>
          <button type="button" class="btn btn-ghost" onClick={() => store.setFilters(clearedFilters(f))}>
            Reset
          </button>
          <button type="button" class="btn btn-primary" onClick={onClose}>
            Show {plural(shown, 'leak')}
          </button>
        </>
      }
    >
      <div class="stack lf-dialog">
        <fieldset class="lf-group">
          <legend class="field-label">Time controls</legend>
          <div class="lf-speed-chips">
            {present.map(s => (
              <button
                key={s}
                type="button"
                class="chip chip-toggle"
                aria-pressed={speedOn(s)}
                onClick={() => store.setFilters({ speeds: toggleSpeed(f.speeds, s, present) })}
              >
                {speedOn(s) ? <Icon name="check" size={14} strokeWidth={2.4} /> : null}
                {speedName(s)}
              </button>
            ))}
          </div>
        </fieldset>
        <Segmented<string>
          label="Games played in"
          options={RANGE_MONTHS.map(m => ({ value: String(m), label: RANGE_LABEL[m] }))}
          value={String(months)}
          onChange={v => store.setFilters({ since: sinceForMonths(Number(v) as RangeMonths, now) })}
        />
        <Segmented<Severity>
          label="Severity"
          options={SEVERITIES}
          value={f.minSeverity}
          onChange={minSeverity => store.setFilters({ minSeverity })}
        />
        <div class="lf-two">
          <label class="field">
            <span class="field-label">Played in at least</span>
            <select class="select" value={String(f.minGames)} onChange={e => store.setFilters({ minGames: Number(e.currentTarget.value) })}>
              {MIN_GAMES.map(n => (
                <option key={n} value={String(n)}>
                  {n} games
                </option>
              ))}
            </select>
          </label>
          <label class="field">
            <span class="field-label">Opening</span>
            <select class="select" value={f.opening ?? ''} onChange={e => store.setFilters({ opening: e.currentTarget.value || null })}>
              <option value="">All openings</option>
              {f.opening && !openings.some(o => o.value === f.opening) ? <option value={f.opening}>{f.opening}</option> : null}
              {openings.map(o => (
                <option key={o.value} value={o.value}>
                  {o.value} ({formatCount(o.count)})
                </option>
              ))}
            </select>
          </label>
        </div>
        <Toggle checked={f.ratedOnly} onChange={ratedOnly => store.setFilters({ ratedOnly })} label="Rated games only" />
        <Toggle
          checked={f.showLowConfidence}
          onChange={showLowConfidence => store.setFilters({ showLowConfidence })}
          label="Show borderline leaks"
          hint="Moves losing 5–7.5% winning chances. At this size the engine’s verdict can flip, so they’re hidden by default."
        />
        <Toggle
          checked={f.showBook}
          onChange={showBook => store.setFilters({ showBook })}
          label="Show book choices"
          hint="Named opening lines the engine dislikes (gambits and the like). Also listed on the Openings page."
        />
      </div>
    </Modal>
  );
}
