/**
 * Chess Analyzer — SPA
 * Chessground v9 (ESM) + chess.js v1 (ESM via esm.sh)
 */
import { Chessground } from 'https://cdn.jsdelivr.net/npm/chessground@9.1.1/dist/chessground.min.js';
import { Chess }       from 'https://esm.sh/chess.js@1';

// ── Global state ──────────────────────────────────────────────────────────

const S = {
  status:      null,
  syncConfigs: [],
  color:       'white',
  mistakes:    [],
  stats:       {},
  runStatus:   null,
  idx:         0,
  ground:      null,
  hintOn:      false,
  pollIds:     {},
};

// Practice-specific state (reset each session)
const P = {
  all:         [],    // all mistakes for color
  queue:       [],    // shuffled indices
  qIdx:        0,
  streak:      0,
  bestStreak:  0,
  correct:     0,
  total:       0,
  attempts:    0,     // attempts on current position
  color:       'white',
  ground:      null,
  active:      false,
};

// ── Router ────────────────────────────────────────────────────────────────

const ROUTES = {
  '/':               renderGames,
  '/analysis/white': () => renderAnalysis('white'),
  '/analysis/black': () => renderAnalysis('black'),
  '/practice':       renderPractice,
  '/mastered':       renderMastered,
};

function route() {
  const hash = location.hash.replace(/^#/, '') || '/';
  document.querySelectorAll('.nav-link').forEach(a =>
    a.classList.toggle('active', a.getAttribute('href') === '#' + hash)
  );
  (ROUTES[hash] || renderGames)();
}

window.addEventListener('hashchange', route);
window.addEventListener('load', async () => {
  setupShortcutOverlay();
  await refreshAll();
  route();
  setInterval(refreshAll, 12_000);
});

// ── API helpers ───────────────────────────────────────────────────────────

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) {
    opts.body = body;
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch('/api' + path, opts);
  if (!res.ok) {
    const e = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(e.detail || res.statusText);
  }
  return res.json();
}

const GET    = p     => api('GET',    p);
const POST   = (p,b) => api('POST',   p, b);
const PUT    = p     => api('PUT',    p);
const DEL    = p     => api('DELETE', p);

// ── Refresh ───────────────────────────────────────────────────────────────

async function refreshAll() {
  await Promise.all([refreshStatus(), refreshSyncConfigs()]);
  renderEngineBadge();
}

async function refreshStatus() {
  try { S.status = await GET('/status'); } catch { /* offline */ }
}

async function refreshSyncConfigs() {
  try { S.syncConfigs = (await GET('/sync')).configs || []; } catch { /* ignore */ }
}

function renderEngineBadge() {
  const el = document.getElementById('engine-badge');
  if (!el || !S.status) return;
  el.innerHTML = S.status.engine_ok
    ? `<span class="pill pill-ok text-xs">engine ready</span>`
    : `<span class="pill pill-warn text-xs" title="${esc(S.status.engine_path)}">⚠ no engine</span>`;
}

// ── Games / upload page ───────────────────────────────────────────────────

function renderGames() {
  const cs = S.status?.colors || { white: {}, black: {} };
  const sm = S.status?.summary || {};

  document.getElementById('app').innerHTML = `
<div class="max-w-2xl mx-auto px-4 py-6 w-full">

  ${!S.status?.engine_ok ? `<div class="bg-red-950/60 border border-red-500/40 rounded-lg p-3 mb-4 text-sm text-red-300">
    Stockfish not found — install it: <code class="bg-black/30 px-1 rounded">${esc(S.status?.engine_hint || 'brew install stockfish')}</code>
  </div>` : ''}

  <!-- Summary strip -->
  ${sm.total_games ? `<div class="summary-strip rounded-lg mb-4 text-xs">
    <span>📂 <strong>${sm.total_games}</strong> games</span>
    <span>⚠ <strong>${sm.total_mistakes}</strong> mistakes</span>
    <span>✓ <strong>${sm.total_mastered}</strong> mastered</span>
    ${sm.practice_total ? `<span>🎯 <strong>${sm.practice_correct}/${sm.practice_total}</strong> practice</span>` : ''}
  </div>` : ''}

  <h1 class="text-xl font-bold mb-1">Games</h1>
  <p class="text-gray-400 text-sm mb-5">Upload or import games, then run analysis to find your worst opening habits.</p>

  <div class="grid sm:grid-cols-2 gap-5">
    ${colorCard('white', cs.white)}
    ${colorCard('black', cs.black)}
  </div>

  <!-- Sync configs management -->
  ${S.syncConfigs.length ? `<div class="mt-5">
    <h2 class="text-sm font-semibold mb-2 text-gray-400">Sync configs</h2>
    <div class="flex flex-col gap-2">
      ${S.syncConfigs.map(syncConfigRow).join('')}
    </div>
  </div>` : ''}

  <div class="mt-5 flex justify-end gap-2">
    <a href="/api/export" download="chess-analysis.json"
       class="btn btn-ghost text-xs">Export JSON</a>
    <button id="btn-clear" class="btn btn-danger text-xs">Clear all data</button>
  </div>
</div>`;

  ['white', 'black'].forEach(c => {
    // Tab switching
    document.querySelectorAll(`[data-tab-group="${c}"]`).forEach(btn =>
      btn.addEventListener('click', () => switchTab(c, btn.dataset.tab))
    );
    // File upload
    const zone  = document.getElementById(`zone-${c}`);
    const input = document.getElementById(`file-${c}`);
    if (zone) {
      zone.addEventListener('click', () => input.click());
      zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
      zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
      zone.addEventListener('drop', e => {
        e.preventDefault(); zone.classList.remove('drag-over');
        if (e.dataTransfer.files[0]) doUpload(c, e.dataTransfer.files[0]);
      });
      input.addEventListener('change', () => { if (input.files[0]) doUpload(c, input.files[0]); });
    }
    document.getElementById(`btn-save-lichess-${c}`)?.addEventListener('click', () => saveSyncConfig(c, 'lichess'));
    document.getElementById(`btn-save-chesscom-${c}`)?.addEventListener('click', () => saveSyncConfig(c, 'chesscom'));
    document.getElementById(`btn-analyze-${c}`)?.addEventListener('click', () => doAnalyze(c));
  });

  // Sync row actions
  document.querySelectorAll('[data-resync]').forEach(btn =>
    btn.addEventListener('click', () => doResync(+btn.dataset.resync))
  );
  document.querySelectorAll('[data-delsync]').forEach(btn =>
    btn.addEventListener('click', () => doDeleteSync(+btn.dataset.delsync))
  );

  document.getElementById('btn-clear')?.addEventListener('click', doClear);
}

