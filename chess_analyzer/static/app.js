import { Chessground } from './vendor/chessground/chessground.min.js';
import { Chess } from './vendor/chess.js/chess.js';

const S = {
  status: null,
  syncConfigs: [],
  theme: document.documentElement.dataset.theme || 'dark',
  color: 'white',
  allMistakes: [],
  mistakes: [],
  stats: {},
  analysisMeta: {},
  idx: 0,
  ground: null,
  hintOn: false,
  pollIds: {},
  filters: {
    query: '',
    opening: 'all',
    severity: 'all',
  },
};

const P = {
  all: [],
  queue: [],
  qIdx: 0,
  streak: 0,
  bestStreak: 0,
  correct: 0,
  total: 0,
  attempts: 0,
  ground: null,
  active: false,
};

const ROUTES = {
  '/': renderGames,
  '/analysis/white': () => renderAnalysis('white'),
  '/analysis/black': () => renderAnalysis('black'),
  '/practice': renderPractice,
  '/mastered': renderMastered,
  '/snoozed': renderSnoozed,
  '/logs': renderLogs,
};

window.addEventListener('hashchange', route);
window.addEventListener('load', async () => {
  initTheme();
  setupThemeToggle();
  setupShortcutOverlay();
  await refreshAll();
  route();
  setInterval(refreshAll, 10000);
});

function route() {
  const hash = location.hash.replace(/^#/, '') || '/';
  document.querySelectorAll('.nav-link').forEach(link =>
    link.classList.toggle('active', link.getAttribute('href') === `#${hash}`)
  );
  if (hash !== '/logs' && S.pollIds.logs) {
    clearInterval(S.pollIds.logs);
    delete S.pollIds.logs;
  }
  syncLivePolls();
  (ROUTES[hash] || renderGames)();
}

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) {
    opts.body = body;
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(`/api${path}`, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || res.statusText);
  }
  return res.json();
}

const GET = path => api('GET', path);
const POST = (path, body) => api('POST', path, body);
const PUT = path => api('PUT', path);
const DEL = path => api('DELETE', path);

async function refreshAll() {
  const [statusOk, syncOk] = await Promise.all([refreshStatus(), refreshSyncConfigs()]);
  renderGlobalChrome();
  syncLivePolls();
  return { statusOk, syncOk };
}

async function refreshStatus() {
  try {
    S.status = await GET('/status');
    return true;
  } catch {
    return false;
  }
}

async function refreshSyncConfigs() {
  try {
    S.syncConfigs = (await GET('/sync')).configs || [];
    return true;
  } catch {
    return false;
  }
}

function renderGlobalChrome() {
  const logsLink = document.getElementById('nav-logs');
  if (logsLink) logsLink.classList.toggle('hidden', !S.status?.dev_mode);
  renderThemeToggle();
  renderEngineBadge();
}

function renderEngineBadge() {
  const el = document.getElementById('engine-badge');
  if (!el || !S.status) return;
  if (S.status.engine_ok) {
    el.innerHTML = `<span class="status-pill status-good">Engine ready${S.status.dev_mode ? ' · dev' : ''}</span>`;
    return;
  }
  el.innerHTML = `<span class="status-pill status-warn" title="${esc(S.status.engine_path)}">Engine missing${S.status.dev_mode ? ' · dev' : ''}</span>`;
}

function initTheme() {
  applyTheme(S.theme, false);
}

function setupThemeToggle() {
  document.getElementById('theme-toggle')?.addEventListener('click', toggleTheme);
  renderThemeToggle();
}

function renderThemeToggle() {
  const el = document.getElementById('theme-toggle');
  if (!el) return;
  el.innerHTML = S.theme === 'dark'
    ? '<span aria-hidden="true">☀</span><span>Light</span>'
    : '<span aria-hidden="true">☾</span><span>Dark</span>';
}

function toggleTheme() {
  applyTheme(S.theme === 'dark' ? 'light' : 'dark');
}

function applyTheme(theme, persist = true) {
  S.theme = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = S.theme;
  document.documentElement.style.colorScheme = S.theme;
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', S.theme === 'dark' ? '#07131b' : '#f5efe3');
  if (persist) localStorage.setItem('chess-analyzer-theme', S.theme);
  renderThemeToggle();
}

function renderGames() {
  const colors = S.status?.colors || { white: {}, black: {} };
  const summary = S.status?.summary || {};
  const activeJobs = getLiveJobs();
  const queueCount = summary.analysis_queue || 0;
  const runningAnalysis = summary.analysis_running || 0;
  const runningSyncs = summary.sync_running || 0;

  setApp(`
    <div class="page-shell dashboard-view">
      <section class="panel hero-panel">
        <div class="hero-copy">
          <p class="eyebrow">Opening preparation, without spreadsheet pain</p>
          <h1 class="hero-title">Turn your opening leaks into a deliberate training queue.</h1>
          <p class="hero-text">
            Upload PGNs or sync from your platforms, let Stockfish isolate recurring opening mistakes,
            then drill those exact positions in the browser.
          </p>
          <div class="hero-actions">
            <a href="#/analysis/white" class="btn btn-primary">Review White</a>
            <a href="#/practice" class="btn btn-secondary">Start Practice</a>
          </div>
        </div>
        <div class="hero-rail">
          <div class="hero-note">
            <span class="hero-note-label">Engine</span>
            <strong>${S.status?.engine_ok ? 'Ready for analysis' : 'Needs Stockfish'}</strong>
            <span>${S.status?.engine_ok ? esc(S.status.engine_path) : esc(S.status?.engine_hint || '')}</span>
          </div>
          <div class="hero-note">
            <span class="hero-note-label">Live jobs</span>
            <strong>${summary.active_jobs || 0}</strong>
            <span>${runningAnalysis} analysis running · ${runningSyncs} sync running · ${queueCount} queued</span>
          </div>
        </div>
      </section>

      <section class="metric-grid">
        ${metricCard(summary.total_games || 0, 'Games in library', 'Across both colors')}
        ${metricCard(summary.total_mistakes || 0, 'Active mistakes', 'Current training queue')}
        ${metricCard(summary.total_snoozed || 0, 'Snoozed', 'Parked for later review')}
        ${metricCard(summary.total_mastered || 0, 'Mastered', 'Removed from training')}
        ${metricCard(
          summary.practice_total ? `${summary.practice_correct}/${summary.practice_total}` : '0',
          'Practice score',
          summary.practice_best_streak ? `Best streak ${summary.practice_best_streak}` : 'No sessions yet'
        )}
      </section>

      ${!S.status?.engine_ok ? `
        <section class="panel warning-banner">
          <strong>Stockfish is unavailable.</strong>
          <span>Install it with <code>${esc(S.status?.engine_hint || 'brew install stockfish')}</code> or set <code>STOCKFISH_PATH</code>.</span>
        </section>
      ` : ''}

      <section class="panel ops-shell">
        <div class="panel-head">
          <div>
            <p class="eyebrow">Live operations</p>
            <h2>Background jobs and partial results</h2>
            <p class="panel-subtitle">The dashboard updates while sync and analysis keep running.</p>
          </div>
          <span class="status-pill">${activeJobs.length} active</span>
        </div>
        ${activeJobs.length ? `
          <div class="ops-grid">
            ${activeJobs.map(job => liveJobCard(job)).join('')}
          </div>
        ` : `
          <div class="empty-block compact">
            <h3>No background work right now</h3>
            <p>Start a sync or analysis run and new progress will appear here immediately.</p>
          </div>
        `}
      </section>

      <section class="color-grid">
        ${colorCard('white', colors.white || {})}
        ${colorCard('black', colors.black || {})}
      </section>

      <section class="panel sync-panel-shell">
        <div class="panel-head">
          <div>
            <p class="eyebrow">Sync Overview</p>
            <h2>Connected game sources</h2>
          </div>
          <span class="status-pill">${S.syncConfigs.length} configured</span>
        </div>
        ${S.syncConfigs.length ? `
          <div class="sync-list">
            ${S.syncConfigs.map(syncConfigRow).join('')}
          </div>
        ` : `
          <div class="empty-block compact">
            <h3>No sync sources yet</h3>
            <p>Connect a Lichess or Chess.com username from either color card above. Syncs are incremental and local-only.</p>
          </div>
        `}
      </section>

      <section class="panel action-bar">
        <div>
          <p class="eyebrow">Backup and reset</p>
          <h2>Move your local library safely</h2>
        </div>
        <div class="action-row">
          <input id="import-file" type="file" accept=".json,application/json" class="hidden" />
          <button id="btn-import" class="btn btn-secondary">Import backup</button>
          <button id="btn-export" class="btn btn-ghost">Export backup</button>
          <button id="btn-clear" class="btn btn-danger">Clear local data</button>
        </div>
      </section>
    </div>
  `);

  ['white', 'black'].forEach(color => {
    document.querySelectorAll(`[data-tab-group="${color}"]`).forEach(btn =>
      btn.addEventListener('click', () => switchTab(color, btn.dataset.tab))
    );
    const zone = document.getElementById(`zone-${color}`);
    const input = document.getElementById(`file-${color}`);
    if (zone && input) {
      zone.addEventListener('click', () => input.click());
      zone.addEventListener('dragover', evt => {
        evt.preventDefault();
        zone.classList.add('drag-over');
      });
      zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
      zone.addEventListener('drop', evt => {
        evt.preventDefault();
        zone.classList.remove('drag-over');
        if (evt.dataTransfer.files[0]) doUpload(color, evt.dataTransfer.files[0]);
      });
      input.addEventListener('change', () => {
        if (input.files[0]) doUpload(color, input.files[0]);
      });
    }
    document.getElementById(`btn-save-lichess-${color}`)?.addEventListener('click', () => saveSyncConfig(color, 'lichess'));
    document.getElementById(`btn-save-chesscom-${color}`)?.addEventListener('click', () => saveSyncConfig(color, 'chesscom'));
    document.getElementById(`btn-analyze-${color}`)?.addEventListener('click', () => doAnalyze(color));
    document.getElementById(`btn-cancel-${color}`)?.addEventListener('click', () => doCancelAnalysis(color));
  });

  document.querySelectorAll('[data-resync]').forEach(btn =>
    btn.addEventListener('click', () => doResync(Number(btn.dataset.resync)))
  );
  document.querySelectorAll('[data-delsync]').forEach(btn =>
    btn.addEventListener('click', () => doDeleteSync(Number(btn.dataset.delsync)))
  );

  document.getElementById('btn-export')?.addEventListener('click', doExport);
  document.getElementById('btn-import')?.addEventListener('click', () => document.getElementById('import-file')?.click());
  document.getElementById('import-file')?.addEventListener('change', evt => {
    const file = evt.target.files?.[0];
    if (file) doImport(file);
    evt.target.value = '';
  });
  document.getElementById('btn-clear')?.addEventListener('click', doClear);
}

