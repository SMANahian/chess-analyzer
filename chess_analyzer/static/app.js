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
    sort: 'default',
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
  openingFilter: 'all',
};

const ROUTES = {
  '/': renderGames,
  '/analysis/white': () => renderAnalysis('white'),
  '/analysis/black': () => renderAnalysis('black'),
  '/practice': renderPractice,
  '/openings': renderOpenings,
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
  renderNavBadges();
}

function renderNavBadges() {
  for (const color of ['white', 'black']) {
    const badge = document.getElementById(`nav-badge-${color}`);
    if (!badge) continue;
    const count = S.status?.colors?.[color]?.partial_mistakes_ready || 0;
    if (count > 0) {
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }
}

function renderEngineBadge() {
  const el = document.getElementById('engine-badge');
  if (!el || !S.status) return;
  const dev = S.status.dev_mode ? ' · dev' : '';
  if (S.status.engine_ok) {
    el.innerHTML = `<span class="badge badge-green">Engine ready${dev}</span>`;
    return;
  }
  el.innerHTML = `<span class="badge badge-red" title="${esc(S.status.engine_path)}">No engine${dev}</span>`;
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
  el.textContent = S.theme === 'dark' ? '☀ Light' : '☾ Dark';
}

function toggleTheme() {
  applyTheme(S.theme === 'dark' ? 'light' : 'dark');
}

function applyTheme(theme, persist = true) {
  S.theme = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = S.theme;
  document.documentElement.style.colorScheme = S.theme;
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', S.theme === 'dark' ? '#0f172a' : '#f1f5f9');
  if (persist) localStorage.setItem('chess-analyzer-theme', S.theme);
  renderThemeToggle();
}

function renderGames() {
  const colors = S.status?.colors || { white: {}, black: {} };
  const summary = S.status?.summary || {};
  const activeJobs = getLiveJobs();
  const noSetup = !S.syncConfigs.length && !(summary.total_games > 0);

  if (noSetup) {
    setApp(`
      <div class="page" id="games-view">
        <div class="onboarding">
          <div class="onboard-hero">
            <h1>Analyze your opening mistakes</h1>
            <p>Connect your Lichess or Chess.com account. Stockfish finds recurring mistakes in your openings — then you drill them until they stick.</p>
          </div>

          <div class="platform-grid">
            <div class="platform-card">
              <div class="platform-card-head">
                <span class="platform-logo">⚡</span>
                <div>
                  <h3>Lichess</h3>
                  <p>Free and open source</p>
                </div>
              </div>
              <div class="connect-row">
                <span class="connect-label">♔ White</span>
                <input id="input-lichess-white" type="text" placeholder="Your username" class="field field-sm" />
                <button id="btn-save-lichess-white" class="btn btn-primary btn-sm">Connect</button>
              </div>
              <div class="connect-row">
                <span class="connect-label">♚ Black</span>
                <input id="input-lichess-black" type="text" placeholder="Your username" class="field field-sm" />
                <button id="btn-save-lichess-black" class="btn btn-primary btn-sm">Connect</button>
              </div>
            </div>

            <div class="platform-card">
              <div class="platform-card-head">
                <span class="platform-logo">♟</span>
                <div>
                  <h3>Chess.com</h3>
                  <p>Most popular chess platform</p>
                </div>
              </div>
              <div class="connect-row">
                <span class="connect-label">♔ White</span>
                <input id="input-chesscom-white" type="text" placeholder="Your username" class="field field-sm" />
                <button id="btn-save-chesscom-white" class="btn btn-primary btn-sm">Connect</button>
              </div>
              <div class="connect-row">
                <span class="connect-label">♚ Black</span>
                <input id="input-chesscom-black" type="text" placeholder="Your username" class="field field-sm" />
                <button id="btn-save-chesscom-black" class="btn btn-primary btn-sm">Connect</button>
              </div>
            </div>
          </div>

          <div class="onboard-or">or upload PGN files directly</div>
          <div class="pgn-row">
            <button class="btn btn-secondary" id="upload-white-btn">♔ Upload White PGN</button>
            <input type="file" id="file-white" accept=".pgn" class="hidden" />
            <button class="btn btn-secondary" id="upload-black-btn">♚ Upload Black PGN</button>
            <input type="file" id="file-black" accept=".pgn" class="hidden" />
          </div>
        </div>
      </div>
    `);
  } else {
    setApp(`
      <div class="page" id="games-view">
        <div class="page-header">
          <h1>Dashboard</h1>
          <div class="page-header-actions">
            <a href="#/practice" class="btn btn-primary">⚔ Practice</a>
          </div>
        </div>

        <div class="metric-row" style="margin-bottom:20px">
          ${metricCard(summary.total_games || 0, 'Games', '')}
          ${metricCard(summary.total_mistakes || 0, 'Mistakes', '')}
          ${metricCard(summary.total_mastered || 0, 'Mastered', '')}
          ${metricCard(
            summary.practice_total ? `${Math.round((summary.practice_correct / summary.practice_total) * 100)}%` : '—',
            'Accuracy', ''
          )}
        </div>

        ${!S.status?.engine_ok ? `
          <div class="warning-banner" style="margin-bottom:16px">
            <strong>⚠ Stockfish not found.</strong>
            Install with <code>${esc(S.status?.engine_hint || 'brew install stockfish')}</code>
          </div>
        ` : ''}

        <div id="ops-section"${activeJobs.length ? '' : ' style="display:none"'} style="margin-bottom:16px">
          <div class="card">
            <div class="card-head">
              <h2>Running now</h2>
              <span class="badge badge-blue">${activeJobs.length} active</span>
            </div>
            <div id="live-ops-body">
              <div class="jobs-grid">${activeJobs.map(liveJobCard).join('')}</div>
            </div>
          </div>
        </div>

        <div class="color-grid" style="margin-bottom:20px">
          ${colorCard('white', colors.white || {})}
          ${colorCard('black', colors.black || {})}
        </div>

        ${S.syncConfigs.length ? `
          <div class="card" style="margin-bottom:16px">
            <div class="card-head">
              <h2>Sync sources</h2>
              <span class="badge badge-default">${S.syncConfigs.length} configured</span>
            </div>
            <div class="sync-list">${S.syncConfigs.map(syncConfigRow).join('')}</div>
          </div>
        ` : ''}

        <div class="card">
          <div class="card-head"><h2>Data</h2></div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <input id="import-file" type="file" accept=".json,application/json" class="hidden" />
            <button id="btn-import" class="btn btn-secondary">Import backup</button>
            <button id="btn-export" class="btn btn-ghost">Export backup</button>
            <button id="btn-clear" class="btn btn-danger">Clear all data</button>
          </div>
        </div>
      </div>
    `);
  }

  // Event listeners — work in both onboarding and dashboard mode
  ['white', 'black'].forEach(color => {
    document.querySelectorAll(`[data-tab-group="${color}"]`).forEach(btn =>
      btn.addEventListener('click', () => switchTab(color, btn.dataset.tab))
    );
    const zone = document.getElementById(`zone-${color}`);
    const input = document.getElementById(`file-${color}`);
    if (zone && input) {
      zone.addEventListener('click', () => input.click());
      zone.addEventListener('dragover', evt => { evt.preventDefault(); zone.classList.add('drag-over'); });
      zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
      zone.addEventListener('drop', evt => {
        evt.preventDefault();
        zone.classList.remove('drag-over');
        if (evt.dataTransfer.files[0]) doUpload(color, evt.dataTransfer.files[0]);
      });
      input.addEventListener('change', () => { if (input.files[0]) doUpload(color, input.files[0]); });
    } else if (input) {
      input.addEventListener('change', () => { if (input.files[0]) doUpload(color, input.files[0]); });
    }
    document.getElementById(`upload-${color}-btn`)?.addEventListener('click', () => input?.click());
    document.getElementById(`btn-save-lichess-${color}`)?.addEventListener('click', () => saveSyncConfig(color, 'lichess'));
    document.getElementById(`btn-save-chesscom-${color}`)?.addEventListener('click', () => saveSyncConfig(color, 'chesscom'));
    document.getElementById(`btn-analyze-${color}`)?.addEventListener('click', () => doAnalyze(color));
    document.getElementById(`btn-cancel-${color}`)?.addEventListener('click', () => doCancelAnalysis(color));
    document.getElementById(`depth-select-${color}`)?.addEventListener('change', async evt => {
      try {
        await api('PUT', '/settings/analysis-depth', { depth: Number(evt.target.value) });
        toast(`Analysis depth set to ${evt.target.value}`, 'success');
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });

  document.querySelectorAll('[data-toggle-opts]').forEach(btn =>
    btn.addEventListener('click', () => {
      const opts = document.getElementById(`sync-opts-${btn.dataset.toggleOpts}`);
      if (opts) opts.style.display = opts.style.display === 'none' ? 'flex' : 'none';
    })
  );
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
    <div class="color-card ${color}">
      <div class="color-card-head">
        <h2>${icon} ${cap}</h2>
        <div class="color-card-head-right">
          <span class="badge badge-default">${info.game_count || 0} games</span>
          ${statusBadge(info.run_status, info.run_queue_position)}
        </div>
      </div>

      <div class="color-card-body">
        <div class="tab-strip" role="tablist">
          <button class="tab-btn active" data-tab-group="${color}" data-tab="file">📄 File</button>
          <button class="tab-btn" data-tab-group="${color}" data-tab="lichess">⚡ Lichess</button>
          <button class="tab-btn" data-tab-group="${color}" data-tab="chesscom">♟ Chess.com</button>
        </div>

        <div id="tab-${color}-file" class="tab-pane">
          <div id="zone-${color}" class="drop-zone">
            <input type="file" id="file-${color}" accept=".pgn" class="hidden" />
            <div class="drop-zone-icon">${hasGames ? '🔄' : '📂'}</div>
            <div class="drop-zone-title">${hasGames ? 'Replace PGN' : 'Drop a PGN file here'}</div>
            <p>${hasGames ? 'Drop a new file or click to browse' : 'Supports PGN files from any platform'}</p>
          </div>
        </div>

        <div id="tab-${color}-lichess" class="tab-pane hidden">
          ${syncInputPanel(color, 'lichess', lichessCfg)}
        </div>

        <div id="tab-${color}-chesscom" class="tab-pane hidden">
          ${syncInputPanel(color, 'chesscom', chessComCfg)}
        </div>

        <div id="color-status-${color}">${statusHtml}</div>
      </div>
    </div>
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
      <p class="status-text">Upload or sync games to create a training queue.</p>
    </div>`;
  }

  return `
    <div class="status-block">
      <div class="status-row">
        <div class="status-main">
          <strong>${runLabel(run)}</strong>
          <p>${runDescription(run, queuePosition, info.run_error, progress, total, readyCount)}</p>
        </div>
        <div class="status-actions">
          <select class="sel field-sm" id="depth-select-${color}" title="Analysis depth">
            <option value="6"  ${(S.status?.analysis_depth || 6) === 6  ? 'selected' : ''}>Quick (depth 6)</option>
            <option value="10" ${(S.status?.analysis_depth || 6) === 10 ? 'selected' : ''}>Standard (depth 10)</option>
            <option value="16" ${(S.status?.analysis_depth || 6) === 16 ? 'selected' : ''}>Deep (depth 16)</option>
          </select>
          <button id="btn-analyze-${color}" class="btn btn-primary btn-sm" ${run === 'running' || run === 'queued' ? 'disabled' : ''}>
            ${actionLabel}
          </button>
          ${canCancel ? `<button id="btn-cancel-${color}" class="btn btn-ghost btn-sm">Stop</button>` : ''}
        </div>
      </div>
      ${total > 0 ? `
        <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
        <p class="status-copy-strong">${progress} / ${total} games analyzed · ${readyCount} positions ready</p>
      ` : ''}
      ${(run === 'done' || resumable || readyCount > 0) ? `<a href="#/analysis/${color}" class="inline-link">Open ${color} analysis →</a>` : ''}
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
    <div style="margin-top:8px">
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      <p class="status-text">${fetched} fetched · ${details.new_ids || 0} new · ${details.total_games_after_merge || 0} total games</p>
    </div>
  `;
}

function syncInputPanel(color, platform, cfg) {
  const run = cfg?.latest_run;
  const placeholder = platform === 'lichess' ? 'Lichess username' : 'Chess.com username';
  const detailBits = syncDetailBits(cfg);

  return `
    <div>
      <div class="sync-field-row">
        <input
          id="input-${platform}-${color}"
          type="text"
          value="${esc(cfg?.username || '')}"
          placeholder="${placeholder}"
          class="field field-sm"
        />
        <button id="btn-save-${platform}-${color}" class="btn btn-secondary btn-sm" ${run?.status === 'running' ? 'disabled' : ''}>
          ${cfg ? 'Save & sync' : 'Connect'}
        </button>
      </div>
      <p class="field-help">
        ${cfg ? detailBits.join(' · ') || 'Connected' : 'Stores games locally — only fetches new games on later syncs.'}
      </p>
      ${syncProgressMarkup(run)}
      ${run?.status === 'error' ? `<p class="error-text">${esc(run.error || 'sync failed')}</p>` : ''}
    </div>
  `;
}

function syncConfigRow(cfg) {
  const run = cfg.latest_run;
  const platformIcon = cfg.platform === 'lichess' ? '⚡' : '♟';
  const colorIcon = cfg.color === 'white' ? '♔' : '♚';
  const running = run?.status === 'running';
  const bits = syncDetailBits(cfg);
  const hasHistory = !!(cfg.last_synced_at || run);

  return `
    <div class="sync-row" id="sync-row-${cfg.id}">
      <span class="sync-icon">${platformIcon}</span>
      <div class="sync-row-body">
        <strong>${colorIcon} ${esc(cfg.username)}</strong>
        <p>${cfg.platform} · ${bits.join(' · ') || 'ready to sync'}</p>
        ${running ? syncProgressMarkup(run) : ''}
        <div class="sync-options" id="sync-opts-${cfg.id}" style="display:none">
          <label class="sync-opt-label">Max games
            <input type="number" class="field field-sm sync-max-games" id="sync-max-${cfg.id}"
              placeholder="5000" min="100" max="50000" step="100" value="5000" style="width:90px;margin-left:6px" />
          </label>
          ${cfg.platform === 'lichess' && hasHistory ? `
            <label class="sync-opt-label" style="margin-left:12px">
              <input type="checkbox" id="sync-full-${cfg.id}" />
              Full re-sync (fetch all history)
            </label>
          ` : ''}
        </div>
      </div>
      <div class="sync-row-side">
        ${run?.status === 'done'    ? `<span class="badge badge-green">+${run.games_new}</span>` : ''}
        ${run?.status === 'running' ? `<span class="badge badge-blue">Fetching</span>` : ''}
        ${run?.status === 'error'   ? `<span class="badge badge-red" title="${esc(run.error || '')}">Error</span>` : ''}
        <button class="btn-icon" data-toggle-opts="${cfg.id}" title="Sync options" ${running ? 'disabled' : ''}>⚙</button>
        <button class="btn-icon" data-resync="${cfg.id}" title="Sync now" ${running ? 'disabled' : ''}>
          ${running ? '<span class="spinner"></span>' : '↺'}
        </button>
        <button class="btn-icon" data-delsync="${cfg.id}" title="Remove">✕</button>
      </div>
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
    const maxInput = document.getElementById(`sync-max-${configId}`);
    const fullInput = document.getElementById(`sync-full-${configId}`);
    const maxGames = maxInput ? (parseInt(maxInput.value, 10) || 0) : 0;
    const fullResync = fullInput ? fullInput.checked : false;
    await POST(`/sync/${configId}/run`, { max_games: maxGames, full_resync: fullResync });
    const note = fullResync ? ' (full re-sync)' : '';
    toast(`Re-syncing ${cfg?.platform || 'source'}${note}`, 'info');
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
    if (hash === '/') patchGamesLive();
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
    if (hash === '/') patchGamesLive();
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
  const alreadyBuilt = preserve && !!document.getElementById('analysis-view');
  if (!alreadyBuilt) {
    setApp(`<div class="page"><div class="loading"><span class="spinner"></span>Loading…</div></div>`);
  }

  try {
    const data = await GET(`/analysis/${color}`);
    S.stats = data.stats || {};
    S.analysisMeta = data;
    S.allMistakes = data.mistakes || [];
    S.filters = preserve && previousFilters ? previousFilters : { query: '', opening: 'all', severity: 'all', sort: 'default' };
    if (!preserve) S.idx = 0;
    applyAnalysisFilters(false);
    if (preserve && previousKey) {
      const nextIdx = S.mistakes.findIndex(item => mistakeKey(item) === previousKey);
      S.idx = nextIdx >= 0 ? nextIdx : Math.max(0, Math.min(S.idx, S.mistakes.length - 1));
    }
  } catch (err) {
    if (!alreadyBuilt) {
      setApp(`<div class="page"><div class="card"><div class="empty"><h2>Could not load analysis</h2><p>${esc(err.message)}</p></div></div></div>`);
    }
    return;
  }

  if (!S.allMistakes.length) {
    syncLivePolls();
    renderEmpty(color, S.analysisMeta);
    return;
  }

  syncLivePolls();
  if (alreadyBuilt) {
    patchAnalysisLive(color);
  } else {
    buildAnalysisUI();
    attachKeys();
  }
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
    <div class="page" id="analysis-view">
      <div class="analysis-header">
        <h1>${icon} ${colorTitle}</h1>
        <div class="analysis-header-actions">
          ${autoUpdating ? '<span class="badge badge-blue">Live</span>' : ''}
          <a href="#/practice" class="btn btn-primary">Practice</a>
          <button id="btn-export" class="btn btn-ghost btn-sm">Export</button>
        </div>
      </div>

      <div class="analysis-metrics" style="margin-bottom:14px">
        ${metricCard(S.stats.total || 0, 'Mistakes', '')}
        ${metricCard(S.analysisMeta.mastered_count || 0, 'Mastered', '')}
        ${metricCard(S.analysisMeta.snoozed_count || 0, 'Snoozed', '')}
      </div>

      ${queueBannerVisible ? `
        <div class="queue-banner" style="margin-bottom:14px">
          <div class="queue-banner-body">
            <strong>${run.run_status === 'queued' ? `Queued #${run.run_queue_position || 1}` : run.run_status === 'running' ? 'Analysis in progress' : 'Partial queue ready'}</strong>
            <p>${run.run_status === 'running' ? `${progress} / ${total} games analyzed · ${readyCount} positions ready.` : run.run_status === 'queued' ? `Waiting for the worker · ${progress} / ${total} already analyzed.` : `${progress} / ${total} analyzed · practice current results or continue later.`}</p>
            ${total ? `<div class="progress-bar" style="margin-top:8px"><div class="progress-fill" style="width:${pct}%"></div></div>` : ''}
          </div>
          <div class="queue-banner-actions">
            <span class="badge badge-default">${readyCount} ready</span>
            ${run.run_status === 'queued' || run.run_status === 'running'
              ? '<button id="btn-cancel-analysis" class="btn btn-ghost btn-sm">Stop after this batch</button>'
              : '<button id="btn-resume-analysis" class="btn btn-secondary btn-sm">Continue analysis</button>'}
          </div>
        </div>
      ` : ''}

      ${runningSyncs.length ? `
        <div class="live-rail" style="margin-bottom:14px">
          ${runningSyncs.map(cfg => syncLiveCard(cfg)).join('')}
        </div>
      ` : ''}

      <div class="analysis-grid">
        <div class="list-panel">
          <div class="list-panel-head">
            <h2>Queue</h2>
            <span class="badge badge-default" id="queue-count">${S.mistakes.length} shown</span>
          </div>
          <div class="filter-bar">
            <input id="filter-query" class="field field-sm" type="text" placeholder="Search move, opening…" />
            <div class="filter-row">
              <select id="filter-opening" class="sel field-sm"></select>
              <select id="filter-severity" class="sel field-sm">
                <option value="all">All</option>
                <option value="inaccuracy">Inaccuracy 100+</option>
                <option value="mistake">Mistake 150+</option>
                <option value="blunder">Blunder 300+</option>
              </select>
            </div>
            <select id="filter-sort" class="sel field-sm">
              <option value="default">Most frequent</option>
              <option value="cp">Worst cp loss</option>
              <option value="hardest">Hardest (practice)</option>
              <option value="due">SM-2 due first</option>
            </select>
          </div>
          <div class="mistake-list" id="mlist"></div>
        </div>

        <div>
          <div class="board-card">
            <div class="board-card-head">
              <div>
                <p style="font-size:.71rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text3);margin-bottom:2px">Position</p>
                <h2 id="ctr" style="font-variant-numeric:tabular-nums">0 / 0</h2>
              </div>
              <div class="board-nav">
                <button class="btn-icon" id="nav-first" title="First">⏮</button>
                <button class="btn-icon" id="nav-prev"  title="Prev (←)">◀</button>
                <button class="btn-icon" id="nav-next"  title="Next (→)">▶</button>
                <button class="btn-icon" id="nav-last"  title="Last">⏭</button>
              </div>
            </div>
            <div id="board-wrap" class="board-wrap"></div>
            <div class="board-toolbar">
              <button class="btn btn-secondary btn-sm" id="btn-hint">Hint</button>
              <button class="btn btn-ghost btn-sm" id="btn-flip">Flip</button>
              <button class="btn btn-ghost btn-sm" id="btn-copy-fen">Copy FEN</button>
              <button class="btn btn-ghost btn-sm" id="btn-lichess">Lichess ↗</button>
              <button class="btn-icon" id="btn-help" title="Shortcuts (?)">?</button>
            </div>
          </div>
          <div class="detail-card" id="detail"></div>
        </div>
      </div>
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
  document.getElementById('filter-sort').value = S.filters.sort;

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
  document.getElementById('filter-sort').addEventListener('change', evt => {
    S.filters.sort = evt.target.value;
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

/** Patch only the live elements of the analysis view (no DOM wipe, no blink). */
function patchAnalysisLive(color) {
  const countEl = document.getElementById('queue-count');
  if (countEl) countEl.textContent = `${S.mistakes.length} shown`;
  renderList();
  if (S.mistakes.length) loadMistake(S.idx);
  const run = S.status?.colors?.[color] || {};
  const progress = S.analysisMeta.run_progress || run.run_progress || 0;
  const total = S.analysisMeta.run_progress_total || run.run_progress_total || 0;
  const pct = total > 0 ? Math.round((progress / total) * 100) : 0;
  const bannerFill = document.querySelector('#analysis-view .queue-banner .progress-fill');
  if (bannerFill) bannerFill.style.width = pct + '%';
}

/** Patch only the live sections of the games/dashboard view (no DOM wipe, no blink). */
function patchGamesLive() {
  if (!document.getElementById('games-view')) { renderGames(); return; }
  const activeJobs = getLiveJobs();
  const opsSection = document.getElementById('ops-section');
  if (opsSection) opsSection.style.display = activeJobs.length ? '' : 'none';
  const opsBody = document.getElementById('live-ops-body');
  if (opsBody) {
    opsBody.innerHTML = activeJobs.length
      ? `<div class="jobs-grid">${activeJobs.map(liveJobCard).join('')}</div>`
      : '';
  }
  for (const color of ['white', 'black']) {
    const info = S.status?.colors?.[color] || {};
    const progress = info.run_progress || 0;
    const total = info.run_progress_total || 0;
    const pct = total > 0 ? Math.round((progress / total) * 100) : 0;
    const fill = document.querySelector(`#color-status-${color} .progress-fill`);
    if (fill) fill.style.width = pct + '%';
    const strong = document.querySelector(`#color-status-${color} .status-copy-strong`);
    if (strong) strong.textContent = `${progress} / ${total} games analyzed · ${info.partial_mistakes_ready || 0} positions ready`;
  }
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

  // Apply sort
  if (S.filters.sort === 'cp') {
    S.mistakes.sort((a, b) => b.avg_cp_loss - a.avg_cp_loss);
  } else if (S.filters.sort === 'hardest') {
    S.mistakes.sort((a, b) => {
      const ra = a.practice_rate ?? -1;
      const rb = b.practice_rate ?? -1;
      if (ra === rb) return b.avg_cp_loss - a.avg_cp_loss;
      return ra - rb; // lower success rate first
    });
  } else if (S.filters.sort === 'due') {
    S.mistakes.sort((a, b) => {
      const da = a.sm2_due_at || '9999';
      const db2 = b.sm2_due_at || '9999';
      return da.localeCompare(db2);
    });
  }
  // default: server ordering (pair_count DESC, avg_cp_loss DESC)

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
    list.innerHTML = `<div class="empty" style="padding:24px"><h2>No matches</h2><p>Try wider filters.</p></div>`;
    return;
  }

  list.innerHTML = S.mistakes.map((mistake, index) => {
    const severity = severityData(mistake.avg_cp_loss);
    const san = uciToSan(mistake.fen, mistake.user_move);
    const pracRate = mistake.practice_rate != null
      ? `<span class="pill pill-prac-${mistake.practice_rate >= 0.8 ? 'good' : mistake.practice_rate >= 0.5 ? 'mid' : 'bad'}">${Math.round(mistake.practice_rate * 100)}%</span>`
      : '';
    return `
      <button class="mistake-row ${index === S.idx ? 'active' : ''}" data-i="${index}">
        <span class="mistake-rank">${index + 1}</span>
        <div class="mistake-copy">
          <span class="mistake-move">${esc(san)} <span class="pill ${severity.pill}">${severity.label}</span> ${pracRate}</span>
          <span class="mistake-opening">${esc(mistake.opening_name || 'Unknown opening')}${mistake.opening_eco ? ` · ${esc(mistake.opening_eco)}` : ''}</span>
        </div>
        <div class="mistake-meta">
          <span class="pill pill-cp">−${mistake.avg_cp_loss}cp</span>
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
  const san = uciToSan(mistake.fen, mistake.user_move);
  const topSans = topMoves.map(mv => ({ uci: mv, san: uciToSan(mistake.fen, mv) }));
  const breadcrumbSans = moveListToSan(mistake.move_list || '');
  const breadcrumb = breadcrumbSans.length ? formatMoveList(breadcrumbSans) : '';
  const pracTotal = mistake.practice_total || 0;
  const pracCorrect = mistake.practice_correct || 0;
  const sm2Due = mistake.sm2_due_at;
  const today = new Date().toISOString().split('T')[0];
  const dueLabel = sm2Due ? (sm2Due <= today ? 'Due now' : `Due ${sm2Due}`) : 'Not practiced';

  detail.innerHTML = `
    <div class="detail-stack">
      <div class="detail-head">
        <div>
          <div class="detail-move">${esc(san)}</div>
          <div class="detail-sub">Played ${mistake.pair_count}× · always suboptimal</div>
        </div>
        <span class="pill ${severity.pill}">${severity.label}</span>
      </div>

      ${mistake.opening_name ? `
        <div class="opening-tag">
          ${mistake.opening_eco ? `<span class="eco">${esc(mistake.opening_eco)}</span>` : ''}
          ${esc(mistake.opening_name)}
        </div>
      ` : ''}

      ${breadcrumb ? `<div class="moves-path">${esc(breadcrumb)}</div>` : ''}

      <div class="detail-metrics">
        <div class="dm"><span>Cp loss</span><strong style="color:var(--red)">−${mistake.avg_cp_loss}</strong></div>
        <div class="dm"><span>Seen</span><strong>${mistake.pair_count}×</strong></div>
        <div class="dm"><span>Practice</span><strong>${pracTotal > 0 ? `${Math.round(pracCorrect / pracTotal * 100)}%` : '—'}</strong></div>
        <div class="dm"><span>SM-2</span><strong class="${sm2Due && sm2Due <= today ? 'text-amber' : ''}">${dueLabel}</strong></div>
      </div>

      <div>
        <p class="section-head">Better moves</p>
        ${topSans.length ? `
          <div class="move-chips" id="top-moves">
            ${topSans.map(({ uci, san: ms }, i) => `<button class="move-chip ${i === 0 ? 'best' : ''}" data-mv="${uci}">${i === 0 ? '★ ' : ''}${esc(ms)}</button>`).join('')}
          </div>
        ` : '<p class="detail-copy">No alternative moves were returned for this position.</p>'}
      </div>

      <div class="detail-actions">
        <button id="btn-master" class="btn btn-primary">✓ Mastered</button>
        <button id="btn-snooze" class="btn btn-secondary">○ Snooze</button>
        <button id="btn-hint-detail" class="btn btn-ghost">Hint</button>
      </div>
    </div>
  `;

  document.getElementById('btn-master')?.addEventListener('click', () => doMasterWithUndo(mistake));
  document.getElementById('btn-snooze')?.addEventListener('click', () => doSnoozeWithUndo(mistake));
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
  detail.innerHTML = `<div class="empty" style="padding:20px"><h2>No matches</h2><p>Adjust the filters above.</p></div>`;
  const ctr = document.getElementById('ctr');
  if (ctr) ctr.textContent = '0 / 0';
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
      <p>${runStatus === 'queued' ? 'Waiting for the worker.' : 'Stockfish is analyzing your games.'}</p>
      ${total ? `<div class="progress-bar" style="max-width:320px;margin:12px auto"><div class="progress-fill" style="width:${pct}%"></div></div>` : ''}
      ${total ? `<p style="font-size:.8rem;color:var(--text2)">${progress} / ${total} games · ${readyCount} positions ready</p>` : ''}
      <div class="empty-actions">
        <button id="btn-cancel-empty" class="btn btn-ghost">Stop</button>
        ${readyCount ? `<a href="#/practice" class="btn btn-secondary">Practice current results</a>` : ''}
      </div>
    `;
  } else if (canResume) {
    body = `
      <h2>Partial analysis ready</h2>
      <p>${progress} / ${total} games analyzed. Practice the current queue or continue later.</p>
      ${total ? `<div class="progress-bar" style="max-width:320px;margin:12px auto"><div class="progress-fill" style="width:${pct}%"></div></div>` : ''}
      <div class="empty-actions">
        <button id="btn-retry-empty" class="btn btn-primary">Continue analysis</button>
        <a href="#/practice" class="btn btn-secondary">Practice now</a>
      </div>
    `;
  } else if (runStatus === 'error') {
    body = `
      <h2>Analysis failed</h2>
      <p>${esc(data.run_error || run.run_error || 'Unknown error')}</p>
      <div class="empty-actions">
        <button id="btn-retry-empty" class="btn btn-primary">${progress > 0 && total > progress ? 'Continue' : 'Retry'}</button>
        <a href="#/" class="btn btn-secondary">Dashboard</a>
      </div>
    `;
  } else if ((S.status?.colors?.[color]?.game_count || 0) > 0) {
    body = `
      <h2>No active mistakes for ${color}</h2>
      <p>Everything is mastered or snoozed.</p>
      <div class="empty-actions">
        <button id="btn-retry-empty" class="btn btn-primary">Re-analyze</button>
        <a href="#/snoozed" class="btn btn-secondary">Snoozed</a>
      </div>
    `;
  } else {
    body = `
      <h2>No games for ${color}</h2>
      <p>Connect Lichess or Chess.com, or upload a PGN file first.</p>
      <div class="empty-actions">
        <a href="#/" class="btn btn-primary">Go to dashboard</a>
      </div>
    `;
  }

  setApp(`
    <div class="page">
      <div class="card">
        <div class="empty">${body}</div>
      </div>
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


function doMasterWithUndo(mistake) {
  PUT(`/mistakes/${mistake.id}/master`).then(async () => {
    await refreshAll();
    removeAnalysisMistake(mistake.id);
    toastUndo('Marked as mastered', async () => {
      try {
        await PUT(`/mistakes/${mistake.id}/restore`);
        await refreshAll();
        // Reload analysis so the restored mistake reappears
        await renderAnalysis(S.color, { preserve: true });
        toast('Restored to active queue', 'success');
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }).catch(err => toast(err.message, 'error'));
}

function doSnoozeWithUndo(mistake) {
  PUT(`/mistakes/${mistake.id}/snooze`).then(async () => {
    await refreshAll();
    removeAnalysisMistake(mistake.id);
    toastUndo('Moved to snoozed', async () => {
      try {
        await PUT(`/mistakes/${mistake.id}/unsnooze`);
        await refreshAll();
        await renderAnalysis(S.color, { preserve: true });
        toast('Returned to active queue', 'success');
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }).catch(err => toast(err.message, 'error'));
}

function toastUndo(message, onUndo) {
  const el = document.createElement('div');
  el.className = 'toast success';
  el.innerHTML = `<span class="toast-icon">✓</span><span>${esc(message)}</span><button class="toast-undo-btn">Undo</button>`;
  el.style.pointerEvents = 'auto';
  const container = document.getElementById('toast');
  container.appendChild(el);
  let undid = false;
  el.querySelector('.toast-undo-btn').addEventListener('click', () => {
    undid = true;
    el.remove();
    onUndo();
  });
  setTimeout(() => {
    if (!undid) {
      el.style.opacity = '0';
      el.style.transition = 'opacity .28s ease';
      setTimeout(() => el.remove(), 300);
    }
  }, 5000);
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
  setApp(`<div class="page"><div class="loading"><span class="spinner"></span>Loading…</div></div>`);
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
    setApp(`<div class="page"><div class="card"><div class="empty"><h2>Practice could not load</h2><p>${esc(err.message)}</p></div></div></div>`);
    return;
  }

  if (!allMistakes.length) {
    setApp(`
      <div class="page">
        <div class="card">
          <div class="empty">
            <h2>No mistakes to practice</h2>
            <p>Run analysis first, or unsnooze mistakes you want back in the queue.</p>
            <div class="empty-actions">
              <a href="#/" class="btn btn-primary">Dashboard</a>
              <a href="#/snoozed" class="btn btn-secondary">Snoozed</a>
            </div>
          </div>
        </div>
      </div>
    `);
    return;
  }

  P.all = allMistakes;
  P.queue = buildSM2Queue(allMistakes);
  P.qIdx = 0;
  P.streak = 0;
  P.bestStreak = 0;
  P.correct = 0;
  P.total = 0;
  P.attempts = 0;
  P.active = true;
  P.openingFilter = 'all';

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
  const openingOptions = buildPracticeOpeningOptions();
  setApp(`
    <div class="page">
      <div class="practice-top">
        <h1>Practice</h1>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <select id="p-opening-filter" class="sel" style="min-width:160px">${openingOptions}</select>
          <span class="badge badge-default" id="p-streak-badge">Streak: 0</span>
          <button id="p-end" class="btn btn-danger btn-sm">End session</button>
        </div>
      </div>

      <div class="practice-stats">
        ${metricCard(0, 'Streak', '')}
        ${metricCard(0, 'Correct', '')}
        ${metricCard(0, 'Attempted', '')}
        ${metricCard(0, 'Best streak', '')}
      </div>

      ${runningNote ? `<p class="practice-note">${runningNote}</p>` : ''}

      <div class="practice-layout">
        <div class="prac-board">
          <div id="p-board-wrap" class="board-wrap-sm"></div>
          <div class="prac-toolbar">
            <button id="p-hint" class="btn btn-secondary btn-sm">Hint</button>
            <button id="p-skip" class="btn btn-ghost btn-sm">Skip</button>
          </div>
        </div>

        <div class="prac-sidebar">
          <h2 id="p-msg" class="prac-msg">Find the best move</h2>
          <p id="p-ctr" class="prac-ctr"></p>
          <div id="p-opening" class="prac-opening"></div>
          <div id="p-breadcrumb" class="prac-breadcrumb"></div>

          <div id="p-after" class="after-box" style="display:none">
            <p class="section-head">Better moves</p>
            <div id="p-moves" class="move-chips"></div>
            <div id="p-continuation" style="display:none;margin-top:10px">
              <p class="section-head">Engine continues</p>
              <div id="p-cont-moves" class="move-chips"></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `);

  document.getElementById('p-hint').onclick = pracHint;
  document.getElementById('p-skip').onclick = pracSkip;
  document.getElementById('p-end').onclick = pracEnd;
  document.getElementById('p-opening-filter').addEventListener('change', evt => {
    P.openingFilter = evt.target.value;
    P.queue = buildSM2Queue(P.all.filter(m =>
      P.openingFilter === 'all' || m.opening_eco === P.openingFilter || m.opening_name === P.openingFilter
    ).map((_, i) => i)).map(i =>
      P.all.indexOf(P.all.filter(m =>
        P.openingFilter === 'all' || m.opening_eco === P.openingFilter || m.opening_name === P.openingFilter
      )[i])
    );
    if (!P.queue.length) {
      // Fallback to all if filtered queue is empty
      P.queue = buildSM2Queue(P.all);
      P.openingFilter = 'all';
      document.getElementById('p-opening-filter').value = 'all';
      toast('No positions match that opening filter', 'error');
    }
    P.qIdx = 0;
    loadPracticePosition();
  });
  updatePracticeStats();
  const afterPanel = document.getElementById('p-after');
  if (afterPanel) afterPanel.style.display = 'none';
}

function buildPracticeOpeningOptions() {
  const opts = new Map();
  for (const m of P.all) {
    if (m.opening_name) {
      opts.set(m.opening_eco || m.opening_name, m.opening_name);
    }
  }
  const entries = [...opts.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  return [
    '<option value="all">All openings</option>',
    ...entries.map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`),
  ].join('');
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
  const afterPanel = document.getElementById('p-after');
  if (afterPanel) afterPanel.style.display = 'none';

  // Show breadcrumb (move path)
  const breadcrumbEl = document.getElementById('p-breadcrumb');
  if (breadcrumbEl) {
    const bsans = moveListToSan(mistake.move_list || '');
    if (bsans.length) {
      breadcrumbEl.innerHTML = `<span class="breadcrumb-sequence" style="font-size:.78rem">${esc(formatMoveList(bsans))}</span>`;
      breadcrumbEl.style.display = '';
    } else {
      breadcrumbEl.innerHTML = '';
      breadcrumbEl.style.display = 'none';
    }
  }

  // Show opening context
  const openingEl = document.getElementById('p-opening');
  if (openingEl) {
    const colorBadge = `<span class="prac-color-badge">${mistake.color === 'white' ? '♔' : '♚'}</span>`;
    if (mistake.opening_name) {
      openingEl.innerHTML = `${colorBadge} ${esc(mistake.opening_name)}${mistake.opening_eco ? ` <span class="eco">${esc(mistake.opening_eco)}</span>` : ''}`;
    } else {
      openingEl.innerHTML = colorBadge;
    }
  }
}

function pracOnMove(orig, dest, mistake) {
  const move = orig + dest;
  P.attempts += 1;
  if ((mistake.top_moves || []).includes(move)) {
    P.correct += 1;
    P.total += 1;
    P.streak += 1;
    P.bestStreak = Math.max(P.bestStreak, P.streak);
    recordAttempt(mistake.id, true);
    updatePracticeStats();
    setMsg('Correct!');
    pracFlash('correct');
    // Show the move played + engine continuation
    showPracAfterCorrect(mistake, move);
    P.qIdx += 1;
    setTimeout(loadPracticePosition, 1600);
  } else {
    P.streak = 0;
    recordAttempt(mistake.id, false);
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

function showPracAfterCorrect(mistake, playedMove) {
  const afterPanel = document.getElementById('p-after');
  const movesEl = document.getElementById('p-moves');
  const contEl = document.getElementById('p-continuation');
  const contMovesEl = document.getElementById('p-cont-moves');
  if (!afterPanel || !movesEl) return;

  const san = uciToSan(mistake.fen, playedMove);
  movesEl.innerHTML = `<span class="move-chip best">★ ${esc(san)}</span>`;

  // Show other top moves in faded form
  const otherTop = (mistake.top_moves || []).filter(mv => mv !== playedMove).slice(0, 2);
  if (otherTop.length) {
    movesEl.innerHTML += otherTop.map(mv => `<span class="move-chip">${esc(uciToSan(mistake.fen, mv))}</span>`).join('');
  }

  // Simulate opponent reply on the board
  if (P.ground) {
    try {
      const chess = new Chess();
      chess.load(mistake.fen);
      chess.move({ from: playedMove.slice(0, 2), to: playedMove.slice(2, 4), promotion: playedMove[4] || undefined });
      const replies = chess.moves({ verbose: true });
      if (replies.length) {
        // Show the position after player's move
        P.ground.set({
          fen: chess.fen(),
          movable: { color: null },
          drawable: {
            autoShapes: [
              { orig: playedMove.slice(0, 2), dest: playedMove.slice(2, 4), brush: 'green' },
            ],
          },
        });
        // Show continuation panel with the first engine reply (best we can show without Stockfish call)
        if (contEl && contMovesEl) {
          const replySan = replies[0].san;
          contMovesEl.innerHTML = `<span class="move-chip" style="opacity:.7">${esc(replySan)}</span>`;
          contEl.style.display = '';
        }
      }
    } catch { /* ignore */ }
  }

  afterPanel.style.display = 'block';
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
  const hintSan = mistake.top_moves?.[0] ? uciToSan(mistake.fen, mistake.top_moves[0]) : '?';
  setMsg(`Hint: consider ${hintSan}`);
  const afterPanel = document.getElementById('p-after');
  const movesEl = document.getElementById('p-moves');
  const contEl = document.getElementById('p-continuation');
  if (contEl) contEl.style.display = 'none';
  if (afterPanel && movesEl) {
    movesEl.innerHTML = (mistake.top_moves || []).slice(0, 3)
      .map((mv, i) => `<span class="move-chip ${i === 0 ? 'best' : ''}">${i === 0 ? '★ ' : ''}${esc(uciToSan(mistake.fen, mv))}</span>`).join('');
    afterPanel.style.display = 'block';
  }
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
  const headline = pct >= 85 ? 'Excellent run' : pct >= 65 ? 'Solid session' : pct >= 40 ? 'Keep the reps coming' : 'Every rep counts';
  setApp(`
    <div class="page">
      <div class="card" style="max-width:600px;margin:40px auto;text-align:center">
        <h1 style="margin-bottom:6px">${headline}</h1>
        <p style="color:var(--text2);margin-bottom:20px">${P.total > 0 ? `${P.correct} of ${P.total} positions solved` : 'No positions attempted.'}</p>
        <div class="result-grid">
          <div class="result-card">
            <span class="result-val" style="color:var(--green)">${pct}%</span>
            <span class="result-lbl">Accuracy</span>
          </div>
          <div class="result-card">
            <span class="result-val">${P.correct}</span>
            <span class="result-lbl">Correct</span>
          </div>
          <div class="result-card">
            <span class="result-val">${P.total}</span>
            <span class="result-lbl">Attempted</span>
          </div>
          <div class="result-card">
            <span class="result-val" style="color:var(--amber)">${P.bestStreak}</span>
            <span class="result-lbl">Best streak</span>
          </div>
        </div>
        <div style="display:flex;gap:8px;justify-content:center;margin-top:20px;flex-wrap:wrap">
          <button id="p-again" class="btn btn-primary">Practice again</button>
          <a href="#/analysis/white" class="btn btn-secondary">♔ White analysis</a>
          <a href="#/analysis/black" class="btn btn-ghost">♚ Black analysis</a>
        </div>
      </div>
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
  const cards = document.querySelectorAll('.practice-stats .metric-value');
  if (cards.length >= 4) {
    cards[0].textContent = P.streak;
    cards[1].textContent = P.correct;
    cards[2].textContent = P.total;
    cards[3].textContent = P.bestStreak;
  }
  const badge = document.getElementById('p-streak-badge');
  if (badge) {
    badge.textContent = `Streak: ${P.streak}`;
    badge.className = `badge ${P.streak >= 5 ? 'badge-green' : P.streak >= 3 ? 'badge-blue' : 'badge-default'}`;
  }
}

function setMsg(message) {
  const el = document.getElementById('p-msg');
  if (el) el.textContent = message;
}

async function renderOpenings() {
  setApp(`<div class="page"><div class="loading"><span class="spinner"></span>Loading…</div></div>`);
  let white = [], black = [];
  try {
    [white, black] = await Promise.all([
      GET('/openings/white').then(r => r.openings || []),
      GET('/openings/black').then(r => r.openings || []),
    ]);
  } catch (err) {
    setApp(`<div class="page"><div class="card"><div class="empty"><h2>Could not load openings</h2><p>${esc(err.message)}</p></div></div></div>`);
    return;
  }

  const renderTable = (items, color) => {
    const icon = color === 'white' ? '♔' : '♚';
    if (!items.length) return `
      <div class="card">
        <div class="empty"><h2>${icon} ${color[0].toUpperCase() + color.slice(1)}</h2><p>No opening data yet — run analysis first.</p></div>
      </div>`;
    return `
      <div class="card">
        <div class="card-head">
          <h2>${icon} ${color[0].toUpperCase() + color.slice(1)}</h2>
          <span class="badge badge-default">${items.length} openings</span>
        </div>
        <div class="opening-table">
          <div class="opening-row-head">
            <span>Opening</span><span>Active</span><span>Mastered</span><span>Avg loss</span><span>Mastery</span>
          </div>
          ${items.map(op => {
            const pct = Math.round((op.mastery_rate || 0) * 100);
            const barFill = pct >= 80 ? 'var(--green)' : pct >= 50 ? 'var(--amber)' : 'var(--red)';
            return `
              <div class="opening-row" role="button" tabindex="0"
                   onclick="location.hash='#/analysis/${color}'"
                   title="Open ${color} analysis">
                <div style="display:flex;align-items:center;gap:6px;overflow:hidden">
                  ${op.eco !== '?' ? `<span class="eco">${esc(op.eco)}</span>` : ''}
                  <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(op.name)}</span>
                </div>
                <span class="pill pill-mistake">${op.active}</span>
                <span class="pill pill-good">${op.mastered_count || 0}</span>
                <span style="color:var(--red);font-weight:600">${op.avg_cp_loss}cp</span>
                <div class="mastery-bar">
                  <div class="mastery-track"><div class="mastery-fill" style="width:${pct}%;background:${barFill}"></div></div>
                  <span style="font-size:.75rem;min-width:2.5em">${pct}%</span>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  };

  let calData = [];
  try { calData = (await GET('/practice/calendar')).calendar || []; } catch { /* optional */ }

  setApp(`
    <div class="page">
      <div class="page-header"><h1>Openings</h1></div>
      ${renderCalendar(calData)}
      <div style="display:flex;flex-direction:column;gap:16px">
        ${renderTable(white, 'white')}
        ${renderTable(black, 'black')}
      </div>
    </div>
  `);
}

function renderCalendar(calData) {
  const today = new Date();
  const DAYS = 91; // 13 weeks
  const dayMap = new Map(calData.map(d => [d.day, d]));

  // Build 13×7 grid starting from 13 weeks ago Monday
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - DAYS + 1);
  // Align to Monday
  const dayOfWeek = (startDate.getDay() + 6) % 7; // Mon=0
  startDate.setDate(startDate.getDate() - dayOfWeek);

  const cells = [];
  const cursor = new Date(startDate);
  const totalAttempts = calData.reduce((s, d) => s + d.total, 0);
  const maxPerDay = Math.max(1, ...calData.map(d => d.total));

  while (cursor <= today) {
    const iso = cursor.toISOString().split('T')[0];
    const data = dayMap.get(iso);
    const total = data ? data.total : 0;
    const correct = data ? data.correct : 0;
    const intensity = total === 0 ? 0 : Math.ceil((total / maxPerDay) * 4);
    cells.push(`<div class="cal-cell cal-${intensity}" title="${iso}: ${total} attempts${total ? `, ${correct} correct` : ''}"></div>`);
    cursor.setDate(cursor.getDate() + 1);
  }

  const weekLabels = ['Mon', '', 'Wed', '', 'Fri', '', 'Sun'];
  return `
    <div class="card" style="margin-bottom:16px">
      <div class="card-head">
        <h2>Practice activity</h2>
        <span class="badge badge-default">${totalAttempts} attempts</span>
      </div>
      <div class="cal-wrap">
        <div class="cal-labels">${weekLabels.map(d => `<span>${d}</span>`).join('')}</div>
        <div class="cal-grid">${cells.join('')}</div>
      </div>
      <p style="font-size:.71rem;color:var(--text3);margin-top:8px">Last 13 weeks</p>
    </div>
  `;
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
      <div class="page">
        <div class="card">
          <div class="empty">
            <h2>Developer logs are disabled</h2>
            <p>Restart with <code>chess-analyzer --dev-mode</code> to enable.</p>
          </div>
        </div>
      </div>
    `);
    return;
  }

  setApp(`<div class="page"><div class="loading"><span class="spinner"></span>Loading…</div></div>`);
  let logs = [];
  try {
    logs = (await GET('/logs?limit=300')).logs || [];
  } catch (err) {
    setApp(`<div class="page"><div class="card"><div class="empty"><h2>Error</h2><p>${esc(err.message)}</p></div></div></div>`);
    return;
  }

  setApp(`
    <div class="page">
      <div class="card">
        <div class="card-head">
          <h1>Runtime logs</h1>
          <div style="display:flex;gap:8px;align-items:center">
            <button id="btn-refresh-logs" class="btn btn-secondary btn-sm">Refresh</button>
            <span class="badge badge-default">${logs.length} entries</span>
          </div>
        </div>
        <div class="log-list">
          ${logs.length ? logs.map(logRow).join('') : '<div class="empty" style="padding:20px"><h2>No logs yet</h2></div>'}
        </div>
      </div>
    </div>
  `);

  document.getElementById('btn-refresh-logs')?.addEventListener('click', renderLogs);
  if (S.pollIds.logs) clearInterval(S.pollIds.logs);
  S.pollIds.logs = setInterval(() => {
    if ((location.hash.replace(/^#/, '') || '/') === '/logs') renderLogs();
  }, 4000);
}

async function renderArchivePage(config) {
  setApp(`<div class="page"><div class="loading"><span class="spinner"></span>Loading…</div></div>`);
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
    setApp(`<div class="page"><div class="card"><div class="empty"><h2>Error</h2><p>${esc(err.message)}</p></div></div></div>`);
    return;
  }

  if (!list.length) {
    setApp(`
      <div class="page">
        <div class="card">
          <div class="empty">
            <h2>${config.emptyTitle}</h2>
            <p>${config.emptyText}</p>
          </div>
        </div>
      </div>
    `);
    return;
  }

  setApp(`
    <div class="page">
      <div class="card">
        <div class="card-head">
          <div>
            <h1>${config.title}</h1>
            <p style="font-size:.8rem;color:var(--text2);margin-top:2px">${config.subtitle}</p>
          </div>
          <span class="badge badge-default">${list.length} total</span>
        </div>
        <div>${list.map(item => archiveRow(item, config.actionLabel)).join('')}</div>
      </div>
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
    <div class="log-row log-${esc(entry.level)}">
      <div class="log-head">
        <span class="badge ${entry.level === 'error' ? 'badge-red' : entry.level === 'warn' ? 'badge-amber' : 'badge-default'}">${esc(entry.level)}</span>
        <strong>${esc(entry.scope)}</strong>
        <span class="log-time">${esc(entry.created_at)}</span>
      </div>
      <p class="log-msg">${esc(entry.message)}</p>
      ${details ? `<pre class="log-detail">${esc(details)}</pre>` : ''}
    </div>
  `;
}

function archiveRow(item, actionLabel) {
  const san = uciToSan(item.fen, item.user_move);
  return `
    <div class="archive-row">
      <div class="archive-main">
        <span class="archive-icon">${item.color === 'white' ? '♔' : '♚'}</span>
        <div class="archive-info">
          <strong>${esc(san)} <span class="pill pill-cp">${item.avg_cp_loss}cp</span> <span class="pill pill-freq">${item.pair_count}×</span></strong>
          <p>${esc(item.opening_name || 'Unlabeled opening')}${item.opening_eco ? ` · ${esc(item.opening_eco)}` : ''}</p>
        </div>
      </div>
      <button class="btn btn-ghost btn-sm archive-action" data-id="${item.id}">${actionLabel}</button>
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
    <div class="metric-card">
      <span class="metric-value">${value}</span>
      <span class="metric-label">${label}</span>
      ${hint ? `<p class="metric-hint">${hint}</p>` : ''}
    </div>
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
      <div class="job-card">
        <div class="job-card-head">
          <span>${job.color === 'white' ? '♔ White' : '♚ Black'} analysis</span>
          ${statusBadge(job.info.run_status, job.info.run_queue_position)}
        </div>
        <strong>${progress} / ${total || '?'} games analyzed</strong>
        <p>${job.info.partial_mistakes_ready || 0} positions ready to practice now.</p>
        ${total ? `<div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>` : ''}
        <a href="#/analysis/${job.color}" class="inline-link">Open ${job.color} queue →</a>
      </div>
    `;
  }

  const details = job.cfg.latest_run?.details || {};
  const fetched = details.fetched_ids || 0;
  const requested = details.requested_limit || fetched || 0;
  const pct = requested > 0 ? Math.max(4, Math.min(100, Math.round((fetched / requested) * 100))) : 0;
  return `
    <div class="job-card">
      <div class="job-card-head">
        <span>${job.cfg.platform === 'lichess' ? '⚡' : '♟'} ${esc(job.cfg.username)}</span>
        <span class="badge badge-blue">Syncing ${job.cfg.color}</span>
      </div>
      <strong>${fetched} / ${requested || '?'} fetched</strong>
      <p>${details.total_games_after_merge || 0} usable games · ${details.analysis_ready || 0} positions ready.</p>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
    </div>
  `;
}

function syncLiveCard(cfg) {
  const details = cfg.latest_run?.details || {};
  const fetched = details.fetched_ids || 0;
  const requested = details.requested_limit || fetched || 0;
  const pct = requested > 0 ? Math.max(4, Math.min(100, Math.round((fetched / requested) * 100))) : 0;
  return `
    <div class="job-card">
      <div class="job-card-head">
        <span>${cfg.platform === 'lichess' ? '⚡' : '♟'} ${esc(cfg.username)}</span>
        <span class="badge badge-blue">Fetching</span>
      </div>
      <strong>${fetched} / ${requested || '?'} fetched</strong>
      <p>${details.total_games_after_merge || 0} usable now · ${details.analysis_ready || 0} positions ready</p>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
    </div>
  `;
}

function statusBadge(status, queuePosition = 0) {
  if (!status)              return '<span class="badge badge-default">Not run</span>';
  if (status === 'queued')  return `<span class="badge badge-amber">Queued #${queuePosition || 1}</span>`;
  if (status === 'running') return '<span class="badge badge-blue">Running</span>';
  if (status === 'done')    return '<span class="badge badge-green">Ready</span>';
  if (status === 'cancelled') return '<span class="badge badge-default">Paused</span>';
  if (status === 'error')   return '<span class="badge badge-red">Error</span>';
  return `<span class="badge badge-default">${esc(status)}</span>`;
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
  if (status === 'queued') return `Queue position ${queuePosition || 1}. ${progress}/${total || '?'} games already analyzed.`;
  if (status === 'running') return `${readyCount} positions ready to practice now.`;
  if (status === 'done') return 'Open the queue to review, practice, and archive mistakes.';
  if (status === 'cancelled') return total > progress ? `Paused at ${progress}/${total} games.` : 'Run was cancelled.';
  if (status === 'error') return error || 'The last run failed.';
  return 'Start analysis to build a training queue from your games.';
}

function severityData(cp) {
  if (cp >= 300) return { label: 'Blunder',    pill: 'pill-blunder',    rowClass: 'blunder'     };
  if (cp >= 150) return { label: 'Mistake',    pill: 'pill-mistake',    rowClass: 'mistake-sev' };
  return           { label: 'Inaccuracy', pill: 'pill-inaccuracy', rowClass: 'inaccuracy'  };
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
  const icon = type === 'success' ? '✓' : type === 'error' ? '✕' : type === 'info' ? 'i' : '';
  el.innerHTML = icon
    ? `<span class="toast-icon">${icon}</span><span>${esc(message)}</span>`
    : `<span>${esc(message)}</span>`;
  const container = document.getElementById('toast');
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .28s ease';
    setTimeout(() => el.remove(), 300);
  }, 3500);
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Convert a single UCI move string to SAN, given the FEN before the move. */
function uciToSan(fen, uci) {
  if (!uci || uci.length < 4) return uci;
  try {
    const chess = new Chess();
    chess.load(fen);
    const move = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || undefined });
    return move ? move.san : uci;
  } catch {
    return uci;
  }
}

/** Convert a space-separated UCI move list from the initial position to SAN array. */
function moveListToSan(moveListStr) {
  if (!moveListStr) return [];
  const chess = new Chess();
  const sans = [];
  for (const uci of moveListStr.trim().split(/\s+/)) {
    if (!uci) continue;
    const move = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || undefined });
    if (!move) break;
    sans.push(move.san);
  }
  return sans;
}

/** Format SAN move list as a numbered sequence string: "1.e4 e5 2.Nf3 Nc6 3.Bb5" */
function formatMoveList(sans) {
  if (!sans || !sans.length) return '';
  const parts = [];
  sans.forEach((san, i) => {
    if (i % 2 === 0) parts.push(`${Math.floor(i / 2) + 1}.${san}`);
    else parts.push(san);
  });
  return parts.join(' ');
}

/** Build SM-2 prioritised practice queue. Due positions first, then by due date. */
function buildSM2Queue(mistakes) {
  const today = new Date().toISOString().split('T')[0];
  const due = [];
  const notDue = [];
  mistakes.forEach((m, i) => {
    if (!m.sm2_due_at || m.sm2_due_at <= today) due.push(i);
    else notDue.push(i);
  });
  shuffle(due);
  notDue.sort((a, b) => (mistakes[a].sm2_due_at || '').localeCompare(mistakes[b].sm2_due_at || ''));
  return [...due, ...notDue];
}

/** Fire-and-forget: record a practice attempt and advance SM-2. */
function recordAttempt(mistakeId, correct) {
  POST('/practice/attempt', { mistake_id: mistakeId, correct }).catch(() => {});
}