function syncConfigRow(cfg) {
  const run     = cfg.latest_run;
  const running = run?.status === 'running';
  const icon    = cfg.platform === 'lichess' ? '⚡' : '♟';
  const color_icon = cfg.color === 'white' ? '♔' : '♚';
  const lastSync = cfg.last_synced_at ? timeAgo(cfg.last_synced_at) : 'never';
  return `<div class="sync-row">
  <span class="text-sm">${icon}</span>
  <span class="text-xs text-gray-300 flex-1">${color_icon} ${cfg.color} · <strong>${esc(cfg.username)}</strong> on ${cfg.platform}</span>
  <span class="text-xs text-gray-600">${lastSync}</span>
  ${run?.status === 'done' ? `<span class="pill pill-ok text-xs">+${run.games_new}</span>` : ''}
  ${run?.status === 'error' ? `<span class="pill pill-warn text-xs" title="${esc(run.error||'')}">err</span>` : ''}
  <button class="btn-icon" data-resync="${cfg.id}" title="Re-sync" ${running ? 'disabled' : ''}>
    ${running ? `<span class="spinner" style="width:.7em;height:.7em"></span>` : '↺'}
  </button>
  <button class="btn-icon" data-delsync="${cfg.id}" title="Remove">✕</button>
</div>`;
}

function colorCard(c, info) {
  const cap  = c[0].toUpperCase() + c.slice(1);
  const icon = c === 'white' ? '♔' : '♚';
  const has  = (info.game_count || 0) > 0;
  const run  = info.run_status;
  const prog = info.run_progress || 0;
  const progTotal = info.run_progress_total || 0;
  const pct  = progTotal > 0 ? Math.round(prog / progTotal * 100) : 0;

  const lcfg  = S.syncConfigs.find(x => x.color === c && x.platform === 'lichess');
  const cccfg = S.syncConfigs.find(x => x.color === c && x.platform === 'chesscom');

  return `<div class="bg-[#16213e] rounded-xl border border-white/10 p-5">
  <div class="flex items-center justify-between mb-3">
    <h2 class="font-semibold text-sm flex items-center gap-2">${icon} ${cap}</h2>
    ${has ? `<span class="pill pill-freq">${info.game_count} games</span>` : ''}
  </div>

  <!-- Source tabs -->
  <div class="flex gap-1 mb-3" role="tablist">
    <button class="tab-btn active" data-tab-group="${c}" data-tab="file">File</button>
    <button class="tab-btn" data-tab-group="${c}" data-tab="lichess">Lichess</button>
    <button class="tab-btn" data-tab-group="${c}" data-tab="chesscom">Chess.com</button>
  </div>

  <!-- File tab -->
  <div id="tab-${c}-file">
    <div id="zone-${c}" class="drop-zone">
      <input type="file" id="file-${c}" accept=".pgn" class="hidden" />
      <p class="text-gray-400 text-xs">${has
        ? `<span class="text-green-400">✓</span> PGN uploaded — drop a new file to replace`
        : `Drop a <strong>.pgn</strong> file here or click to browse`}</p>
    </div>
  </div>

  <!-- Lichess tab -->
  <div id="tab-${c}-lichess" class="hidden">
    ${syncPanel(c, 'lichess', lcfg)}
  </div>

  <!-- Chess.com tab -->
  <div id="tab-${c}-chesscom" class="hidden">
    ${syncPanel(c, 'chesscom', cccfg)}
  </div>

  <!-- Analysis status + button -->
  ${has ? `<div class="mt-4 space-y-1.5">
    <button id="btn-analyze-${c}" class="btn btn-primary w-full justify-center text-sm"
      ${run === 'running' ? 'disabled' : ''}>
      ${run === 'running' ? `<span class="spinner"></span> Analyzing…`
      : run === 'done'    ? '↺ Re-analyze'
      : run === 'error'   ? '⚠ Retry analysis'
      :                     '▶ Run analysis'}
    </button>
    ${run === 'running' && progTotal > 0 ? `
    <div class="progress-track">
      <div class="progress-fill" style="width:${pct}%"></div>
    </div>
    <p class="text-xs text-gray-600 text-center">${prog} / ${progTotal} positions (${pct}%)</p>` : ''}
    ${run === 'done'  ? `<p class="text-center text-xs text-green-400">Done — <a href="#/analysis/${c}" class="underline">view results →</a></p>` : ''}
    ${run === 'error' ? `<p class="text-center text-xs text-red-400 truncate" title="${esc(info.run_error||'')}">Error: ${esc(info.run_error||'unknown')}</p>` : ''}
  </div>` : ''}
</div>`;
}

