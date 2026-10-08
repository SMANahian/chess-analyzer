// Live smoke test: the built app against the real Lichess and Chess.com APIs (see playwright.live.config.ts).
// 1. From the app's origin, fetch every endpoint the sync uses and record status, CORS and parsing.
// 2. Onboard the accounts through the real UI, wait for sync + analysis, read the results from the
//    app's IndexedDB and write test-results/live-summary.json (+ the GitHub job summary).
// It fails only on errors (CORS/network, unknown account, crashes, analysis errors), never because an
// account has few games.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { MOCK_ACCOUNTS, routeRecordedApis } from './mock';
import { installPageHooks, type EngineStats, type LiveWindow, type PipelineResults, type PipelineStatus } from './pageHooks';
import { probeApis } from './probes';
import { countMistakes, probeProblems, syncProblems, syncRows, toMarkdown, topLeaks, type LiveSummary, type Problems } from './report';

const SUMMARY_FILE = resolve('test-results', 'live-summary.json');
const POLL_MS = 2_000;
const LOG_EVERY_MS = 30_000;
const PROFILE_TIMEOUT_MS = 90_000;
/** A profile whose refresh job never shows up within this time is stuck. */
const JOB_START_TIMEOUT_MS = 60_000;

interface LiveConfig {
  lichess: string | null;
  chesscom: string | null;
  games: number;
  analysisTimeoutMs: number;
  /** 'deep-link' starts through ?lichess=…&chesscom=… instead of the form. */
  onboarding: 'form' | 'deep-link';
  mock: boolean;
}

function liveConfig(env: NodeJS.ProcessEnv = process.env): LiveConfig {
  const mock = env.LIVE_MOCK === '1';
  // Unset → the default account; set but blank → that site is skipped.
  const account = (value: string | undefined, fallback: string): string | null => (value ?? fallback).trim() || null;
  const games = Math.floor(Number(env.LIVE_GAMES ?? 300));
  const minutes = Number(env.LIVE_TIMEOUT_MIN ?? 15);
  return {
    mock,
    lichess: account(env.LIVE_LICHESS_USER, mock ? MOCK_ACCOUNTS.lichess : 'SMA-Nahian'),
    chesscom: account(env.LIVE_CHESSCOM_USER, mock ? MOCK_ACCOUNTS.chesscom : 'SMA-Nahian'),
    games: Number.isFinite(games) && games > 0 ? Math.min(games, 5_000) : 300,
    analysisTimeoutMs: (Number.isFinite(minutes) && minutes > 0 ? minutes : 15) * 60_000,
    onboarding: env.LIVE_ONBOARDING === 'deep-link' ? 'deep-link' : 'form',
  };
}

function emptySummary(cfg: LiveConfig): LiveSummary {
  return {
    result: 'failed',
    mode: cfg.mock ? 'mock' : 'live',
    generatedAt: new Date().toISOString(),
    commit: process.env.GITHUB_SHA ?? null,
    accounts: { lichess: cfg.lichess, chesscom: cfg.chesscom },
    gamesPerAccount: cfg.games,
    settingsApplied: false,
    onboarding: 'not-reached',
    failures: [],
    warnings: [],
    probes: [],
    games: null,
    sync: [],
    mistakes: null,
    topLeaks: [],
    analysis: null,
    pageErrors: [],
    consoleErrors: [],
    notices: [],
  };
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function addProblems(summary: LiveSummary, p: Problems): void {
  summary.failures.push(...p.failures);
  summary.warnings.push(...p.warnings);
}

function watchPage(page: Page, summary: LiveSummary): void {
  page.on('pageerror', err => summary.pageErrors.push(`${err.name}: ${err.message}`));
  page.on('crash', () => summary.pageErrors.push('The page crashed.'));
  page.on('console', msg => {
    if (msg.type() === 'error' && summary.consoleErrors.length < 20) summary.consoleErrors.push(msg.text());
  });
}

// ── Page helpers ──────────────────────────────────────────────────────────

const pipelineStatus = (page: Page): Promise<PipelineStatus> => page.evaluate(() => (window as unknown as LiveWindow).__liveDb.status());
const engineStats = (page: Page): Promise<EngineStats & { cores: number }> =>
  page.evaluate(() => ({ ...(window as unknown as LiveWindow).__liveEngine, cores: navigator.hardwareConcurrency }));

async function waitForDb(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => (window as unknown as LiveWindow).__liveDb.ready()), { timeout: 30_000, message: 'the app did not open its database' })
    .toBe(true);
}

