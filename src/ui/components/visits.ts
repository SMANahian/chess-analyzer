// "Since your last visit": remembers when the app was last opened (per browser, localStorage).
// A visit is a session start at least SESSION_GAP after the previous one, so reloads and quick
// re-opens do not reset the comparison point.

export const VISITS_KEY = 'ca:visits';
export const SESSION_GAP_MS = 6 * 60 * 60 * 1000;

export interface VisitState {
  /** Start of the previous visit (0 = first visit). */
  previous: number;
  /** Start of the current visit. */
  current: number;
}

/** Pure transition for opening the app at `now`. */
export function nextVisitState(state: VisitState | undefined, now: number, gapMs: number = SESSION_GAP_MS): VisitState {
  if (!state) return { previous: 0, current: now };
  if (now - state.current >= gapMs) return { previous: state.current, current: now };
  return state;
}

function parse(raw: string | null): VisitState | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as Partial<VisitState>;
    return typeof v.previous === 'number' && typeof v.current === 'number' ? { previous: v.previous, current: v.current } : undefined;
  } catch {
    return undefined;
  }
}

let cached: VisitState | undefined;

/** Records this app start (once per page load) and returns the visit state. Works without storage. */
export function recordVisit(now: number): VisitState {
  if (cached) return cached;
  let stored: VisitState | undefined;
  try {
    stored = parse(localStorage.getItem(VISITS_KEY));
  } catch {
    stored = undefined;
  }
  cached = nextVisitState(stored, now);
  try {
    localStorage.setItem(VISITS_KEY, JSON.stringify(cached));
  } catch {
    // Storage unavailable: "since your last visit" simply stays empty.
  }
  return cached;
}