function colorCard(color, info) {
  const cap = color[0].toUpperCase() + color.slice(1);
  const icon = color === 'white' ? '♔' : '♚';
  const hasGames = (info.game_count || 0) > 0;
  const statusHtml = analysisStatusBlock(color, info);
  const lichessCfg = S.syncConfigs.find(cfg => cfg.color === color && cfg.platform === 'lichess');
  const chessComCfg = S.syncConfigs.find(cfg => cfg.color === color && cfg.platform === 'chesscom');

  return `
    <section class="panel color-card ${color}">
      <div class="panel-head">
        <div>
          <p class="eyebrow">${color === 'white' ? 'Build the initiative' : 'Defend the dark squares'}</p>
          <h2>${icon} ${cap} repertoire</h2>
        </div>
        <span class="status-pill">${info.game_count || 0} games</span>
      </div>

      <div class="card-topline">
        <span>${hasGames ? 'PGNs ready for review' : 'No games uploaded yet'}</span>
        ${statusBadge(info.run_status, info.run_queue_position)}
      </div>

      <div class="tab-strip" role="tablist">
        <button class="tab-btn active" data-tab-group="${color}" data-tab="file">File upload</button>
        <button class="tab-btn" data-tab-group="${color}" data-tab="lichess">Lichess</button>
        <button class="tab-btn" data-tab-group="${color}" data-tab="chesscom">Chess.com</button>
      </div>

      <div id="tab-${color}-file" class="tab-pane">
        <div id="zone-${color}" class="drop-zone">
          <input type="file" id="file-${color}" accept=".pgn" class="hidden" />
          <div class="drop-zone-title">${hasGames ? 'Replace uploaded PGN' : 'Drop a PGN here'}</div>
          <p>${hasGames ? 'Drop a new file or click to browse' : 'Upload a focused white or black PGN archive to start analysis.'}</p>
        </div>
      </div>

      <div id="tab-${color}-lichess" class="tab-pane hidden">
        ${syncInputPanel(color, 'lichess', lichessCfg)}
      </div>

      <div id="tab-${color}-chesscom" class="tab-pane hidden">
        ${syncInputPanel(color, 'chesscom', chessComCfg)}
      </div>

      ${statusHtml}
    </section>
  `;
}

function analysisStatusBlock(color, info) {
  const run = info.run_status;
  const progress = info.run_progress || 0;
  const total = info.run_progress_total || 0;
  const pct = total > 0 ? Math.round((progress / total) * 100) : 0;
  const queuePosition = info.run_queue_position || 0;
  const canCancel = run === 'queued' || run === 'running';
  const hasGames = (info.game_count || 0) > 0;
  const resumable = !!info.can_resume;
  const readyCount = info.partial_mistakes_ready || 0;
  const actionLabel = resumable
    ? 'Continue analysis'
    : run === 'done'
      ? 'Re-analyze from start'
      : run === 'error'
        ? 'Retry analysis'
        : 'Analyze openings';

  if (!hasGames) {
    return `<div class="status-block">
      <p class="status-copy">Upload or sync games for this color to create a training queue.</p>
    </div>`;
  }

  return `
    <div class="status-block">
      <div class="status-row">
        <div>
          <strong>${runLabel(run)}</strong>
          <p class="status-copy">${runDescription(run, queuePosition, info.run_error, progress, total, readyCount)}</p>
        </div>
        <div class="status-actions">
          <button id="btn-analyze-${color}" class="btn btn-primary" ${run === 'running' || run === 'queued' ? 'disabled' : ''}>
            ${actionLabel}
          </button>
          ${canCancel ? `<button id="btn-cancel-${color}" class="btn btn-ghost">Stop after this batch</button>` : ''}
        </div>
      </div>
      ${total > 0 ? `
        <div class="progress-track">
          <div class="progress-fill" style="width:${pct}%"></div>
        </div>
        <p class="status-copy status-copy-strong">${progress} / ${total} games analyzed · ${readyCount} positions ready now · batches of ${S.status?.analysis_batch_games || 20}</p>
      ` : ''}
      ${(run === 'done' || resumable || readyCount > 0) ? `<a href="#/analysis/${color}" class="inline-link">Open the ${color} analysis view</a>` : ''}
    </div>
  `;
}

function syncDetailBits(cfg) {
  const run = cfg?.latest_run;
  const details = run?.details || {};
  const bits = [];
  if (cfg?.last_synced_at) bits.push(`Last synced ${timeAgo(cfg.last_synced_at)}`);
  if (run?.status === 'running') {
    const fetched = details.fetched_ids || 0;
    const stored = details.total_games_after_merge || 0;
    bits.push(`fetching ${fetched}`);
    bits.push(`${stored} games usable now`);
    if (details.analysis_streaming && details.analysis_total) {
      bits.push(`analysis ${details.analysis_progress || 0}/${details.analysis_total}`);
    }
  } else {
    if (run?.status === 'done') bits.push(`+${run.games_new} new ids`);
    if (details.total_games_after_merge) bits.push(`${details.total_games_after_merge} total games`);
  }
  if (details.supported_new_games) bits.push(`${details.supported_new_games} supported new`);
  if (details.pages_fetched) bits.push(`${details.pages_fetched} page(s) fetched`);
  if (details.archives_scanned) bits.push(`${details.archives_scanned} archive month(s) scanned`);
  return bits;
}

function syncProgressMarkup(run) {
  const details = run?.details || {};
  if (run?.status !== 'running') return '';
  const fetched = details.fetched_ids || 0;
  const requested = details.requested_limit || fetched || 0;
  const pct = requested > 0 ? Math.max(4, Math.min(100, Math.round((fetched / requested) * 100))) : 0;
  return `
    <div class="sync-progress">
      <div class="progress-track">
        <div class="progress-fill" style="width:${pct}%"></div>
      </div>
      <p class="status-copy">${fetched} fetched so far · ${details.new_ids || 0} new ids · ${details.total_games_after_merge || 0} games currently in the library</p>
    </div>
  `;
}

function syncInputPanel(color, platform, cfg) {
  const run = cfg?.latest_run;
  const placeholder = platform === 'lichess' ? 'Lichess username' : 'Chess.com username';
  const detailBits = syncDetailBits(cfg);

  return `
    <div class="sync-input-panel">
      <div class="sync-input-row">
        <input
          id="input-${platform}-${color}"
          type="text"
          value="${esc(cfg?.username || '')}"
          placeholder="${placeholder}"
          class="field-input"
        />
        <button id="btn-save-${platform}-${color}" class="btn btn-secondary" ${run?.status === 'running' ? 'disabled' : ''}>
          ${cfg ? 'Save & sync' : 'Connect'}
        </button>
      </div>
      <p class="field-help">
        ${cfg
          ? detailBits.join(' · ') || 'Connected'
          : 'This stores games locally and only fetches new games on later syncs.'}
      </p>
      ${syncProgressMarkup(run)}
      ${run?.status === 'error' ? `<p class="error-copy">${esc(run.error || 'sync failed')}</p>` : ''}
    </div>
  `;
}