/** Error toasts and alerts currently shown by the app. */
async function alertTexts(page: Page): Promise<string[]> {
  const texts = await page.locator('[role="alert"]').allInnerTexts().catch(() => []);
  return texts.map(t => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** One line of what the progress card says (best effort, for the log only). */
async function progressText(page: Page): Promise<string> {
  const text = await page.locator('.progress-card').first().innerText({ timeout: 1_000 }).catch(() => '');
  return text.replace(/\s+/g, ' ').trim().slice(0, 160);
}

// ── Steps ─────────────────────────────────────────────────────────────────

async function openApp(page: Page): Promise<void> {
  await page.goto('./');
  await waitForDb(page);
}

/** Writes gamesPerAccount into the app's settings and reloads, so the first run fetches exactly that many. */
async function setGamesPerAccount(page: Page, games: number): Promise<boolean> {
  const ok = await page.evaluate(n => (window as unknown as LiveWindow).__liveDb.setGamesPerAccount(n), games);
  await page.reload();
  await waitForDb(page);
  return ok;
}

/**
 * Fills the onboarding form, or uses the deep link (?lichess=…&chesscom=…) when asked to or when the
 * form is not there. Returns how, and when the usernames were submitted.
 */
async function onboard(page: Page, cfg: LiveConfig): Promise<{ via: 'form' | 'deep-link'; submittedAt: number }> {
  const submit = page.getByRole('button', { name: 'Analyze my games' });
  const hasForm =
    cfg.onboarding === 'form' &&
    (await submit.waitFor({ state: 'visible', timeout: 20_000 }).then(
      () => true,
      () => false,
    ));
  if (!hasForm) {
    const query = new URLSearchParams();
    if (cfg.lichess) query.set('lichess', cfg.lichess);
    if (cfg.chesscom) query.set('chesscom', cfg.chesscom);
    const submittedAt = Date.now();
    await page.goto(`./?${query.toString()}`);
    return { via: 'deep-link', submittedAt };
  }
  if (cfg.lichess) await page.getByLabel('Lichess username', { exact: true }).fill(cfg.lichess);
  if (cfg.chesscom) await page.getByLabel('Chess.com username', { exact: true }).fill(cfg.chesscom);
  const submittedAt = Date.now();
  await submit.click();
  return { via: 'form', submittedAt };
}

async function waitForProfile(page: Page): Promise<string> {
  const deadline = Date.now() + PROFILE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { profileId } = await pipelineStatus(page);
    if (profileId) return profileId;
    const alerts = await alertTexts(page);
    if (alerts.length > 0) throw new Error(`Onboarding failed: ${alerts.join(' / ')}`);
    await page.waitForTimeout(POLL_MS);
  }
  throw new Error(`No profile was created within ${PROFILE_TIMEOUT_MS / 1000} s of submitting the usernames.`);
}

async function logProgress(page: Page, s: PipelineStatus, startedAt: number): Promise<void> {
  const engine = await engineStats(page);
  const ui = await progressText(page);
  console.log(
    `[live ${Math.round((Date.now() - startedAt) / 1000)} s] games ${s.games}, mistakes ${s.mistakes}, ` +
      `engine searches ${engine.searches} (${engine.alive} workers)${ui ? ` | ${ui}` : ''}`,
  );
}

/** When the first sync and the first analysis finished (page clock, from the profile row). */
interface FirstPass {
  syncAt?: number;
  analysisAt?: number;
}

/**
 * Waits until the refresh job (sync → analysis, plus backfill → analysis above 300 games) has finished,
 * noting when the first pass finished. `untilFirstAnalysis`: stop at the first completed analysis (used
 * when gamesPerAccount could not be set).
 */
async function waitForAnalysis(page: Page, cfg: LiveConfig, untilFirstAnalysis: boolean): Promise<{ status: PipelineStatus; first: FirstPass }> {
  const startedAt = Date.now();
  let lastLog = startedAt;
  let sawJob = false;
  const first: FirstPass = {};
  for (;;) {
    const s = await pipelineStatus(page);
    sawJob ||= s.jobRunning;
    const analysisAt = s.lastAnalysisAt;
    const analysed = analysisAt !== undefined;
    if (analysed && first.analysisAt === undefined) {
      first.analysisAt = analysisAt;
      // Unless the backfill sync already finished too (then the first sync's end was not seen).
      if (s.lastSyncAt !== undefined && s.lastSyncAt <= analysisAt) first.syncAt = s.lastSyncAt;
    }
    if (analysed && (!s.jobRunning || untilFirstAnalysis)) return { status: s, first };
    if (!analysed && !s.jobRunning && (sawJob || Date.now() - startedAt > JOB_START_TIMEOUT_MS)) {
      const alerts = await alertTexts(page);
      throw new Error(`The sync/analysis job ${sawJob ? 'ended' : 'never started'} without an analysis.${alerts.length ? ` App says: ${alerts.join(' / ')}` : ''}`);
    }
    if (Date.now() - startedAt > cfg.analysisTimeoutMs) {
      throw new Error(`The analysis did not finish within ${cfg.analysisTimeoutMs / 60_000} min (games ${s.games}, mistakes so far ${s.mistakes}).`);
    }
    if (Date.now() - lastLog >= LOG_EVERY_MS) {
      lastLog = Date.now();
      await logProgress(page, s, startedAt);
    }
    await page.waitForTimeout(POLL_MS);
  }
}

/** Stops the backfill that follows the first pass (only needed when gamesPerAccount could not be set). */
async function cancelBackfill(page: Page): Promise<boolean> {
  const cancel = page.getByRole('button', { name: 'Cancel' }).first();
  if (!(await cancel.isVisible().catch(() => false))) return false;
  await cancel.click();
  return true;
}

interface Timeline {
  submittedAt: number;
  first: FirstPass;
  doneAt: number;
}

const since = (from: number | undefined, to: number | undefined): number | null =>
  from === undefined || to === undefined || to < from ? null : to - from;

async function collectResults(page: Page, profileId: string, status: PipelineStatus, times: Timeline, summary: LiveSummary): Promise<void> {
  const results: PipelineResults | null = await page.evaluate(id => (window as unknown as LiveWindow).__liveDb.results(id), profileId);
  if (!results) throw new Error('The profile disappeared before its results could be read.');
  const engine = await engineStats(page);
  const now = Date.now();
  summary.games = results.games;
  summary.sync = syncRows(results.syncStates);
  addProblems(summary, syncProblems(summary.sync));
  summary.mistakes = countMistakes(results.mistakes, now);
  summary.topLeaks = topLeaks(results.mistakes, now);
  summary.analysis = {
    complete: status.analysisComplete,
    evalsCached: results.evals,
    engineSearches: engine.searches,
    engineBusyMs: engine.busyMs + (engine.active > 0 ? now - engine.busySince : 0),
    enginePoolSize: engine.maxAlive,
    engineWorkersCreated: engine.created,
    hardwareConcurrency: engine.cores || null,
    syncMs: since(times.submittedAt, times.first.syncAt),
    firstAnalysisMs: since(times.first.syncAt, times.first.analysisAt),
    firstResultsMs: since(times.submittedAt, times.first.analysisAt),
    totalMs: times.doneAt - times.submittedAt,
  };
  if (summary.settingsApplied && !status.analysisComplete) {
    summary.failures.push('The analysis finished but some positions could not be evaluated.');
  }
}

function writeSummary(summary: LiveSummary): void {
  mkdirSync(dirname(SUMMARY_FILE), { recursive: true });
  writeFileSync(SUMMARY_FILE, `${JSON.stringify(summary, null, 2)}\n`);
  const markdown = toMarkdown(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  console.log(markdown);
}

// ── Test ──────────────────────────────────────────────────────────────────

test('real accounts: CORS from the app origin, onboarding, sync and analysis', async ({ page }, testInfo) => {
  test.skip(testInfo.config.metadata.live !== true, 'Live test: run it with --config playwright.live.config.ts');
  const cfg = liveConfig();
  const summary = emptySummary(cfg);
  watchPage(page, summary);
  try {
    if (!cfg.lichess && !cfg.chesscom) throw new Error('No account given: set LIVE_LICHESS_USER and/or LIVE_CHESSCOM_USER.');
    if (cfg.mock) await routeRecordedApis(page);
    await page.addInitScript(installPageHooks);
    await test.step('open the app', () => openApp(page));
    await test.step('request the APIs from the app origin', async () => {
      summary.probes = await probeApis(page, cfg);
      addProblems(summary, probeProblems(summary.probes));
    });
    await test.step(`set ${cfg.games} games per account`, async () => {
      summary.settingsApplied = await setGamesPerAccount(page, cfg.games);
      if (!summary.settingsApplied) summary.warnings.push('Could not set gamesPerAccount; measuring the first 300-game pass only.');
    });
    const { via, submittedAt } = await test.step('onboard the accounts', () => onboard(page, cfg));
    summary.onboarding = via;
    const profileId = await test.step('wait for the profile', () => waitForProfile(page));
    const { status, first } = await test.step('wait for sync and analysis', () => waitForAnalysis(page, cfg, !summary.settingsApplied));
    const doneAt = Date.now();
    if (!summary.settingsApplied && (await cancelBackfill(page))) summary.warnings.push('Backfill cancelled after the first analysis.');
    await test.step('collect the results', () => collectResults(page, profileId, status, { submittedAt, first, doneAt }, summary));
  } catch (err) {
    summary.failures.push(messageOf(err));
  } finally {
    summary.notices = await alertTexts(page);
    if (summary.pageErrors.length > 0) summary.failures.push(`${summary.pageErrors.length} uncaught error(s) in the page: ${summary.pageErrors.slice(0, 3).join(' / ')}`);
    summary.result = summary.failures.length === 0 ? 'passed' : 'failed';
    writeSummary(summary);
    await testInfo.attach('live-summary.json', { path: SUMMARY_FILE, contentType: 'application/json' });
  }
  expect(summary.failures, 'live smoke failures').toEqual([]);
});