function syncPanel(color, platform, cfg) {
  const run     = cfg?.latest_run;
  const running = run?.status === 'running';
  const done    = run?.status === 'done';
  const errored = run?.status === 'error';
  const placeholder = platform === 'lichess' ? 'Lichess username' : 'Chess.com username';
  const lastSync = cfg?.last_synced_at ? `Last synced ${timeAgo(cfg.last_synced_at)}` : 'Never synced';

  return `<div class="space-y-2">
    <div class="flex gap-2">
      <input id="input-${platform}-${color}" type="text"
        value="${esc(cfg?.username || '')}"
        placeholder="${placeholder}"
        class="flex-1 bg-[#0f3460] border border-white/15 rounded px-2.5 py-1.5 text-sm
               text-gray-100 placeholder-gray-500 focus:outline-none focus:border-accent" />
      <button id="btn-save-${platform}-${color}" class="btn btn-primary px-3 text-xs"
        ${running ? 'disabled' : ''}>
        ${running ? `<span class="spinner"></span>` : cfg ? 'Sync' : 'Save & Sync'}
      </button>
    </div>
    ${cfg ? `<p class="text-xs text-gray-500">${lastSync}
      ${done    ? ` · <span class="text-green-400">+${run.games_new} new games</span>` : ''}
      ${errored ? ` · <span class="text-red-400" title="${esc(run.error||'')}">sync failed</span>` : ''}
    </p>` : `<p class="text-xs text-gray-600">Games are stored locally. Only new games are fetched on re-sync.</p>`}
  </div>`;
}

function switchTab(color, tab) {
  document.querySelectorAll(`[data-tab-group="${color}"]`).forEach(btn =>
    btn.classList.toggle('active', btn.dataset.tab === tab)
  );
  ['file', 'lichess', 'chesscom'].forEach(t => {
    const el = document.getElementById(`tab-${color}-${t}`);
    if (el) el.classList.toggle('hidden', t !== tab);
  });
}

async function doUpload(color, file) {
  const fd = new FormData(); fd.append('file', file);
  try {
    const r = await POST(`/pgn/${color}`, fd);
    toast(`${r.game_count} ${color} games uploaded`, 'success');
    await refreshAll(); renderGames();
  } catch(e) { toast(e.message, 'error'); }
}

async function saveSyncConfig(color, platform) {
  const input    = document.getElementById(`input-${platform}-${color}`);
  const username = input?.value.trim();
  if (!username) { toast('Enter a username', 'error'); return; }
  try {
    const { config_id } = await POST('/sync', { color, platform, username });
    await POST(`/sync/${config_id}/run`);
    toast(`Syncing ${platform} games for ${username}…`, 'info');
    await refreshAll(); renderGames();
    pollSync(config_id, color);
  } catch(e) { toast(e.message, 'error'); }
}

async function doResync(configId) {
  try {
    const cfg = S.syncConfigs.find(x => x.id === configId);
    await POST(`/sync/${configId}/run`);
    toast(`Re-syncing ${cfg?.platform || ''}…`, 'info');
    await refreshAll(); renderGames();
    pollSync(configId, cfg?.color || 'white');
  } catch(e) { toast(e.message, 'error'); }
}

async function doDeleteSync(configId) {
  const cfg = S.syncConfigs.find(x => x.id === configId);
  if (!confirm(`Remove sync config for ${cfg?.username} on ${cfg?.platform}?`)) return;
  try {
    await DEL(`/sync/${configId}`);
    toast('Sync config removed', 'success');
    await refreshAll(); renderGames();
  } catch(e) { toast(e.message, 'error'); }
}