function syncConfigRow(cfg) {
  const run = cfg.latest_run;
  const platformIcon = cfg.platform === 'lichess' ? '⚡' : '♟';
  const colorIcon = cfg.color === 'white' ? '♔' : '♚';
  const running = run?.status === 'running';
  const bits = syncDetailBits(cfg);

  return `
    <div class="sync-row">
      <div class="sync-row-main">
        <span class="sync-icon">${platformIcon}</span>
        <div>
          <strong>${colorIcon} ${esc(cfg.username)}</strong>
          <p>${cfg.platform} · ${bits.join(' · ') || 'ready to sync'}</p>
        </div>
      </div>
      <div class="sync-row-side">
        ${run?.status === 'done' ? `<span class="status-pill status-good">+${run.games_new}</span>` : ''}
        ${run?.status === 'running' ? `<span class="status-pill status-info">Fetching</span>` : ''}
        ${run?.status === 'error' ? `<span class="status-pill status-warn" title="${esc(run.error || '')}">Error</span>` : ''}
        <button class="btn-icon" data-resync="${cfg.id}" title="Run sync" ${running ? 'disabled' : ''}>
          ${running ? '<span class="spinner"></span>' : '↺'}
        </button>
        <button class="btn-icon" data-delsync="${cfg.id}" title="Remove source">✕</button>
      </div>
      ${running ? syncProgressMarkup(run) : ''}
    </div>
  `;
}

function switchTab(color, tab) {
  document.querySelectorAll(`[data-tab-group="${color}"]`).forEach(btn =>
    btn.classList.toggle('active', btn.dataset.tab === tab)
  );
  ['file', 'lichess', 'chesscom'].forEach(name => {
    const pane = document.getElementById(`tab-${color}-${name}`);
    if (pane) pane.classList.toggle('hidden', name !== tab);
  });
}

