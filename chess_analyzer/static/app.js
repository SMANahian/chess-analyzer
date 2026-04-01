/**
 * Chess Analyzer — SPA
 *
 * Chessground v9 is ESM-only — must be imported as module.
 * chess.js v1 has proper ESM exports via esm.sh.
 */
import { Chessground } from 'https://cdn.jsdelivr.net/npm/chessground@9.1.1/dist/chessground.min.js';
import { Chess }       from 'https://esm.sh/chess.js@1';

// ── State ─────────────────────────────────────────────────────────────────

const S = {
  status:      null,
  syncConfigs: [],    // platform sync configs from server
  color:       'white',
  mistakes:    [],
  stats:       {},
  runStatus:   null,
  idx:         0,
  ground:      null,
  hintOn:      false,
  pollIds:     {},    // keyed by purpose string
};

// ── Router ────────────────────────────────────────────────────────────────

const ROUTES = {
  '/':               renderUpload,
  '/analysis/white': () => renderAnalysis('white'),
  '/analysis/black': () => renderAnalysis('black'),
  '/mastered':       renderMastered,
};

function route() {
  const hash = location.hash.replace(/^#/, '') || '/';
  document.querySelectorAll('.nav-link').forEach(a =>
    a.classList.toggle('active', a.getAttribute('href') === '#' + hash)
  );
  (ROUTES[hash] || renderUpload)();
}

window.addEventListener('hashchange', route);
window.addEventListener('load', async () => {
  await refreshAll();
  route();
  setInterval(refreshAll, 12_000);
});

// ── API ───────────────────────────────────────────────────────────────────

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
const DELETE = p     => api('DELETE', p);

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

// ── Upload page ───────────────────────────────────────────────────────────

function renderUpload() {
  const cs = S.status?.colors || { white: {}, black: {} };
  document.getElementById('app').innerHTML = `
<div class="max-w-2xl mx-auto px-4 py-8 w-full">
  <h1 class="text-xl font-bold mb-1">Games</h1>
  <p class="text-gray-400 text-sm mb-6">Upload or import games, then run analysis to find your worst opening habits.</p>

  ${!S.status?.engine_ok ? `<div class="bg-red-950/60 border border-red-500/40 rounded-lg p-3 mb-5 text-sm text-red-300">
    Stockfish not found — install it: <code class="bg-black/30 px-1 rounded">${esc(S.status?.engine_hint || 'brew install stockfish')}</code>
  </div>` : ''}

  <div class="grid sm:grid-cols-2 gap-5">
    ${colorCard('white', cs.white)}
    ${colorCard('black', cs.black)}
  </div>

  <div class="mt-6 flex justify-end">
    <button id="btn-clear" class="btn btn-danger text-xs">Clear all data</button>
  </div>
</div>`;

  ['white', 'black'].forEach(c => {
    // Tab switching
    document.querySelectorAll(`[data-tab-group="${c}"]`).forEach(btn => {
      btn.addEventListener('click', () => switchTab(c, btn.dataset.tab));
    });
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
    // Platform sync save buttons
    document.getElementById(`btn-save-lichess-${c}`)?.addEventListener('click', () => saveSyncConfig(c, 'lichess'));
    document.getElementById(`btn-save-chesscom-${c}`)?.addEventListener('click', () => saveSyncConfig(c, 'chesscom'));
    // Analysis button
    document.getElementById(`btn-analyze-${c}`)?.addEventListener('click', () => doAnalyze(c));
  });

  document.getElementById('btn-clear')?.addEventListener('click', doClear);
}

function colorCard(c, info) {
  const cap  = c[0].toUpperCase() + c.slice(1);
  const icon = c === 'white' ? '♔' : '♚';
  const has  = (info.game_count || 0) > 0;
  const run  = info.run_status;

  // Find existing sync configs for this color
  const lcfg = S.syncConfigs.find(x => x.color === c && x.platform === 'lichess');
  const cccfg = S.syncConfigs.find(x => x.color === c && x.platform === 'chesscom');

  return `<div class="bg-[#16213e] rounded-xl border border-white/10 p-5">
  <div class="flex items-center justify-between mb-3">
    <h2 class="font-semibold text-sm flex items-center gap-2">${icon} ${cap}</h2>
    ${has ? `<span class="pill pill-freq">${info.game_count} games</span>` : ''}
  </div>

  <!-- Source tabs -->
  <div class="flex gap-1 mb-3 text-xs" role="tablist">
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

  <!-- Bottom actions -->
  ${has ? `<div class="mt-4 space-y-1.5">
    <button id="btn-analyze-${c}" class="btn btn-primary w-full justify-center text-sm"
      ${run === 'running' ? 'disabled' : ''}>
      ${run === 'running' ? `<span class="spinner"></span> Analyzing…`
      : run === 'done'    ? '↺ Re-analyze'
      : run === 'error'   ? '⚠ Retry analysis'
      :                     '▶ Run analysis'}
    </button>
    ${run === 'done'  ? `<p class="text-center text-xs text-green-400">Done — <a href="#/analysis/${c}" class="underline">view results →</a></p>` : ''}
    ${run === 'error' ? `<p class="text-center text-xs text-red-400 truncate">Error: ${esc(info.run_error||'unknown')}</p>` : ''}
  </div>` : ''}
</div>`;
}

function syncPanel(color, platform, cfg) {
  const run     = cfg?.latest_run;
  const running = run?.status === 'running';
  const done    = run?.status === 'done';
  const errored = run?.status === 'error';
  const lastSync = cfg?.last_synced_at
    ? `Last synced ${timeAgo(cfg.last_synced_at)}`
    : 'Never synced';

  return `<div class="space-y-2">
    <div class="flex gap-2">
      <input id="input-${platform}-${color}" type="text"
        value="${esc(cfg?.username || '')}"
        placeholder="${platform === 'lichess' ? 'Lichess' : 'Chess.com'} username"
        class="flex-1 bg-[#0f3460] border border-white/15 rounded px-2.5 py-1.5 text-sm
               text-gray-100 placeholder-gray-500 focus:outline-none focus:border-accent" />
      <button id="btn-save-${platform}-${color}" class="btn btn-primary px-3 text-xs"
        ${running ? 'disabled' : ''}>
        ${running ? `<span class="spinner"></span>` : cfg ? 'Sync' : 'Save & Sync'}
      </button>
    </div>
    ${cfg ? `<p class="text-xs text-gray-500">${lastSync}
      ${done    ? ` · <span class="text-green-400">+${run.games_new} new games</span>` : ''}
      ${errored ? ` · <span class="text-red-400" title="${esc(run.error||'')}">failed</span>` : ''}
    </p>` : ''}
  </div>`;
}

function switchTab(color, tab) {
  // Update tab button styles
  document.querySelectorAll(`[data-tab-group="${color}"]`).forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  // Show/hide panels
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
    await refreshAll(); renderUpload();
  } catch(e) { toast(e.message, 'error'); }
}

