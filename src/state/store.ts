// App state (signals) + actions. The UI imports only this module and pure helpers from core/.
//
// STUB: signatures are final (see docs/CONTRACTS.md "state/store.ts"); the services agent replaces
// the bodies. Keep exported names and types stable — the UI is written against them.
import { computed, signal, type ReadonlySignal, type Signal } from '@preact/signals';
import {
  DEFAULT_FILTERS,
  DEFAULT_SETTINGS,
  type Account,
  type AnalysisProgress,
  type Color,
  type Grade,
  type Mistake,
  type MistakeStatus,
  type MoveVerdict,
  type Profile,
  type ReviewState,
  type SessionCard,
  type Settings,
  type StoredGame,
  type SyncProgress,
  type ViewFilters,
  type ViewMistake,
} from '../core/types';

const NOT_IMPLEMENTED = (): never => {
  throw new Error('store: not implemented yet');
};

export type Notice = {
  kind: 'info' | 'error' | 'success';
  text: string;
  action?: { label: string; run(): void };
};

export const ready: Signal<boolean> = signal(false);
export const settings: Signal<Settings> = signal(DEFAULT_SETTINGS);
export const filters: Signal<ViewFilters> = signal(DEFAULT_FILTERS);
export const profiles: Signal<Profile[]> = signal([]);
export const selfProfile: ReadonlySignal<Profile | null> = computed(
  () => profiles.value.find(p => p.kind === 'self') ?? null,
);
export const scoutProfiles: ReadonlySignal<Profile[]> = computed(() => profiles.value.filter(p => p.kind === 'opponent'));
/** Self profile's mistakes, all statuses. */
export const mistakes: Signal<Mistake[]> = signal([]);
/** Self profile's active mistakes under the current view filters, sorted. */
export const visibleMistakes: ReadonlySignal<ViewMistake[]> = computed(() => []);
export const reviews: Signal<Map<string, ReviewState>> = signal(new Map());
/** Self profile's games (for stats and the Openings page). */
export const games: Signal<StoredGame[]> = signal([]);
export const syncProgress: Signal<SyncProgress | null> = signal(null);
export const analysisProgress: Signal<AnalysisProgress | null> = signal(null);
export const busy: ReadonlySignal<boolean> = computed(
  () => syncProgress.value?.phase === 'running' || ['preparing', 'evaluating'].includes(analysisProgress.value?.phase ?? ''),
);
/** Another tab holds the job lock. */
export const otherTabBusy: Signal<boolean> = signal(false);
export const notice: Signal<Notice | null> = signal(null);
/** Non-null when a new app version is waiting; call it to reload into the update. */
export const updateAvailable: Signal<null | (() => void)> = signal(null);
/** Cards due now (self profile, default filters). */
export const dueCount: ReadonlySignal<number> = computed(() => 0);

export function init(): Promise<void> {
  return NOT_IMPLEMENTED();
}
/** Validates the accounts exist, creates/updates the self profile and starts refresh(). */
export function setupSelf(_accounts: Account[]): Promise<Profile> {
  return NOT_IMPLEMENTED();
}
export function updateSelfAccounts(_accounts: Account[]): Promise<void> {
  return NOT_IMPLEMENTED();
}
export function addScout(_input: { name?: string; accounts: Account[] }): Promise<Profile> {
  return NOT_IMPLEMENTED();
}
export function removeProfile(_id: string): Promise<void> {
  return NOT_IMPLEMENTED();
}
/** Sync then analyse (self profile by default). First run: newest 300 → analyse → backfill → analyse. */
export function refresh(_profileId?: string): Promise<void> {
  return NOT_IMPLEMENTED();
}
export function analyze(_profileId?: string): Promise<void> {
  return NOT_IMPLEMENTED();
}
/** Scan a PGN file's player names (for "Which of these is you?"). */
export function scanPgn(_file: Blob): Promise<{ name: string; games: number }[]> {
  return NOT_IMPLEMENTED();
}
export function importPgn(_file: Blob, _opts: { aliases?: string[]; asColor?: Color; profileId?: string }): Promise<void> {
  return NOT_IMPLEMENTED();
}
export function cancelJobs(): void {
  NOT_IMPLEMENTED();
}
export function setMistakeStatus(
  _id: string,
  _status: MistakeStatus,
  _opts?: { reason?: 'repertoire' | 'other'; snoozeDays?: number },
): Promise<void> {
  return NOT_IMPLEMENTED();
}
export function updateSettings(_patch: Partial<Settings>): Promise<void> {
  return NOT_IMPLEMENTED();
}
export function setFilters(_patch: Partial<ViewFilters>): void {
  NOT_IMPLEMENTED();
}
export function getMistakeByShortId(_shortId: string): Mistake | undefined {
  return NOT_IMPLEMENTED();
}

// ── Training ──────────────────────────────────────────────────────────────
/** Builds a session for the self profile (or a scout prep drill when profileId is an opponent). */
export function startSession(_opts?: { profileId?: string; filters?: Partial<ViewFilters> }): Promise<SessionCard[]> {
  return NOT_IMPLEMENTED();
}
/** Judges a move (standard UCI) for a card; evaluates unknown moves with the engine (interactive priority). */
export function submitMove(_card: SessionCard, _uci: string, _signal?: AbortSignal): Promise<MoveVerdict> {
  return NOT_IMPLEMENTED();
}
export function gradeCard(_card: SessionCard, _grade: Grade): Promise<ReviewState> {
  return NOT_IMPLEMENTED();
}
/** Attempts per day for the last `days` days (heatmap) and the current daily streak. */
export function practiceStats(_days?: number): Promise<{ byDay: { day: string; total: number; correct: number }[]; streak: number }> {
  return NOT_IMPLEMENTED();
}

// ── Scout ─────────────────────────────────────────────────────────────────
export function loadScout(_profileId: string): Promise<{ profile: Profile; mistakes: Mistake[]; games: StoredGame[] }> {
  return NOT_IMPLEMENTED();
}

// ── Data ──────────────────────────────────────────────────────────────────
export function exportData(): Promise<Blob> {
  return NOT_IMPLEMENTED();
}
/** PGN of the visible mistakes (Lichess study / Chessable importable). */
export function exportMistakesPgn(): Promise<Blob> {
  return NOT_IMPLEMENTED();
}
export function importData(_file: Blob): Promise<void> {
  return NOT_IMPLEMENTED();
}
export function clearData(): Promise<void> {
  return NOT_IMPLEMENTED();
}
/** Loads public/demo/demo.json as a demo self profile. */
export function loadDemo(): Promise<void> {
  return NOT_IMPLEMENTED();
}
export function diagnostics(): Promise<Record<string, unknown>> {
  return NOT_IMPLEMENTED();
}