function pollSync(configId, color) {
  const key = `sync-${configId}`;
  if (S.pollIds[key]) clearInterval(S.pollIds[key]);
  S.pollIds[key] = setInterval(async () => {
    await refreshAll();
    const cfg = S.syncConfigs.find(x => x.id === configId);
    if (!cfg?.latest_run || cfg.latest_run.status !== 'running') {
      clearInterval(S.pollIds[key]); delete S.pollIds[key];
      if (cfg?.latest_run?.status === 'done') {
        const n = cfg.latest_run.games_new;
        toast(`Sync done — ${n} new game${n !== 1 ? 's' : ''} added`, 'success');
      } else if (cfg?.latest_run?.status === 'error') {
        toast(`Sync failed: ${cfg.latest_run.error || 'unknown error'}`, 'error');
      }
      const hash = location.hash.replace(/^#/, '') || '/';
      if (hash === '/') renderGames();
    }
  }, 2000);
}

async function doAnalyze(color) {
  try {
    await POST(`/analyze/${color}`);
    toast(`Analysis started for ${color}…`, 'info');
    await refreshStatus(); renderGames();
    pollAnalysis(color);
  } catch(e) { toast(e.message, 'error'); }
}

function pollAnalysis(color) {
  const key = `analysis-${color}`;
  if (S.pollIds[key]) clearInterval(S.pollIds[key]);
  S.pollIds[key] = setInterval(async () => {
    await refreshStatus();
    const runStatus = S.status?.colors?.[color]?.run_status;
    const hash = location.hash.replace(/^#/, '') || '/';
    if (hash === '/') renderGames();
    if (runStatus !== 'running') {
      clearInterval(S.pollIds[key]); delete S.pollIds[key];
    }
  }, 1500);
}

async function doClear() {
  if (!confirm('Delete ALL data — PGNs, analysis, sync configs, practice history?')) return;
  try { await DEL('/data'); toast('All data cleared', 'success'); await refreshAll(); renderGames(); }
  catch(e) { toast(e.message, 'error'); }
}

// ── Analysis page ─────────────────────────────────────────────────────────

async function renderAnalysis(color) {
  S.color = color;
  setApp(`<div class="flex-1 flex items-center justify-center text-gray-400">
    <span class="spinner mr-2"></span> Loading…</div>`);
  try {
    const d     = await GET(`/analysis/${color}`);
    S.mistakes  = d.mistakes  || [];
    S.stats     = d.stats     || {};
    S.runStatus = d.run_status;
    S.idx = 0;
  } catch(e) {
    setApp(`<div class="p-8 text-red-400">Error: ${esc(e.message)}</div>`); return;
  }
  if (!S.mistakes.length) { renderEmpty(color); return; }
  buildAnalysisUI();
  loadMistake(0);
  attachKeys();
}

function renderEmpty(color) {
  const running = S.status?.colors?.[color]?.run_status === 'running';
  const prog    = S.status?.colors?.[color]?.run_progress      || 0;
  const total   = S.status?.colors?.[color]?.run_progress_total || 0;
  const pct     = total > 0 ? Math.round(prog / total * 100) : 0;

  setApp(`<div class="max-w-md mx-auto px-4 py-16 text-center">
    ${running
      ? `<span class="spinner text-3xl text-accent block mb-4"></span>
         <h2 class="text-lg font-semibold mb-2">Analyzing…</h2>
         ${total > 0 ? `<div class="progress-track max-w-xs mx-auto mb-2">
           <div class="progress-fill" style="width:${pct}%"></div>
         </div>
         <p class="text-gray-500 text-xs">${prog} / ${total} positions (${pct}%)</p>` : ''}
         <p class="text-gray-400 text-sm mt-2">This can take a few minutes for large games sets.</p>`
      : `<div class="text-5xl mb-4">✓</div>
         <h2 class="text-lg font-semibold mb-2">No mistakes found</h2>
         <p class="text-gray-400 text-sm">No recurring mistakes above the threshold, or no games analyzed yet.</p>
         <a href="#/" class="btn btn-primary mt-6 inline-flex">Upload games</a>`}
  </div>`);
  if (running) {
    pollAnalysis(color);
    setTimeout(() => renderAnalysis(color), 3000);
  }
}

function buildAnalysisUI() {
  const c    = S.color;
  const cap  = c[0].toUpperCase() + c.slice(1);
  const icon = c === 'white' ? '♔' : '♚';

  setApp(`
<div class="flex flex-col h-full" style="min-height:0">
  <!-- header -->
  <div class="shrink-0 bg-[#16213e] border-b border-white/10 px-4 py-2
              flex items-center gap-3 flex-wrap text-sm">
    <span class="font-semibold">${icon} ${cap}</span>
    <span id="ctr" class="text-gray-400 text-xs"></span>
    <div class="ml-auto flex gap-2 items-center">
      <span id="stat-box" class="text-xs text-gray-500"></span>
      <a href="#/practice" class="btn btn-success text-xs py-1">Practice →</a>
      <button id="btn-export" class="btn btn-ghost text-xs py-1">Export</button>
    </div>
  </div>

  <!-- body: flex col on mobile, flex row on ≥640px -->
  <div class="flex-1 flex flex-col sm:flex-row overflow-hidden" style="min-height:0">

    <!-- LEFT: board + controls -->
    <div class="flex flex-col items-center gap-2 p-3 sm:p-4 shrink-0">
      <div class="board-wrap" id="board-wrap"></div>
      <div class="flex items-center gap-1 flex-wrap justify-center">
        <button class="btn btn-ghost px-2 text-base" id="nav-first" title="First">⏮</button>
        <button class="btn btn-ghost px-2 text-base" id="nav-prev"  title="Prev">◀</button>
        <button class="btn btn-ghost px-2 text-base" id="nav-next"  title="Next">▶</button>
        <button class="btn btn-ghost px-2 text-base" id="nav-last"  title="Last">⏭</button>
        <span class="w-px h-4 bg-white/15 mx-0.5"></span>
        <button class="btn btn-ghost text-xs" id="btn-hint"    title="H">Hint</button>
        <button class="btn btn-ghost text-xs" id="btn-flip"    title="F">Flip</button>
        <button class="btn btn-ghost text-xs" id="btn-copy-fen" title="C">FEN</button>
        <button class="btn btn-ghost text-xs" id="btn-lichess" title="Open Lichess">↗</button>
        <button class="btn btn-ghost text-xs" id="btn-help"    title="?">?</button>
      </div>
      <p class="text-xs text-gray-700">Click piece → click square, or drag · H hint · F flip</p>
    </div>

    <!-- RIGHT: detail + list -->
    <div class="flex-1 flex flex-col overflow-hidden border-t sm:border-t-0 sm:border-l border-white/10" style="min-width:0">
      <div id="detail" class="shrink-0 border-b border-white/10 p-4"></div>
      <div id="mlist"  class="flex-1 overflow-y-auto p-2 flex flex-col gap-0.5"></div>
    </div>
  </div>
</div>`);

  const wrap = document.getElementById('board-wrap');
  S.ground = Chessground(wrap, {
    animation:  { enabled: true, duration: 150 },
    highlight:  { lastMove: true, check: true },
    movable:    { free: false, color: null, showDests: true },
    draggable:  { enabled: true },
    drawable:   { enabled: true },
  });

  if (S.stats.total) {
    const sb = document.getElementById('stat-box');
    if (sb) sb.textContent = `${S.stats.total} mistakes · avg ${S.stats.avg_cp}cp · worst ${S.stats.max_cp}cp`;
  }

  renderList();

  document.getElementById('nav-first')  .onclick = () => go(0);
  document.getElementById('nav-prev')   .onclick = () => go(S.idx - 1);
  document.getElementById('nav-next')   .onclick = () => go(S.idx + 1);
  document.getElementById('nav-last')   .onclick = () => go(S.mistakes.length - 1);
  document.getElementById('btn-hint')   .onclick = toggleHint;
  document.getElementById('btn-flip')   .onclick = flipBoard;
  document.getElementById('btn-copy-fen').onclick = copyFen;
  document.getElementById('btn-lichess').onclick = openLichess;
  document.getElementById('btn-export') .onclick = doExport;
  document.getElementById('btn-help')   .onclick = () => document.getElementById('shortcut-overlay').classList.remove('hidden');
}

function renderList() {
  const el = document.getElementById('mlist');
  if (!el) return;
  el.innerHTML = S.mistakes.map((m, i) => `
<div class="mistake-row ${i === S.idx ? 'active' : ''}" data-i="${i}">
  <span class="text-gray-600 text-xs w-5 text-right shrink-0">${i + 1}</span>
  <span class="font-mono text-xs text-gray-200 shrink-0 w-10">${m.user_move}</span>
  <span class="pill pill-cp ml-auto">${m.avg_cp_loss}cp</span>
  <span class="pill pill-freq">${m.pair_count}×</span>
</div>`).join('');

  el.querySelectorAll('.mistake-row').forEach(r =>
    r.addEventListener('click', () => go(+r.dataset.i))
  );
}

function loadMistake(idx) {
  if (idx < 0 || idx >= S.mistakes.length) return;
  S.idx = idx; S.hintOn = false;
  const m = S.mistakes[idx];

  const chess  = new Chess(); chess.load(m.fen);
  const turn   = chess.turn() === 'w' ? 'white' : 'black';
  const orient = m.color || S.color;
  const from   = m.user_move.slice(0, 2);
  const to     = m.user_move.slice(2, 4);

  S.ground.set({
    fen:         m.fen,
    orientation: orient,
    turnColor:   turn,
    movable: {
      color: turn,
      dests: legalDests(chess),
      events: { after: (o, d) => onMove(o, d, m) },
    },
    lastMove: [from, to],
    drawable: {
      autoShapes: [{ orig: from, dest: to, brush: 'red' }],
    },
  });

  const ctr = document.getElementById('ctr');
  if (ctr) ctr.textContent = `${idx + 1} / ${S.mistakes.length}`;
  document.querySelectorAll('.mistake-row').forEach((r, i) =>
    r.classList.toggle('active', i === idx)
  );
  document.querySelectorAll('.mistake-row')[idx]?.scrollIntoView({ block: 'nearest' });
  renderDetail(m, idx);
}

function renderDetail(m, idx) {
  const el = document.getElementById('detail');
  if (!el) return;

  const topHtml = (m.top_moves || []).slice(0, 3).map((mv, i) =>
    `<span class="font-mono text-xs px-2 py-0.5 rounded cursor-pointer
      ${i === 0 ? 'bg-green-900/40 text-green-300' : 'bg-white/5 text-gray-300'}
      hover:bg-green-900/60 transition-colors" data-mv="${mv}" title="Click to highlight">${mv}</span>`
  ).join('');

  el.innerHTML = `
<div class="space-y-3">
  <div class="flex gap-5 flex-wrap">
    <div>
      <div class="text-gray-500 text-xs mb-0.5">You played</div>
      <span class="font-mono font-bold text-red-400">${m.user_move}</span>
    </div>
    <div>
      <div class="text-gray-500 text-xs mb-0.5">CP loss</div>
      <span class="font-bold ${cpColor(m.avg_cp_loss)}">${m.avg_cp_loss}</span>
    </div>
    <div>
      <div class="text-gray-500 text-xs mb-0.5">Seen</div>
      <span class="font-bold text-purple-400">${m.pair_count}×</span>
    </div>
  </div>

  ${topHtml ? `<div>
    <div class="text-gray-500 text-xs mb-1.5">Better moves</div>
    <div class="flex gap-1.5 flex-wrap" id="top-moves">${topHtml}</div>
  </div>` : ''}

  <div class="flex gap-2 flex-wrap">
    <button id="btn-master-${idx}" class="btn btn-success text-xs py-1.5">✓ Mastered</button>
    <button id="btn-hint-d"        class="btn btn-ghost   text-xs py-1.5">Hint (H)</button>
  </div>
</div>`;

  document.getElementById(`btn-master-${idx}`)?.addEventListener('click', () => doMaster(m, idx));
  document.getElementById('btn-hint-d')?.addEventListener('click', toggleHint);

  document.querySelectorAll('#top-moves [data-mv]').forEach(badge => {
    badge.addEventListener('click', () => {
      const mv = badge.dataset.mv;
      S.ground.set({
        drawable: {
          autoShapes: [
            { orig: m.user_move.slice(0,2), dest: m.user_move.slice(2,4), brush: 'red'   },
            { orig: mv.slice(0,2),          dest: mv.slice(2,4),          brush: 'green' },
          ],
        },
      });
    });
  });
}

function onMove(orig, dest, m) {
  const uci = orig + dest;
  if ((m.top_moves || []).includes(uci)) {
    toast('Correct!', 'success');
    setTimeout(() => go(S.idx + 1), 700);
  } else {
    toast('Not the best — try again', 'error');
    setTimeout(() => loadMistake(S.idx), 500);
  }
}

function go(idx) {
  loadMistake(Math.max(0, Math.min(S.mistakes.length - 1, idx)));
}

function toggleHint() {
  S.hintOn = !S.hintOn;
  const m    = S.mistakes[S.idx];
  const from = m.user_move.slice(0, 2);
  const to   = m.user_move.slice(2, 4);
  const shapes = [{ orig: from, dest: to, brush: 'red' }];
  if (S.hintOn && m.top_moves?.length) {
    shapes.push({ orig: m.top_moves[0].slice(0,2), dest: m.top_moves[0].slice(2,4), brush: 'green' });
  }
  S.ground.setAutoShapes(shapes);
}

function flipBoard()  { S.ground.toggleOrientation(); }

function copyFen() {
  const m = S.mistakes[S.idx];
  if (!m) return;
  navigator.clipboard.writeText(m.fen).then(
    () => toast('FEN copied', 'success'),
    () => toast('Copy failed', 'error')
  );
}

function openLichess() {
  const m = S.mistakes[S.idx];
  if (m) window.open(`https://lichess.org/analysis/${encodeURIComponent(m.fen)}`, '_blank');
}

async function doMaster(m, idx) {
  try {
    await PUT(`/mistakes/${m.id}/master`);
    toast('Marked as mastered', 'success');
    S.mistakes.splice(idx, 1);
    if (S.stats.total) S.stats.total--;
    const sb = document.getElementById('stat-box');
    if (sb && S.stats.total) sb.textContent = `${S.stats.total} mistakes · avg ${S.stats.avg_cp}cp`;
    if (!S.mistakes.length) { renderEmpty(S.color); return; }
    renderList();
    loadMistake(Math.min(idx, S.mistakes.length - 1));
  } catch(e) { toast(e.message, 'error'); }
}

async function doExport() {
  try {
    const d    = await GET('/export');
    const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
    const a    = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob), download: 'chess-analysis.json',
    });
    a.click(); URL.revokeObjectURL(a.href);
  } catch(e) { toast(e.message, 'error'); }
}