async function doUpload(color, file) {
  const fd = new FormData();
  fd.append('file', file);
  try {
    const result = await POST(`/pgn/${color}`, fd);
    toast(`${result.game_count} ${color} games uploaded`, 'success');
    await refreshAll();
    renderGames();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function saveSyncConfig(color, platform) {
  const input = document.getElementById(`input-${platform}-${color}`);
  const username = input?.value.trim();
  if (!username) {
    toast('Enter a username before saving', 'error');
    return;
  }
  try {
    const result = await POST('/sync', { color, platform, username });
    await POST(`/sync/${result.config_id}/run`);
    toast(`Syncing ${platform} games for ${username}`, 'info');
    await refreshAll();
    renderGames();
    pollSync(result.config_id);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function doResync(configId) {
  try {
    const cfg = S.syncConfigs.find(item => item.id === configId);
    await POST(`/sync/${configId}/run`);
    toast(`Re-syncing ${cfg?.platform || 'source'}`, 'info');
    await refreshAll();
    renderGames();
    pollSync(configId);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function doDeleteSync(configId) {
  const cfg = S.syncConfigs.find(item => item.id === configId);
  if (!confirm(`Remove the sync source for ${cfg?.username} on ${cfg?.platform}?`)) return;
  try {
    await DEL(`/sync/${configId}`);
    toast('Sync source removed', 'success');
    await refreshAll();
    renderGames();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function pollSync(configId) {
  const key = `sync-${configId}`;
  if (S.pollIds[key]) clearInterval(S.pollIds[key]);
  S.pollIds[key] = setInterval(async () => {
    const refresh = await refreshAll();
    const cfg = S.syncConfigs.find(item => item.id === configId);
    const hash = location.hash.replace(/^#/, '') || '/';
    if (hash === '/') renderGames();
    if (cfg && hash === `/analysis/${cfg.color}`) {
      await renderAnalysis(cfg.color, { preserve: true });
    }
    if (!refresh.syncOk || !cfg?.latest_run) {
      return;
    }
    if (cfg.latest_run.status !== 'running') {
      clearInterval(S.pollIds[key]);
      delete S.pollIds[key];
      if (cfg?.latest_run?.status === 'done') {
        toast(`Sync complete: ${cfg.latest_run.games_new} new game${cfg.latest_run.games_new === 1 ? '' : 's'}`, 'success');
      } else if (cfg?.latest_run?.status === 'error') {
        toast(cfg.latest_run.error || 'Sync failed', 'error');
      }
      if (hash === '/') renderGames();
    }
  }, 2000);
}

async function doAnalyze(color) {
  try {
    const result = await POST(`/analyze/${color}`);
    toast(
      result.resumed
        ? `${color[0].toUpperCase() + color.slice(1)} analysis resumed from ${result.progress}/${result.total}`
        : `${color[0].toUpperCase() + color.slice(1)} analysis queued`,
      'info'
    );
    await refreshAll();
    const hash = location.hash.replace(/^#/, '') || '/';
    if (hash === `/analysis/${color}`) {
      await renderAnalysis(color, { preserve: true });
    } else {
      renderGames();
    }
    pollAnalysis(color);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function doCancelAnalysis(color) {
  try {
    await POST(`/analyze/${color}/cancel`);
    toast(`${color[0].toUpperCase() + color.slice(1)} analysis will stop after the current batch`, 'success');
    await refreshAll();
    const hash = location.hash.replace(/^#/, '') || '/';
    if (hash === '/') renderGames();
    if (hash === `/analysis/${color}`) renderAnalysis(color);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function pollAnalysis(color) {
  const key = `analysis-${color}`;
  if (S.pollIds[key]) clearInterval(S.pollIds[key]);
  S.pollIds[key] = setInterval(async () => {
    const refresh = await refreshAll();
    const runStatus = S.status?.colors?.[color]?.run_status;
    const hash = location.hash.replace(/^#/, '') || '/';
    if (hash === '/') renderGames();
    if (hash === `/analysis/${color}`) {
      await renderAnalysis(color, { preserve: true });
    }
    if (!refresh.statusOk) {
      return;
    }
    if (!['queued', 'running'].includes(runStatus || '')) {
      clearInterval(S.pollIds[key]);
      delete S.pollIds[key];
    }
  }, 3000);
}

async function doClear() {
  if (!confirm('Delete all local PGNs, analysis runs, sync config, and practice history?')) return;
  try {
    await DEL('/data');
    toast('All local data cleared', 'success');
    await refreshAll();
    renderGames();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function renderAnalysis(color, options = {}) {
  const preserve = !!options.preserve;
  const previousKey = preserve ? currentMistakeKey() : null;
  const previousFilters = preserve ? { ...S.filters } : null;
  S.color = color;
  if (!preserve) {
    setApp(`<div class="page-shell"><section class="panel loading-panel"><span class="spinner"></span><p>Loading analysis…</p></section></div>`);
  }

  try {
    const data = await GET(`/analysis/${color}`);
    S.stats = data.stats || {};
    S.analysisMeta = data;
    S.allMistakes = data.mistakes || [];
    S.filters = preserve && previousFilters ? previousFilters : { query: '', opening: 'all', severity: 'all' };
    if (!preserve) S.idx = 0;
    applyAnalysisFilters(false);
    if (preserve && previousKey) {
      const nextIdx = S.mistakes.findIndex(item => mistakeKey(item) === previousKey);
      S.idx = nextIdx >= 0 ? nextIdx : Math.max(0, Math.min(S.idx, S.mistakes.length - 1));
    }
  } catch (err) {
    setApp(`<div class="page-shell"><section class="panel empty-block"><h2>Could not load analysis</h2><p>${esc(err.message)}</p></section></div>`);
    return;
  }

  if (!S.allMistakes.length) {
    syncLivePolls();
    renderEmpty(color, S.analysisMeta);
    return;
  }

  syncLivePolls();
  buildAnalysisUI();
  attachKeys();
}

function buildAnalysisUI() {
  const color = S.color;
  const colorTitle = color === 'white' ? 'White repertoire' : 'Black repertoire';
  const icon = color === 'white' ? '♔' : '♚';
  const run = S.status?.colors?.[color] || {};
  const runningSyncs = getRunningSyncs(color);
  const progress = S.analysisMeta.run_progress || run.run_progress || 0;
  const total = S.analysisMeta.run_progress_total || run.run_progress_total || 0;
  const readyCount = S.analysisMeta.partial_mistakes_ready || S.mistakes.length;
  const canResume = S.analysisMeta.can_resume || run.can_resume;
  const queueBannerVisible = run.run_status === 'queued' || run.run_status === 'running' || canResume;
  const pct = total > 0 ? Math.round((progress / total) * 100) : 0;
  const autoUpdating = ['queued', 'running'].includes(run.run_status || '') || runningSyncs.length > 0;

  setApp(`
    <div class="page-shell analysis-view" id="analysis-view">
      <section class="panel analysis-hero">
        <div class="panel-head">
          <div>
            <p class="eyebrow">Focused review</p>
            <h1>${icon} ${colorTitle}</h1>
          </div>
          <div class="hero-actions">
            ${autoUpdating ? '<span class="status-pill status-info">Updates automatically</span>' : ''}
            <a href="#/practice" class="btn btn-primary">Practice this queue</a>
            <button id="btn-export" class="btn btn-ghost">Export backup</button>
          </div>
        </div>

        <div class="metric-grid compact">
          ${metricCard(S.stats.total || 0, 'Active mistakes', 'After filters')}
          ${metricCard(S.stats.avg_cp || 0, 'Average loss', 'Centipawns')}
          ${metricCard(S.stats.max_cp || 0, 'Worst miss', 'Centipawns')}
          ${metricCard(S.analysisMeta.snoozed_count || 0, 'Snoozed', 'Parked for later')}
          ${metricCard(S.analysisMeta.mastered_count || 0, 'Mastered', 'Already cleared')}
        </div>

        ${queueBannerVisible ? `
          <div class="queue-banner">
            <div>
              <strong>${run.run_status === 'queued'
                ? `Queued #${run.run_queue_position || 1}`
                : run.run_status === 'running'
                  ? 'Analysis in progress'
                  : 'Partial queue ready'}</strong>
              <p>${run.run_status === 'queued'
                ? `Waiting for the worker. ${progress} / ${total} games already analyzed.`
                : run.run_status === 'running'
                  ? `${progress} / ${total} games analyzed so far. ${readyCount} positions are already ready to practice.`
                  : `${progress} / ${total} games analyzed. You can practice the ready positions now or continue the remaining games later.`}</p>
            </div>
            <div class="queue-banner-actions">
              ${total ? `
                <div class="progress-track wide">
                  <div class="progress-fill" style="width:${pct}%"></div>
                </div>
              ` : ''}
              <span class="status-pill">${readyCount} ready</span>
              ${run.run_status === 'queued' || run.run_status === 'running'
                ? '<button id="btn-cancel-analysis" class="btn btn-ghost">Stop after this batch</button>'
                : '<button id="btn-resume-analysis" class="btn btn-secondary">Continue analysis</button>'}
            </div>
          </div>
        ` : ''}

        ${runningSyncs.length ? `
          <div class="live-rail">
            ${runningSyncs.map(cfg => syncLiveCard(cfg)).join('')}
          </div>
        ` : ''}
      </section>

      <section class="analysis-grid">
        <div class="analysis-main">
          <section class="panel board-panel">
            <div class="panel-head compact">
              <div>
                <p class="eyebrow">Position</p>
                <h2 id="ctr">0 / 0</h2>
              </div>
              <div class="board-actions">
                <button class="btn btn-ghost" id="nav-first">⏮</button>
                <button class="btn btn-ghost" id="nav-prev">◀</button>
                <button class="btn btn-ghost" id="nav-next">▶</button>
                <button class="btn btn-ghost" id="nav-last">⏭</button>
              </div>
            </div>
            <div class="board-wrap" id="board-wrap"></div>
            <div class="board-toolbar">
              <button class="btn btn-secondary" id="btn-hint">Hint</button>
              <button class="btn btn-ghost" id="btn-flip">Flip</button>
              <button class="btn btn-ghost" id="btn-copy-fen">Copy FEN</button>
              <button class="btn btn-ghost" id="btn-lichess">Open in Lichess</button>
              <button class="btn btn-ghost" id="btn-help">Shortcuts</button>
            </div>
          </section>

          <section class="panel detail-panel" id="detail"></section>
        </div>

        <section class="panel list-panel">
          <div class="panel-head compact">
            <div>
              <p class="eyebrow">Filters</p>
              <h2>Training queue</h2>
              ${autoUpdating ? '<p class="panel-subtitle">New results appear here while background work is still running.</p>' : ''}
            </div>
            <span class="status-pill" id="queue-count">${S.mistakes.length} shown</span>
          </div>

          <div class="filter-bar">
            <input id="filter-query" class="field-input" type="text" placeholder="Search move, opening, or FEN" />
            <select id="filter-opening" class="field-select"></select>
            <select id="filter-severity" class="field-select">
              <option value="all">All severities</option>
              <option value="inaccuracy">Inaccuracy 100+</option>
              <option value="mistake">Mistake 150+</option>
              <option value="blunder">Blunder 300+</option>
            </select>
          </div>

          <div class="mistake-list" id="mlist"></div>
        </section>
      </section>
    </div>
  `);

  S.ground = Chessground(document.getElementById('board-wrap'), {
    animation: { enabled: true, duration: 160 },
    highlight: { lastMove: true, check: true },
    movable: { free: false, color: null, showDests: true },
    draggable: { enabled: true },
    drawable: { enabled: true },
  });

  const openingSelect = document.getElementById('filter-opening');
  openingSelect.innerHTML = buildOpeningOptions();
  openingSelect.value = S.filters.opening;
  document.getElementById('filter-query').value = S.filters.query;
  document.getElementById('filter-severity').value = S.filters.severity;

  document.getElementById('filter-query').addEventListener('input', evt => {
    S.filters.query = evt.target.value;
    applyAnalysisFilters();
  });
  document.getElementById('filter-opening').addEventListener('change', evt => {
    S.filters.opening = evt.target.value;
    applyAnalysisFilters();
  });
  document.getElementById('filter-severity').addEventListener('change', evt => {
    S.filters.severity = evt.target.value;
    applyAnalysisFilters();
  });

  document.getElementById('nav-first').onclick = () => go(0);
  document.getElementById('nav-prev').onclick = () => go(S.idx - 1);
  document.getElementById('nav-next').onclick = () => go(S.idx + 1);
  document.getElementById('nav-last').onclick = () => go(S.mistakes.length - 1);
  document.getElementById('btn-hint').onclick = toggleHint;
  document.getElementById('btn-flip').onclick = flipBoard;
  document.getElementById('btn-copy-fen').onclick = copyFen;
  document.getElementById('btn-lichess').onclick = openLichess;
  document.getElementById('btn-help').onclick = () => document.getElementById('shortcut-overlay').classList.remove('hidden');
  document.getElementById('btn-export').onclick = doExport;
  document.getElementById('btn-cancel-analysis')?.addEventListener('click', () => doCancelAnalysis(S.color));
  document.getElementById('btn-resume-analysis')?.addEventListener('click', () => doAnalyze(S.color));

  renderList();
  if (S.mistakes.length) loadMistake(Math.min(S.idx, S.mistakes.length - 1));
}

function applyAnalysisFilters(shouldRender = true) {
  const query = S.filters.query.trim().toLowerCase();
  S.mistakes = S.allMistakes.filter(item => {
    const matchesQuery = !query || [
      item.user_move,
      item.opening_eco,
      item.opening_name,
      item.fen,
    ].some(value => String(value || '').toLowerCase().includes(query));

    const matchesOpening = S.filters.opening === 'all'
      || item.opening_eco === S.filters.opening
      || item.opening_name === S.filters.opening;

    const matchesSeverity = S.filters.severity === 'all'
      || (S.filters.severity === 'blunder' && item.avg_cp_loss >= 300)
      || (S.filters.severity === 'mistake' && item.avg_cp_loss >= 150)
      || (S.filters.severity === 'inaccuracy' && item.avg_cp_loss >= 100);

    return matchesQuery && matchesOpening && matchesSeverity;
  });

  S.idx = Math.max(0, Math.min(S.idx, S.mistakes.length - 1));

  if (!shouldRender) return;
  renderList();
  if (S.mistakes.length) {
    loadMistake(S.idx);
  } else {
    renderDetailEmpty();
  }
}

function buildOpeningOptions() {
  const options = new Map();
  for (const item of S.allMistakes) {
    if (item.opening_name) {
      options.set(item.opening_eco || item.opening_name, item.opening_name);
    }
  }
  const items = [...options.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  return [
    '<option value="all">All openings</option>',
    ...items.map(([value, label]) =>
      `<option value="${esc(value)}">${esc(label)}${value !== label ? ` (${esc(value)})` : ''}</option>`
    ),
  ].join('');
}

function renderList() {
  const list = document.getElementById('mlist');
  const count = document.getElementById('queue-count');
  if (!list || !count) return;
  count.textContent = `${S.mistakes.length} shown`;

  if (!S.mistakes.length) {
    list.innerHTML = `
      <div class="empty-block compact">
        <h3>No mistakes match the current filters</h3>
        <p>Clear the search or choose a wider opening/severity scope.</p>
      </div>
    `;
    return;
  }

  list.innerHTML = S.mistakes.map((mistake, index) => {
    const severity = severityData(mistake.avg_cp_loss);
    return `
      <button class="mistake-row ${index === S.idx ? 'active' : ''}" data-i="${index}">
        <span class="mistake-rank">${index + 1}</span>
        <div class="mistake-copy">
          <div class="mistake-title-row">
            <strong class="mistake-move">${mistake.user_move}</strong>
            <span class="pill ${severity.pill}">${severity.label}</span>
          </div>
          <p>${esc(mistake.opening_name || 'Unlabeled opening')} ${mistake.opening_eco ? `· ${esc(mistake.opening_eco)}` : ''}</p>
        </div>
        <div class="mistake-metrics">
          <span class="pill pill-cp">${mistake.avg_cp_loss}cp</span>
          <span class="pill pill-freq">${mistake.pair_count}×</span>
        </div>
      </button>
    `;
  }).join('');

  list.querySelectorAll('.mistake-row').forEach(row =>
    row.addEventListener('click', () => go(Number(row.dataset.i)))
  );
}

function loadMistake(idx) {
  if (!S.mistakes.length) {
    renderDetailEmpty();
    return;
  }

  S.idx = Math.max(0, Math.min(idx, S.mistakes.length - 1));
  S.hintOn = false;
  const mistake = S.mistakes[S.idx];
  const chess = new Chess();
  chess.load(mistake.fen);
  const turn = chess.turn() === 'w' ? 'white' : 'black';

  S.ground.set({
    fen: mistake.fen,
    orientation: mistake.color || S.color,
    turnColor: turn,
    movable: {
      color: turn,
      dests: legalDests(chess),
      events: { after: (orig, dest) => onMove(orig, dest, mistake) },
    },
    lastMove: [mistake.user_move.slice(0, 2), mistake.user_move.slice(2, 4)],
    drawable: {
      autoShapes: [
        { orig: mistake.user_move.slice(0, 2), dest: mistake.user_move.slice(2, 4), brush: 'red' },
      ],
    },
  });

  document.getElementById('ctr').textContent = `${S.idx + 1} / ${S.mistakes.length}`;
  document.querySelectorAll('.mistake-row').forEach((row, rowIndex) =>
    row.classList.toggle('active', rowIndex === S.idx)
  );
  document.querySelectorAll('.mistake-row')[S.idx]?.scrollIntoView({ block: 'nearest' });
  renderDetail(mistake);
}

function renderDetail(mistake) {
  const detail = document.getElementById('detail');
  if (!detail) return;
  const severity = severityData(mistake.avg_cp_loss);
  const topMoves = (mistake.top_moves || []).slice(0, 3);

  detail.innerHTML = `
    <div class="detail-stack">
      <div class="detail-header">
        <div>
          <p class="eyebrow">Mistake brief</p>
          <h2>${esc(mistake.user_move)} was repeated ${mistake.pair_count} times</h2>
        </div>
        <span class="status-pill ${severity.pill}">${severity.label}</span>
      </div>

      ${mistake.opening_name ? `
        <div class="opening-label">
          ${mistake.opening_eco ? `<span class="opening-eco-chip">${esc(mistake.opening_eco)}</span>` : ''}
          <span class="opening-name-text">${esc(mistake.opening_name)}</span>
        </div>
      ` : ''}

      <div class="detail-metric-grid">
        <div class="detail-metric">
          <span>Played move</span>
          <strong>${esc(mistake.user_move)}</strong>
        </div>
        <div class="detail-metric">
          <span>Average loss</span>
          <strong>${mistake.avg_cp_loss} cp</strong>
        </div>
        <div class="detail-metric">
          <span>Frequency</span>
          <strong>${mistake.pair_count} times</strong>
        </div>
      </div>

      <div class="detail-section">
        <h3>Better candidates</h3>
        ${topMoves.length ? `
          <div class="move-chip-row" id="top-moves">
            ${topMoves.map((move, index) => `<button class="move-chip ${index === 0 ? 'best' : ''}" data-mv="${move}">${move}</button>`).join('')}
          </div>
        ` : '<p class="detail-copy">No alternative moves were returned for this position.</p>'}
      </div>

      <div class="detail-section">
        <h3>Position FEN</h3>
        <p class="fen-block">${esc(mistake.fen)}</p>
      </div>

      <div class="detail-actions">
        <button id="btn-master" class="btn btn-primary">Mark mastered</button>
        <button id="btn-snooze" class="btn btn-secondary">Snooze for later</button>
        <button id="btn-hint-detail" class="btn btn-ghost">Toggle hint</button>
      </div>
    </div>
  `;

  document.getElementById('btn-master')?.addEventListener('click', () => doMaster(mistake));
  document.getElementById('btn-snooze')?.addEventListener('click', () => doSnooze(mistake));
  document.getElementById('btn-hint-detail')?.addEventListener('click', toggleHint);
  document.querySelectorAll('#top-moves [data-mv]').forEach(btn => {
    btn.addEventListener('click', () => {
      const move = btn.dataset.mv;
      S.ground.set({
        drawable: {
          autoShapes: [
            { orig: mistake.user_move.slice(0, 2), dest: mistake.user_move.slice(2, 4), brush: 'red' },
            { orig: move.slice(0, 2), dest: move.slice(2, 4), brush: 'green' },
          ],
        },
      });
    });
  });
}

function renderDetailEmpty() {
  const detail = document.getElementById('detail');
  if (!detail) return;
  detail.innerHTML = `
    <div class="empty-block compact">
      <h3>No mistakes match the current filters</h3>
      <p>Try a different opening or severity filter, or clear the search.</p>
    </div>
  `;
  document.getElementById('ctr').textContent = '0 / 0';
}

function renderEmpty(color, data = {}) {
  const run = S.status?.colors?.[color] || {};
  const runStatus = data.run_status || run.run_status;
  const progress = data.run_progress || run.run_progress || 0;
  const total = data.run_progress_total || run.run_progress_total || 0;
  const pct = total > 0 ? Math.round((progress / total) * 100) : 0;
  const readyCount = data.partial_mistakes_ready || run.partial_mistakes_ready || 0;
  const canResume = data.can_resume || run.can_resume;

  let body = '';
  if (runStatus === 'queued' || runStatus === 'running') {
    body = `
      <h2>${runStatus === 'queued' ? `Queued #${run.run_queue_position || 1}` : 'Analysis in progress'}</h2>
      <p>${runStatus === 'queued' ? 'Your analysis is waiting for the worker.' : 'Stockfish is reviewing the game batches now.'}</p>
      ${total ? `<div class="progress-track wide"><div class="progress-fill" style="width:${pct}%"></div></div>` : ''}
      ${total ? `<p class="muted-copy">${progress} / ${total} games analyzed · ${readyCount} positions ready now</p>` : ''}
      <div class="hero-actions">
        <button id="btn-cancel-empty" class="btn btn-ghost">Stop after this batch</button>
        ${readyCount ? `<a href="#/practice" class="btn btn-secondary">Practice current results</a>` : ''}
      </div>
    `;
  } else if (canResume) {
    body = `
      <h2>Partial analysis ready for ${color}</h2>
      <p>${progress} / ${total} games have been analyzed already. You can practice the current queue now or continue the remaining games later.</p>
      ${total ? `<div class="progress-track wide"><div class="progress-fill" style="width:${pct}%"></div></div>` : ''}
      <p class="muted-copy">${readyCount} positions currently ready</p>
      <div class="hero-actions">
        <button id="btn-retry-empty" class="btn btn-primary">Continue analysis</button>
        <a href="#/practice" class="btn btn-secondary">Practice current results</a>
      </div>
    `;
  } else if (runStatus === 'error') {
    body = `
      <h2>Analysis stopped with an error</h2>
      <p>${esc(data.run_error || run.run_error || 'Unknown analysis error')}</p>
      <div class="hero-actions">
        <button id="btn-retry-empty" class="btn btn-primary">${progress > 0 && total > progress ? 'Continue analysis' : 'Retry analysis'}</button>
        <a href="#/" class="btn btn-secondary">Back to library</a>
      </div>
    `;
  } else if ((S.status?.colors?.[color]?.game_count || 0) > 0) {
    body = `
      <h2>No active mistakes for ${color}</h2>
      <p>You either have a clean opening queue right now or every remaining mistake is already mastered or snoozed.</p>
      <div class="hero-actions">
        <button id="btn-retry-empty" class="btn btn-primary">Re-analyze</button>
        <a href="#/snoozed" class="btn btn-secondary">Review snoozed mistakes</a>
      </div>
    `;
  } else {
    body = `
      <h2>No games uploaded for ${color}</h2>
      <p>Upload a PGN or connect a sync source first, then run analysis for this color.</p>
      <div class="hero-actions">
        <a href="#/" class="btn btn-primary">Go to library</a>
      </div>
    `;
  }

  setApp(`
    <div class="page-shell">
      <section class="panel empty-block roomy">
        ${body}
      </section>
    </div>
  `);

  if (runStatus === 'queued' || runStatus === 'running') {
    pollAnalysis(color);
    document.getElementById('btn-cancel-empty')?.addEventListener('click', () => doCancelAnalysis(color));
  }
  document.getElementById('btn-retry-empty')?.addEventListener('click', () => doAnalyze(color));
}

function syncLivePolls() {
  for (const cfg of S.syncConfigs) {
    const key = `sync-${cfg.id}`;
    if (cfg.latest_run?.status === 'running') {
      if (!S.pollIds[key]) pollSync(cfg.id);
      continue;
    }
    stopPoll(key);
  }

  for (const color of ['white', 'black']) {
    const key = `analysis-${color}`;
    const runStatus = S.status?.colors?.[color]?.run_status;
    const syncingThisColor = getRunningSyncs(color).length > 0;
    if (['queued', 'running'].includes(runStatus || '') && !syncingThisColor) {
      if (!S.pollIds[key]) pollAnalysis(color);
      continue;
    }
    stopPoll(key);
  }
}

function stopPoll(key) {
  if (!S.pollIds[key]) return;
  clearInterval(S.pollIds[key]);
  delete S.pollIds[key];
}

function onMove(orig, dest, mistake) {
  const move = orig + dest;
  if ((mistake.top_moves || []).includes(move)) {
    toast('Correct move found', 'success');
    setTimeout(() => go(S.idx + 1), 700);
  } else {
    toast('Not the best move for this position', 'error');
    setTimeout(() => loadMistake(S.idx), 450);
  }
}

function go(idx) {
  if (!S.mistakes.length) return;
  loadMistake(Math.max(0, Math.min(S.mistakes.length - 1, idx)));
}

function toggleHint() {
  if (!S.mistakes.length) return;
  S.hintOn = !S.hintOn;
  const mistake = S.mistakes[S.idx];
  const shapes = [
    { orig: mistake.user_move.slice(0, 2), dest: mistake.user_move.slice(2, 4), brush: 'red' },
  ];
  if (S.hintOn && mistake.top_moves?.length) {
    shapes.push({
      orig: mistake.top_moves[0].slice(0, 2),
      dest: mistake.top_moves[0].slice(2, 4),
      brush: 'green',
    });
  }
  S.ground.setAutoShapes(shapes);
}

function flipBoard() {
  S.ground?.toggleOrientation();
}

function copyFen() {
  const mistake = S.mistakes[S.idx];
  if (!mistake) return;
  navigator.clipboard.writeText(mistake.fen).then(
    () => toast('FEN copied to clipboard', 'success'),
    () => toast('Clipboard write failed', 'error')
  );
}

function openLichess() {
  const mistake = S.mistakes[S.idx];
  if (mistake) {
    window.open(`https://lichess.org/analysis/${encodeURIComponent(mistake.fen)}`, '_blank');
  }
}

async function doMaster(mistake) {
  try {
    await PUT(`/mistakes/${mistake.id}/master`);
    await refreshAll();
    toast('Marked as mastered', 'success');
    removeAnalysisMistake(mistake.id);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function doSnooze(mistake) {
  try {
    await PUT(`/mistakes/${mistake.id}/snooze`);
    await refreshAll();
    toast('Moved to snoozed', 'success');
    removeAnalysisMistake(mistake.id);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function removeAnalysisMistake(id) {
  S.allMistakes = S.allMistakes.filter(item => item.id !== id);
  if (!S.allMistakes.length) {
    renderEmpty(S.color, S.analysisMeta);
    return;
  }
  applyAnalysisFilters();
}

async function doExport() {
  try {
    const payload = await GET('/export');
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const link = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: 'chess-analyzer-backup.json',
    });
    link.click();
    URL.revokeObjectURL(link.href);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function doImport(file) {
  if (!confirm('Importing a backup replaces the current local data. Continue?')) return;
  const fd = new FormData();
  fd.append('file', file);
  try {
    const result = await POST('/import', fd);
    toast(`Backup restored: ${result.summary?.total_games || 0} games loaded`, 'success');
    await refreshAll();
    renderGames();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function renderPractice() {
  setApp(`<div class="page-shell"><section class="panel loading-panel"><span class="spinner"></span><p>Preparing practice session…</p></section></div>`);
  let allMistakes = [];
  let white = null;
  let black = null;

  try {
    [white, black] = await Promise.all([GET('/analysis/white'), GET('/analysis/black')]);
    allMistakes = [
      ...(white.mistakes || []).map(item => ({ ...item, color: 'white' })),
      ...(black.mistakes || []).map(item => ({ ...item, color: 'black' })),
    ];
  } catch (err) {
    setApp(`<div class="page-shell"><section class="panel empty-block"><h2>Practice could not load</h2><p>${esc(err.message)}</p></section></div>`);
    return;
  }

  if (!allMistakes.length) {
    setApp(`
      <div class="page-shell">
        <section class="panel empty-block roomy">
          <h2>No active mistakes to practice</h2>
          <p>Run analysis first, or unsnooze mistakes you want back in the queue.</p>
          <div class="hero-actions">
            <a href="#/" class="btn btn-primary">Go to library</a>
            <a href="#/snoozed" class="btn btn-secondary">Review snoozed</a>
          </div>
        </section>
      </div>
    `);
    return;
  }

  P.all = allMistakes;
  P.queue = shuffle([...Array(allMistakes.length).keys()]);
  P.qIdx = 0;
  P.streak = 0;
  P.bestStreak = 0;
  P.correct = 0;
  P.total = 0;
  P.attempts = 0;
  P.active = true;

  buildPracticeUI({
    runningNote: [white, black].some(item => ['queued', 'running'].includes(item?.run_status || ''))
      ? 'Practice is using the positions already ready while analysis continues in the background.'
      : [white, black].some(item => item?.can_resume)
        ? 'Practice is using the positions already ready. You can continue the remaining analysis later.'
        : '',
  });
  loadPracticePosition();
}

function buildPracticeUI({ runningNote = '' } = {}) {
  setApp(`
    <div class="page-shell">
      <section class="panel practice-shell">
        <div class="panel-head">
          <div>
            <p class="eyebrow">Live drilling</p>
            <h1>Practice the current mistake queue</h1>
          </div>
          <a href="#/analysis/white" class="btn btn-ghost">Back to analysis</a>
        </div>

        <div class="metric-grid compact">
          ${metricCard(0, 'Streak', 'Current run')}
          ${metricCard(0, 'Correct', 'Solved positions')}
          ${metricCard(0, 'Attempted', 'Total tries')}
          ${metricCard(0, 'Best streak', 'Session record')}
        </div>

        ${runningNote ? `<p class="practice-note">${runningNote}</p>` : ''}

        <div class="practice-layout">
          <div class="practice-board-card">
            <div id="p-board-wrap" class="board-wrap-sm"></div>
            <div class="board-toolbar">
              <button id="p-hint" class="btn btn-secondary">Hint</button>
              <button id="p-skip" class="btn btn-ghost">Skip</button>
              <button id="p-end" class="btn btn-danger">End session</button>
            </div>
          </div>
          <div class="practice-copy-card">
            <p class="eyebrow">Prompt</p>
            <h2 id="p-msg">Find the best move</h2>
            <p class="muted-copy" id="p-ctr"></p>
          </div>
        </div>
      </section>
    </div>
  `);

  document.getElementById('p-hint').onclick = pracHint;
  document.getElementById('p-skip').onclick = pracSkip;
  document.getElementById('p-end').onclick = pracEnd;
  updatePracticeStats();
}

function loadPracticePosition({ resetAttempts = true, resetMessage = true } = {}) {
  if (P.qIdx >= P.queue.length) {
    pracEnd();
    return;
  }

  if (resetAttempts) P.attempts = 0;
  const mistake = P.all[P.queue[P.qIdx]];
  const chess = new Chess();
  chess.load(mistake.fen);
  const turn = chess.turn() === 'w' ? 'white' : 'black';

  const wrap = document.getElementById('p-board-wrap');
  if (!wrap) return;
  if (!P.ground) {
    P.ground = Chessground(wrap, {
      animation: { enabled: true, duration: 160 },
      highlight: { lastMove: true, check: true },
      movable: { free: false, color: null, showDests: true },
      draggable: { enabled: true },
      drawable: { enabled: true },
    });
  }

  P.ground.set({
    fen: mistake.fen,
    orientation: mistake.color,
    turnColor: turn,
    movable: {
      color: turn,
      dests: legalDests(chess),
      events: { after: (orig, dest) => pracOnMove(orig, dest, mistake) },
    },
    lastMove: [mistake.user_move.slice(0, 2), mistake.user_move.slice(2, 4)],
    drawable: {
      autoShapes: [
        { orig: mistake.user_move.slice(0, 2), dest: mistake.user_move.slice(2, 4), brush: 'red' },
      ],
    },
  });

  updatePracticeStats();
  if (resetMessage) setMsg('Find the best move');
  document.getElementById('p-ctr').textContent = `Position ${P.qIdx + 1} of ${P.queue.length}`;
}

function pracOnMove(orig, dest, mistake) {
  const move = orig + dest;
  P.attempts += 1;
  if ((mistake.top_moves || []).includes(move)) {
    P.correct += 1;
    P.total += 1;
    P.streak += 1;
    P.bestStreak = Math.max(P.bestStreak, P.streak);
    updatePracticeStats();
    setMsg('Correct. Load the next one.');
    pracFlash('correct');
    P.qIdx += 1;
    setTimeout(loadPracticePosition, 900);
  } else {
    P.streak = 0;
    updatePracticeStats();
    setMsg('Not the best move. Try again.');
    pracFlash('wrong');
    setTimeout(() => {
      if (!P.active) return;
      loadPracticePosition({ resetAttempts: false, resetMessage: false });
      if (P.attempts >= 2) pracHint();
    }, 600);
  }
}

function pracHint() {
  const mistake = P.all[P.queue[P.qIdx]];
  if (!mistake || !P.ground) return;
  P.ground.set({
    drawable: {
      autoShapes: [
        { orig: mistake.user_move.slice(0, 2), dest: mistake.user_move.slice(2, 4), brush: 'red' },
        ...(mistake.top_moves?.length
          ? [{ orig: mistake.top_moves[0].slice(0, 2), dest: mistake.top_moves[0].slice(2, 4), brush: 'green' }]
          : []),
      ],
    },
  });
  setMsg(`Hint: consider ${mistake.top_moves?.[0] || '?'}`);
}

function pracSkip() {
  P.total += 1;
  P.streak = 0;
  updatePracticeStats();
  P.qIdx += 1;
  loadPracticePosition();
}

async function pracEnd() {
  P.active = false;
  if (P.total > 0) {
    try {
      const colors = new Set(P.all.map(item => item.color));
      const color = colors.size === 1 ? P.all[0]?.color || 'white' : 'mixed';
      await POST('/practice/session', {
        color,
        correct: P.correct,
        total: P.total,
        best_streak: P.bestStreak,
      });
    } catch {
      // Non-critical.
    }
  }

  const pct = P.total > 0 ? Math.round((P.correct / P.total) * 100) : 0;
  setApp(`
    <div class="page-shell">
      <section class="panel empty-block roomy">
        <p class="eyebrow">Session complete</p>
        <h1>${pct >= 80 ? 'Excellent run' : pct >= 60 ? 'Solid session' : 'Keep the reps coming'}</h1>
        <p>You solved ${P.correct} out of ${P.total} positions for ${pct}% accuracy.</p>
        <div class="metric-grid compact">
          ${metricCard(P.correct, 'Correct', 'Solved positions')}
          ${metricCard(P.total, 'Attempted', 'Total tries')}
          ${metricCard(`${pct}%`, 'Accuracy', 'Session score')}
          ${metricCard(P.bestStreak, 'Best streak', 'Peak run')}
        </div>
        <div class="hero-actions">
          <button id="p-again" class="btn btn-primary">Practice again</button>
          <a href="#/analysis/white" class="btn btn-secondary">Open analysis</a>
        </div>
      </section>
    </div>
  `);
  document.getElementById('p-again')?.addEventListener('click', renderPractice);
  if (P.ground) {
    P.ground.destroy?.();
    P.ground = null;
  }
}

function pracFlash(type) {
  const wrap = document.getElementById('p-board-wrap');
  if (!wrap) return;
  wrap.classList.remove('practice-feedback-correct', 'practice-feedback-wrong');
  void wrap.offsetWidth;
  wrap.classList.add(type === 'correct' ? 'practice-feedback-correct' : 'practice-feedback-wrong');
}

function updatePracticeStats() {
  const cards = document.querySelectorAll('.practice-shell .metric-card .metric-value');
  if (cards.length >= 4) {
    cards[0].textContent = P.streak;
    cards[1].textContent = P.correct;
    cards[2].textContent = P.total;
    cards[3].textContent = P.bestStreak;
  }
}

function setMsg(message) {
  const el = document.getElementById('p-msg');
  if (el) el.textContent = message;
}

async function renderMastered() {
  await renderArchivePage({
    title: 'Mastered positions',
    subtitle: 'Solved well enough to leave the active queue.',
    endpoint: '/mastered',
    key: 'mastered',
    emptyTitle: 'Nothing mastered yet',
    emptyText: 'Mark positions as mastered from the analysis view when they stop needing repetition.',
    actionLabel: 'Restore',
    actionHandler: id => PUT(`/mistakes/${id}/restore`),
    successText: 'Restored to the active queue',
  });
}

async function renderSnoozed() {
  await renderArchivePage({
    title: 'Snoozed positions',
    subtitle: 'Mistakes you intentionally parked for later.',
    endpoint: '/snoozed',
    key: 'snoozed',
    emptyTitle: 'Nothing snoozed right now',
    emptyText: 'Use snooze from the analysis detail panel to park mistakes you do not want in the active queue yet.',
    actionLabel: 'Unsnooze',
    actionHandler: id => PUT(`/mistakes/${id}/unsnooze`),
    successText: 'Returned to the active queue',
  });
}

async function renderLogs() {
  if (!S.status?.dev_mode) {
    setApp(`
      <div class="page-shell">
        <section class="panel empty-block roomy">
          <h1>Developer logs are disabled</h1>
          <p>Restart the app with <code>chess-analyzer --dev-mode</code> to expose the live log view.</p>
        </section>
      </div>
    `);
    return;
  }

  setApp(`<div class="page-shell"><section class="panel loading-panel"><span class="spinner"></span><p>Loading logs…</p></section></div>`);
  let logs = [];
  try {
    logs = (await GET('/logs?limit=300')).logs || [];
  } catch (err) {
    setApp(`<div class="page-shell"><section class="panel empty-block"><h2>Could not load logs</h2><p>${esc(err.message)}</p></section></div>`);
    return;
  }

  setApp(`
    <div class="page-shell">
      <section class="panel logs-shell">
        <div class="panel-head">
          <div>
            <p class="eyebrow">Developer mode</p>
            <h1>Runtime logs</h1>
            <p class="panel-subtitle">Uploads, sync jobs, batch analysis progress, cancellations, and failures are recorded here.</p>
          </div>
          <div class="hero-actions">
            <button id="btn-refresh-logs" class="btn btn-secondary">Refresh</button>
            <span class="status-pill">${logs.length} entries</span>
          </div>
        </div>
        <div class="log-list">
          ${logs.length ? logs.map(logRow).join('') : '<div class="empty-block compact"><h3>No logs yet</h3><p>Run a sync or analysis job to populate this view.</p></div>'}
        </div>
      </section>
    </div>
  `);

  document.getElementById('btn-refresh-logs')?.addEventListener('click', renderLogs);
  if (S.pollIds.logs) clearInterval(S.pollIds.logs);
  S.pollIds.logs = setInterval(() => {
    if ((location.hash.replace(/^#/, '') || '/') === '/logs') renderLogs();
  }, 4000);
}

async function renderArchivePage(config) {
  setApp(`<div class="page-shell"><section class="panel loading-panel"><span class="spinner"></span><p>Loading…</p></section></div>`);
  let list = [];
  try {
    const [white, black] = await Promise.all([
      GET(`${config.endpoint}/white`),
      GET(`${config.endpoint}/black`),
    ]);
    list = [
      ...(white[config.key] || []).map(item => ({ ...item, color: 'white' })),
      ...(black[config.key] || []).map(item => ({ ...item, color: 'black' })),
    ].sort((a, b) =>
      String(b.mastered_at || b.snoozed_at || '').localeCompare(String(a.mastered_at || a.snoozed_at || ''))
    );
  } catch (err) {
    setApp(`<div class="page-shell"><section class="panel empty-block"><h2>Could not load this view</h2><p>${esc(err.message)}</p></section></div>`);
    return;
  }

  if (!list.length) {
    setApp(`
      <div class="page-shell">
        <section class="panel empty-block roomy">
          <h1>${config.emptyTitle}</h1>
          <p>${config.emptyText}</p>
        </section>
      </div>
    `);
    return;
  }

  setApp(`
    <div class="page-shell">
      <section class="panel">
        <div class="panel-head">
          <div>
            <p class="eyebrow">Archive</p>
            <h1>${config.title}</h1>
            <p class="panel-subtitle">${config.subtitle}</p>
          </div>
          <span class="status-pill">${list.length} total</span>
        </div>
        <div class="archive-list">
          ${list.map(item => archiveRow(item, config.actionLabel)).join('')}
        </div>
      </section>
    </div>
  `);

  document.querySelectorAll('.archive-action').forEach(btn =>
    btn.addEventListener('click', async () => {
      try {
        await config.actionHandler(Number(btn.dataset.id));
        toast(config.successText, 'success');
        await refreshAll();
        route();
      } catch (err) {
        toast(err.message, 'error');
      }
    })
  );
}

function logRow(entry) {
  const details = entry.details ? JSON.stringify(entry.details, null, 2) : '';
  return `
    <article class="log-row log-${esc(entry.level)}">
      <div class="log-row-head">
        <span class="status-pill ${entry.level === 'error' ? 'status-warn' : entry.level === 'warn' ? 'status-info' : ''}">${esc(entry.level)}</span>
        <strong>${esc(entry.scope)}</strong>
        <span class="log-time">${esc(entry.created_at)}</span>
      </div>
      <p class="log-message">${esc(entry.message)}</p>
      ${details ? `<pre class="log-details">${esc(details)}</pre>` : ''}
    </article>
  `;
}

function archiveRow(item, actionLabel) {
  return `
    <div class="archive-row">
      <div class="archive-main">
        <span class="archive-icon">${item.color === 'white' ? '♔' : '♚'}</span>
        <div>
          <div class="archive-title-row">
            <strong>${esc(item.user_move)}</strong>
            <span class="pill pill-cp">${item.avg_cp_loss}cp</span>
            <span class="pill pill-freq">${item.pair_count}×</span>
          </div>
          <p>${esc(item.opening_name || 'Unlabeled opening')} ${item.opening_eco ? `· ${esc(item.opening_eco)}` : ''}</p>
        </div>
      </div>
      <button class="btn btn-ghost archive-action" data-id="${item.id}">${actionLabel}</button>
    </div>
  `;
}

function setupShortcutOverlay() {
  document.getElementById('shortcut-close')?.addEventListener('click', () =>
    document.getElementById('shortcut-overlay').classList.add('hidden')
  );
  document.getElementById('shortcut-overlay')?.addEventListener('click', evt => {
    if (evt.target === evt.currentTarget) {
      document.getElementById('shortcut-overlay').classList.add('hidden');
    }
  });
}

function attachKeys() {
  document.removeEventListener('keydown', onKey);
  document.addEventListener('keydown', onKey);
}

function onKey(evt) {
  if (evt.target.tagName === 'INPUT' || evt.target.tagName === 'TEXTAREA' || !S.mistakes.length) return;
  switch (evt.key) {
    case 'ArrowLeft':
    case 'ArrowUp':
      evt.preventDefault();
      go(S.idx - 1);
      break;
    case 'ArrowRight':
    case 'ArrowDown':
      evt.preventDefault();
      go(S.idx + 1);
      break;
    case 'Home':
      go(0);
      break;
    case 'End':
      go(S.mistakes.length - 1);
      break;
    case 'h':
    case 'H':
      toggleHint();
      break;
    case 'f':
    case 'F':
      flipBoard();
      break;
    case 'c':
    case 'C':
      copyFen();
      break;
    case '?':
      document.getElementById('shortcut-overlay').classList.toggle('hidden');
      break;
  }
}

function metricCard(value, label, hint) {
  return `
    <article class="panel metric-card">
      <span class="metric-value">${value}</span>
      <strong class="metric-label">${label}</strong>
      <p class="metric-hint">${hint}</p>
    </article>
  `;
}

function getRunningSyncs(color = null) {
  return S.syncConfigs.filter(cfg =>
    cfg.latest_run?.status === 'running' && (color ? cfg.color === color : true)
  );
}

function getLiveJobs() {
  const jobs = [];
  for (const color of ['white', 'black']) {
    const info = S.status?.colors?.[color];
    if (['queued', 'running'].includes(info?.run_status || '')) {
      jobs.push({ kind: 'analysis', color, info });
    }
  }
  for (const cfg of getRunningSyncs()) {
    jobs.push({ kind: 'sync', cfg });
  }
  return jobs;
}

function liveJobCard(job) {
  if (job.kind === 'analysis') {
    const progress = job.info.run_progress || 0;
    const total = job.info.run_progress_total || 0;
    const pct = total > 0 ? Math.round((progress / total) * 100) : 0;
    return `
      <article class="live-card">
        <div class="live-card-head">
          <span class="pill pill-analysis">${job.color === 'white' ? '♔ White analysis' : '♚ Black analysis'}</span>
          ${statusBadge(job.info.run_status, job.info.run_queue_position)}
        </div>
        <strong>${progress} / ${total || '?'} games analyzed</strong>
        <p>${job.info.partial_mistakes_ready || 0} positions are ready to practice already.</p>
        ${total ? `<div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>` : ''}
        <a href="#/analysis/${job.color}" class="inline-link">Open ${job.color} queue</a>
      </article>
    `;
  }

  const details = job.cfg.latest_run?.details || {};
  const fetched = details.fetched_ids || 0;
  const requested = details.requested_limit || fetched || 0;
  const pct = requested > 0 ? Math.max(4, Math.min(100, Math.round((fetched / requested) * 100))) : 0;
  return `
    <article class="live-card">
      <div class="live-card-head">
        <span class="pill pill-sync">${job.cfg.platform === 'lichess' ? '⚡' : '♟'} ${esc(job.cfg.username)}</span>
        <span class="status-pill status-info">Syncing ${job.cfg.color}</span>
      </div>
      <strong>${fetched} / ${requested || '?'} fetched</strong>
      <p>${details.total_games_after_merge || 0} usable games now · ${details.analysis_ready || 0} positions ready.</p>
      <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
      <p class="status-copy">Chunk ${details.chunk_index || 1} · batch size ${details.sync_batch_size || '?'}</p>
    </article>
  `;
}

function syncLiveCard(cfg) {
  const details = cfg.latest_run?.details || {};
  const fetched = details.fetched_ids || 0;
  const requested = details.requested_limit || fetched || 0;
  const pct = requested > 0 ? Math.max(4, Math.min(100, Math.round((fetched / requested) * 100))) : 0;
  return `
    <article class="live-card compact">
      <div class="live-card-head">
        <span class="pill pill-sync">${cfg.platform === 'lichess' ? '⚡' : '♟'} ${esc(cfg.username)}</span>
        <span class="status-pill status-info">Fetching more games</span>
      </div>
      <strong>${fetched} / ${requested || '?'} fetched</strong>
      <p>${details.total_games_after_merge || 0} usable now · ${details.analysis_ready || 0} positions already ready</p>
      <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
    </article>
  `;
}

function statusBadge(status, queuePosition = 0) {
  if (!status) return '<span class="status-pill">Not run yet</span>';
  if (status === 'queued') return `<span class="status-pill status-warn">Queued #${queuePosition || 1}</span>`;
  if (status === 'running') return '<span class="status-pill status-info">Running</span>';
  if (status === 'done') return '<span class="status-pill status-good">Ready</span>';
  if (status === 'cancelled') return '<span class="status-pill status-info">Paused</span>';
  if (status === 'error') return '<span class="status-pill status-warn">Needs retry</span>';
  return `<span class="status-pill">${esc(status)}</span>`;
}

function runLabel(status) {
  if (status === 'queued') return 'Queued for analysis';
  if (status === 'running') return 'Analyzing now';
  if (status === 'done') return 'Analysis ready';
  if (status === 'cancelled') return 'Cancelled';
  if (status === 'error') return 'Analysis failed';
  return 'Ready to analyze';
}

function runDescription(status, queuePosition, error, progress = 0, total = 0, readyCount = 0) {
  if (status === 'queued') return `Waiting for the single analysis worker. Queue position ${queuePosition || 1}. ${progress}/${total || '?'} games already analyzed.`;
  if (status === 'running') return `Stockfish is evaluating game batches in the background. ${readyCount} positions are already ready to practice.`;
  if (status === 'done') return 'Open the queue to review, filter, practice, and archive mistakes.';
  if (status === 'cancelled') return total > progress ? `Paused at ${progress}/${total} games. You can continue later.` : 'This run was cancelled before it finished.';
  if (status === 'error') return error || 'The last run failed.';
  return 'Start analysis to build a deliberate review queue from your uploaded games.';
}

function severityData(cp) {
  if (cp >= 300) return { label: 'Blunder', pill: 'pill-blunder' };
  if (cp >= 150) return { label: 'Mistake', pill: 'pill-mistake' };
  return { label: 'Inaccuracy', pill: 'pill-inaccuracy' };
}

function setApp(html) {
  document.getElementById('app').innerHTML = html;
}

function mistakeKey(item) {
  return `${item?.fen || ''}::${item?.user_move || ''}`;
}

function currentMistakeKey() {
  return S.mistakes[S.idx] ? mistakeKey(S.mistakes[S.idx]) : null;
}

function legalDests(chess) {
  const map = new Map();
  chess.moves({ verbose: true }).forEach(({ from, to }) => {
    if (!map.has(from)) map.set(from, []);
    map.get(from).push(to);
  });
  return map;
}

function timeAgo(isoStr) {
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function toast(message, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = type === 'success'
    ? `<span>✓</span> ${esc(message)}`
    : type === 'error'
      ? `<span>✕</span> ${esc(message)}`
      : type === 'info'
        ? `<span>ℹ</span> ${esc(message)}`
        : esc(message);
  const container = document.getElementById('toast');
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .25s';
    setTimeout(() => el.remove(), 250);
  }, 3200);
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