async function saveSyncConfig(color, platform) {
  const input = document.getElementById(`input-${platform}-${color}`);
  const username = input?.value.trim();
  if (!username) { toast('Enter a username', 'error'); return; }
  try {
    const { config_id } = await POST('/sync', { color, platform, username });
    await POST(`/sync/${config_id}/run`);
    toast(`Syncing ${platform} games for ${username}…`);
    await refreshAll(); renderUpload();
    pollSync(config_id, color);
  } catch(e) { toast(e.message, 'error'); }
}

function pollSync(configId, color) {
  const key = `sync-${configId}`;
  if (S.pollIds[key]) clearInterval(S.pollIds[key]);
  S.pollIds[key] = setInterval(async () => {
    await refreshAll();
    const cfg = S.syncConfigs.find(x => x.id === configId);
    if (!cfg?.latest_run || cfg.latest_run.status !== 'running') {
      clearInterval(S.pollIds[key]);
      delete S.pollIds[key];
      if (cfg?.latest_run?.status === 'done') {
        toast(`Sync done — ${cfg.latest_run.games_new} new games added`, 'success');
      }
      const hash = location.hash.replace(/^#/, '') || '/';
      if (hash === '/') renderUpload();
    }
  }, 2000);
}

async function doAnalyze(color) {
  try {
    await POST(`/analyze/${color}`);
    toast(`Analysis started for ${color}…`);
    await refreshStatus(); renderUpload();
    pollAnalysis(color);
  } catch(e) { toast(e.message, 'error'); }
}

function pollAnalysis(color) {
  const key = `analysis-${color}`;
  if (S.pollIds[key]) clearInterval(S.pollIds[key]);
  S.pollIds[key] = setInterval(async () => {
    await refreshStatus();
    if (S.status?.colors?.[color]?.run_status !== 'running') {
      clearInterval(S.pollIds[key]); delete S.pollIds[key];
      const hash = location.hash.replace(/^#/, '') || '/';
      if (hash === '/') renderUpload();
    }
  }, 2000);
}

async function doClear() {
  if (!confirm('Delete ALL data — PGNs, analysis, sync configs?')) return;
  try { await DELETE('/data'); toast('Cleared', 'success'); await refreshAll(); renderUpload(); }
  catch(e) { toast(e.message, 'error'); }
}

// ── Analysis page ─────────────────────────────────────────────────────────

async function renderAnalysis(color) {
  S.color = color;
  setApp(`<div class="flex-1 flex items-center justify-center text-gray-400">
    <span class="spinner mr-2"></span> Loading…</div>`);
  try {
    const d  = await GET(`/analysis/${color}`);
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
  setApp(`<div class="max-w-md mx-auto px-4 py-16 text-center">
    ${running
      ? `<span class="spinner text-3xl text-accent block mb-4"></span>
         <h2 class="text-lg font-semibold mb-2">Analyzing…</h2>
         <p class="text-gray-400 text-sm">This can take a few minutes.</p>`
      : `<div class="text-5xl mb-4">✓</div>
         <h2 class="text-lg font-semibold mb-2">No mistakes found</h2>
         <p class="text-gray-400 text-sm">No recurring mistakes above the threshold, or no games analyzed yet.</p>
         <a href="#/" class="btn btn-primary mt-6 inline-flex">Upload games</a>`}
  </div>`);
  if (running) {
    pollAnalysis(color);
    setTimeout(() => renderAnalysis(color), 3500);
  }
}

function buildAnalysisUI() {
  const c   = S.color;
  const cap = c[0].toUpperCase() + c.slice(1);
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
      <button id="btn-export" class="btn btn-ghost text-xs py-1">Export</button>
    </div>
  </div>

  <!-- body -->
  <div class="flex-1 flex overflow-hidden" style="min-height:0">

    <!-- LEFT: board + controls -->
    <div class="flex flex-col items-center gap-3 p-4 shrink-0">
      <div class="board-wrap" id="board-wrap"></div>
      <div class="flex items-center gap-1">
        <button class="btn btn-ghost px-2 text-base" id="nav-first" title="First">⏮</button>
        <button class="btn btn-ghost px-2 text-base" id="nav-prev"  title="← Prev">◀</button>
        <button class="btn btn-ghost px-2 text-base" id="nav-next"  title="Next →">▶</button>
        <button class="btn btn-ghost px-2 text-base" id="nav-last"  title="Last">⏭</button>
        <span class="w-px h-4 bg-white/15 mx-0.5"></span>
        <button class="btn btn-ghost text-xs" id="btn-hint"    title="H — show best move">Hint</button>
        <button class="btn btn-ghost text-xs" id="btn-flip"    title="F — flip board">Flip</button>
        <button class="btn btn-ghost text-xs" id="btn-lichess" title="Open on Lichess">↗</button>
      </div>
      <p class="text-xs text-gray-600">Click piece to select, click destination to move · or drag</p>
    </div>

    <!-- RIGHT: detail + list -->
    <div class="flex-1 flex flex-col overflow-hidden border-l border-white/10" style="min-width:0">
      <div id="detail" class="shrink-0 border-b border-white/10 p-4"></div>
      <div id="mlist"  class="flex-1 overflow-y-auto p-2 flex flex-col gap-0.5"></div>
    </div>
  </div>
</div>`);

  // Init board — selectable ENABLED for click-to-select-then-move
  const wrap = document.getElementById('board-wrap');
  S.ground = Chessground(wrap, {
    animation:  { enabled: true, duration: 150 },
    highlight:  { lastMove: true, check: true },
    movable:    { free: false, color: null, showDests: true },
    draggable:  { enabled: true },
    selectable: { enabled: true },    // click-to-select mode
    drawable:   { enabled: true },
  });

  const sb = document.getElementById('stat-box');
  if (sb && S.stats.total) {
    sb.textContent = `${S.stats.total} mistakes · avg ${S.stats.avg_cp}cp · worst ${S.stats.max_cp}cp`;
  }

  renderList();

  document.getElementById('nav-first').onclick = () => go(0);
  document.getElementById('nav-prev') .onclick = () => go(S.idx - 1);
  document.getElementById('nav-next') .onclick = () => go(S.idx + 1);
  document.getElementById('nav-last') .onclick = () => go(S.mistakes.length - 1);
  document.getElementById('btn-hint') .onclick = toggleHint;
  document.getElementById('btn-flip') .onclick = flipBoard;
  document.getElementById('btn-lichess').onclick = openLichess;
  document.getElementById('btn-export') .onclick = doExport;
}

function renderList() {
  const el = document.getElementById('mlist');
  if (!el) return;
  el.innerHTML = S.mistakes.map((m, i) => `
<div class="mistake-row ${i === S.idx ? 'active' : ''}" data-i="${i}">
  <span class="text-gray-500 text-xs w-5 text-right shrink-0">${i + 1}</span>
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

  // Update counter + list highlight
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
  <div class="flex gap-5">
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
    <div class="text-gray-500 text-xs mb-1.5">Better moves — drag or click a move to highlight it</div>
    <div class="flex gap-1.5 flex-wrap" id="top-moves">${topHtml}</div>
  </div>` : ''}

  <div class="flex gap-2">
    <button id="btn-master-${idx}" class="btn btn-success text-xs py-1.5">✓ Mastered</button>
    <button id="btn-hint-d"        class="btn btn-ghost   text-xs py-1.5">Show best move (H)</button>
  </div>
</div>`;

  document.getElementById(`btn-master-${idx}`)?.addEventListener('click', () => doMaster(m, idx));
  document.getElementById('btn-hint-d')?.addEventListener('click', toggleHint);

  // Click a top-move badge → highlight arrow on board
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
    toast('Correct! Great move.', 'success');
    setTimeout(() => go(S.idx + 1), 700);
  } else {
    toast('Not the best here — try again', 'error');
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

function flipBoard() { S.ground.toggleOrientation(); }

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
    if (sb) sb.textContent = `${S.stats.total} mistakes · avg ${S.stats.avg_cp}cp`;
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

function legalDests(chess) {
  const m = new Map();
  chess.moves({ verbose: true }).forEach(({ from, to }) => {
    if (!m.has(from)) m.set(from, []);
    m.get(from).push(to);
  });
  return m;
}

function attachKeys() {
  document.removeEventListener('keydown', _onKey);
  document.addEventListener('keydown', _onKey);
}
function _onKey(e) {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'ArrowLeft'  || e.key === 'ArrowUp')   { e.preventDefault(); go(S.idx - 1); }
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown')  { e.preventDefault(); go(S.idx + 1); }
  if (e.key === 'h' || e.key === 'H') toggleHint();
  if (e.key === 'f' || e.key === 'F') flipBoard();
  if (e.key === 'Home') go(0);
  if (e.key === 'End')  go(S.mistakes.length - 1);
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

  const whiteCount = list.filter(m => m.color === 'white').length;
  const blackCount = list.filter(m => m.color === 'black').length;

  setApp(`<div class="max-w-2xl mx-auto px-4 py-8 w-full">
    <div class="flex items-center justify-between mb-2">
      <h1 class="text-xl font-bold">Mastered</h1>
      <span class="pill pill-ok">${list.length} total</span>
    </div>
    <p class="text-gray-500 text-xs mb-5">♔ ${whiteCount} white · ♚ ${blackCount} black</p>
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

// ── Utilities ─────────────────────────────────────────────────────────────

function setApp(html) { document.getElementById('app').innerHTML = html; }

function cpColor(cp) {
  if (cp >= 300) return 'text-red-400';
  if (cp >= 150) return 'text-orange-400';
  return 'text-yellow-400';
}

function timeAgo(isoStr) {
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 2)   return 'just now';
  if (mins < 60)  return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)   return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function toast(msg, type = '') {
  const el  = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = type === 'success' ? `<span>✓</span> ${esc(msg)}`
               : type === 'error'   ? `<span>✕</span> ${esc(msg)}`
               : esc(msg);
  document.getElementById('toast').appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0'; el.style.transition = 'opacity .25s';
    setTimeout(() => el.remove(), 250);
  }, 3000);
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