// ── Practice mode ─────────────────────────────────────────────────────────

async function renderPractice() {
  setApp(`<div class="flex-1 flex items-center justify-center"><span class="spinner"></span></div>`);

  // Load both colors
  let allMistakes = [];
  try {
    const [w, b] = await Promise.all([GET('/analysis/white'), GET('/analysis/black')]);
    allMistakes = [
      ...(w.mistakes || []).map(m => ({ ...m, color: 'white' })),
      ...(b.mistakes || []).map(m => ({ ...m, color: 'black' })),
    ];
  } catch(e) {
    setApp(`<div class="p-8 text-red-400">Error: ${esc(e.message)}</div>`); return;
  }

  if (!allMistakes.length) {
    setApp(`<div class="max-w-md mx-auto px-4 py-16 text-center">
      <div class="text-5xl mb-4">🎯</div>
      <h2 class="text-lg font-semibold mb-2">No mistakes to practice</h2>
      <p class="text-gray-400 text-sm mb-6">Run analysis on your games first to generate practice positions.</p>
      <a href="#/" class="btn btn-primary inline-flex">Upload &amp; Analyze</a>
    </div>`);
    return;
  }

  // Shuffle
  P.all        = allMistakes;
  P.queue      = shuffle([...Array(allMistakes.length).keys()]);
  P.qIdx       = 0;
  P.streak     = 0;
  P.bestStreak = 0;
  P.correct    = 0;
  P.total      = 0;
  P.attempts   = 0;
  P.active     = true;

  buildPracticeUI(allMistakes.length);
  loadPracticePosition();
}

function buildPracticeUI(total) {
  setApp(`
<div class="flex flex-col items-center gap-4 py-5 px-4 w-full max-w-2xl mx-auto">
  <!-- Stats strip -->
  <div class="w-full grid grid-cols-4 gap-2">
    <div class="stat-card">
      <div class="val text-accent" id="p-streak">0</div>
      <div class="lbl">Streak 🔥</div>
    </div>
    <div class="stat-card">
      <div class="val text-green-400" id="p-correct">0</div>
      <div class="lbl">Correct</div>
    </div>
    <div class="stat-card">
      <div class="val text-gray-300" id="p-total">0</div>
      <div class="lbl">Attempted</div>
    </div>
    <div class="stat-card">
      <div class="val text-purple-400" id="p-best">0</div>
      <div class="lbl">Best</div>
    </div>
  </div>

  <!-- Board -->
  <div id="p-board-wrap" class="board-wrap-sm"></div>

  <!-- Instruction / feedback -->
  <div id="p-msg" class="text-sm text-gray-400 text-center min-h-5">
    Find the best move
  </div>

  <!-- Action buttons -->
  <div id="p-actions" class="flex gap-2 flex-wrap justify-center">
    <button id="p-hint"  class="btn btn-ghost text-xs">Hint</button>
    <button id="p-skip"  class="btn btn-ghost text-xs">Skip →</button>
    <button id="p-end"   class="btn btn-danger text-xs">End session</button>
  </div>

  <!-- Position counter -->
  <p id="p-ctr" class="text-xs text-gray-600"></p>
</div>`);

  document.getElementById('p-hint').onclick = pracHint;
  document.getElementById('p-skip').onclick = pracSkip;
  document.getElementById('p-end') .onclick = pracEnd;
}

function loadPracticePosition() {
  if (P.qIdx >= P.queue.length) {
    pracEnd(); return;
  }

  P.attempts = 0;
  const m    = P.all[P.queue[P.qIdx]];
  const chess  = new Chess(); chess.load(m.fen);
  const turn   = chess.turn() === 'w' ? 'white' : 'black';

  const wrap = document.getElementById('p-board-wrap');
  if (!wrap) return;

  if (!P.ground) {
    P.ground = Chessground(wrap, {
      animation: { enabled: true, duration: 150 },
      highlight: { lastMove: true, check: true },
      movable:   { free: false, color: null, showDests: true },
      draggable: { enabled: true },
      drawable:  { enabled: true },
    });
  }

  P.ground.set({
    fen:         m.fen,
    orientation: m.color,
    turnColor:   turn,
    movable: {
      color: turn,
      dests: legalDests(chess),
      events: { after: (o, d) => pracOnMove(o, d, m) },
    },
    lastMove:  [m.user_move.slice(0,2), m.user_move.slice(2,4)],
    drawable:  { autoShapes: [{ orig: m.user_move.slice(0,2), dest: m.user_move.slice(2,4), brush: 'red' }] },
  });

  updatePracticeStats();
  setMsg('Find the best move');
  document.getElementById('p-ctr').textContent =
    `Position ${P.qIdx + 1} of ${P.queue.length}`;
}

function pracOnMove(orig, dest, m) {
  const uci = orig + dest;
  P.attempts++;

  if ((m.top_moves || []).includes(uci)) {
    // Correct!
    P.correct++;
    P.total++;
    P.streak++;
    if (P.streak > P.bestStreak) P.bestStreak = P.streak;
    updatePracticeStats();
    setMsg(`<span class="text-green-400 font-semibold">✓ Correct!</span>`);
    pracFlash('correct');
    P.qIdx++;
    setTimeout(loadPracticePosition, 900);
  } else {
    // Wrong
    P.streak = 0;
    updatePracticeStats();
    setMsg(`<span class="text-red-400 font-semibold">✗ Not the best — try again</span>`);
    pracFlash('wrong');
    // If 2nd wrong attempt, show hint automatically
    if (P.attempts >= 2) {
      setTimeout(() => pracHint(), 400);
    }
    setTimeout(() => loadPracticePosition(), 600);
  }
}

function pracHint() {
  const m = P.all[P.queue[P.qIdx]];
  if (!m || !P.ground) return;
  P.ground.set({
    drawable: {
      autoShapes: [
        { orig: m.user_move.slice(0,2), dest: m.user_move.slice(2,4), brush: 'red'   },
        ...(m.top_moves?.length
          ? [{ orig: m.top_moves[0].slice(0,2), dest: m.top_moves[0].slice(2,4), brush: 'green' }]
          : []),
      ],
    },
  });
  setMsg(`<span class="text-yellow-400">Hint: try ${m.top_moves?.[0] || '?'}</span>`);
}

function pracSkip() {
  P.total++;
  P.streak = 0;
  updatePracticeStats();
  P.qIdx++;
  loadPracticePosition();
}

async function pracEnd() {
  P.active = false;
  // Save session to server
  if (P.total > 0) {
    try {
      // Determine dominant color (or 'mixed' — just use white for now as schema requires white/black)
      const color = P.all[0]?.color || 'white';
      await POST('/practice/session', {
        color, correct: P.correct, total: P.total, best_streak: P.bestStreak,
      });
    } catch { /* non-critical */ }
  }

  const pct = P.total > 0 ? Math.round(P.correct / P.total * 100) : 0;
  const grade = pct >= 80 ? '🏆 Excellent!' : pct >= 60 ? '👍 Good job!' : pct >= 40 ? '📈 Keep going!' : '💪 Keep practicing!';

  setApp(`<div class="max-w-sm mx-auto px-4 py-12 text-center">
    <div class="text-5xl mb-4">${pct >= 80 ? '🏆' : pct >= 60 ? '🎯' : '📊'}</div>
    <h2 class="text-xl font-bold mb-1">Session complete</h2>
    <p class="text-gray-400 text-sm mb-6">${grade}</p>
    <div class="grid grid-cols-2 gap-3 mb-6">
      <div class="stat-card">
        <div class="val text-green-400">${P.correct}</div>
        <div class="lbl">Correct</div>
      </div>
      <div class="stat-card">
        <div class="val text-gray-300">${P.total}</div>
        <div class="lbl">Attempted</div>
      </div>
      <div class="stat-card">
        <div class="val text-accent">${pct}%</div>
        <div class="lbl">Accuracy</div>
      </div>
      <div class="stat-card">
        <div class="val text-purple-400">${P.bestStreak}</div>
        <div class="lbl">Best streak</div>
      </div>
    </div>
    <div class="flex gap-2 justify-center">
      <button id="p-again" class="btn btn-primary">Practice again</button>
      <a href="#/analysis/white" class="btn btn-ghost">View analysis</a>
    </div>
  </div>`);

  document.getElementById('p-again')?.addEventListener('click', renderPractice);
  if (P.ground) { P.ground.destroy?.(); P.ground = null; }
}

function pracFlash(type) {
  const wrap = document.getElementById('p-board-wrap');
  if (!wrap) return;
  wrap.classList.remove('practice-feedback-correct', 'practice-feedback-wrong');
  void wrap.offsetWidth; // reflow
  wrap.classList.add(type === 'correct' ? 'practice-feedback-correct' : 'practice-feedback-wrong');
}

function updatePracticeStats() {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('p-streak',  P.streak);
  set('p-correct', P.correct);
  set('p-total',   P.total);
  set('p-best',    P.bestStreak);
}

function setMsg(html) {
  const el = document.getElementById('p-msg');
  if (el) el.innerHTML = html;
}

// ── Mastered page ─────────────────────────────────────────────────────────

async function renderMastered() {
  setApp(`<div class="flex-1 flex items-center justify-center"><span class="spinner"></span></div>`);
  let list = [];
  try {
    const [w, b] = await Promise.all([GET('/mastered/white'), GET('/mastered/black')]);
    list = [
      ...(w.mastered || []).map(m => ({ ...m, color: 'white' })),
      ...(b.mastered || []).map(m => ({ ...m, color: 'black' })),
    ].sort((a, b) => (b.mastered_at || '').localeCompare(a.mastered_at || ''));
  } catch(e) {
    setApp(`<div class="p-8 text-red-400">Error: ${esc(e.message)}</div>`); return;
  }

  if (!list.length) {
    setApp(`<div class="max-w-md mx-auto px-4 py-16 text-center">
      <div class="text-4xl mb-4">🎯</div>
      <h2 class="text-lg font-semibold mb-2">Nothing mastered yet</h2>
      <p class="text-gray-400 text-sm">Mark mistakes as mastered in the analysis view to track your progress here.</p>
    </div>`);
    return;
  }

  const wc = list.filter(m => m.color === 'white').length;
  const bc = list.filter(m => m.color === 'black').length;

  setApp(`<div class="max-w-2xl mx-auto px-4 py-6 w-full">
    <div class="flex items-center justify-between mb-1">
      <h1 class="text-xl font-bold">Mastered</h1>
      <span class="pill pill-ok">${list.length} total</span>
    </div>
    <p class="text-gray-500 text-xs mb-5">♔ ${wc} white · ♚ ${bc} black</p>
    <div class="flex flex-col gap-2">
      ${list.map(masteredRow).join('')}
    </div>
  </div>`);

  document.querySelectorAll('.btn-restore').forEach(btn =>
    btn.addEventListener('click', async () => {
      try {
        await PUT(`/mistakes/${btn.dataset.id}/restore`);
        toast('Restored to training queue', 'success');
        renderMastered();
      } catch(e) { toast(e.message, 'error'); }
    })
  );
}

function masteredRow(m) {
  const icon = m.color === 'white' ? '♔' : '♚';
  const date = m.mastered_at ? new Date(m.mastered_at).toLocaleDateString() : '—';
  return `<div class="bg-[#16213e] rounded-lg border border-white/10 p-3.5 flex items-center gap-3">
  <span class="text-lg">${icon}</span>
  <div class="flex-1 min-w-0">
    <div class="flex items-center gap-2 flex-wrap">
      <span class="font-mono text-sm text-red-400">${m.user_move}</span>
      <span class="pill pill-cp">${m.avg_cp_loss}cp</span>
      <span class="pill pill-freq">${m.pair_count}×</span>
    </div>
    <div class="text-xs text-gray-600 mt-0.5 truncate" title="${esc(m.fen)}">${esc(m.fen)}</div>
  </div>
  <div class="text-right shrink-0">
    <div class="text-xs text-gray-500 mb-1">${date}</div>
    <button class="btn btn-ghost text-xs py-1 btn-restore" data-id="${m.id}">Restore</button>
  </div>
</div>`;
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────

function setupShortcutOverlay() {
  document.getElementById('shortcut-close')?.addEventListener('click', () =>
    document.getElementById('shortcut-overlay').classList.add('hidden')
  );
  document.getElementById('shortcut-overlay')?.addEventListener('click', e => {
    if (e.target === e.currentTarget)
      document.getElementById('shortcut-overlay').classList.add('hidden');
  });
}

function attachKeys() {
  document.removeEventListener('keydown', _onKey);
  document.addEventListener('keydown', _onKey);
}

function _onKey(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  switch (e.key) {
    case 'ArrowLeft':  case 'ArrowUp':   e.preventDefault(); go(S.idx - 1);             break;
    case 'ArrowRight': case 'ArrowDown': e.preventDefault(); go(S.idx + 1);             break;
    case 'Home':                                             go(0);                      break;
    case 'End':                                              go(S.mistakes.length - 1); break;
    case 'h': case 'H': toggleHint();   break;
    case 'f': case 'F': flipBoard();    break;
    case 'c': case 'C': copyFen();      break;
    case '?':
      document.getElementById('shortcut-overlay').classList.toggle('hidden');
      break;
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────

function setApp(html) { document.getElementById('app').innerHTML = html; }

function legalDests(chess) {
  const m = new Map();
  chess.moves({ verbose: true }).forEach(({ from, to }) => {
    if (!m.has(from)) m.set(from, []);
    m.get(from).push(to);
  });
  return m;
}

function cpColor(cp) {
  if (cp >= 300) return 'text-red-400';
  if (cp >= 150) return 'text-orange-400';
  return 'text-yellow-400';
}

function timeAgo(isoStr) {
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 2)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = type === 'success' ? `<span>✓</span> ${esc(msg)}`
               : type === 'error'   ? `<span>✕</span> ${esc(msg)}`
               : type === 'info'    ? `<span>ℹ</span> ${esc(msg)}`
               : esc(msg);
  const container = document.getElementById('toast');
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0'; el.style.transition = 'opacity .25s';
    setTimeout(() => el.remove(), 250);
  }, 3000);
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
