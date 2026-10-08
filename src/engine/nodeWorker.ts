// Tests and scripts only — never import this from app code (it needs Node's child_process).
// Runs the vendored stockfish.js glue as a Node child process speaking UCI over stdin/stdout.
// (The glue refuses to start inside worker_threads: it assumes it is an Emscripten pthread there.)
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ENGINE_FILE, type EngineWorkerLike } from './engine';

const DEFAULT_ENGINE_PATH = fileURLToPath(new URL(`../../public/engine/${ENGINE_FILE}`, import.meta.url));

// The glue enters its stdin/stdout UCI mode only when it is the CommonJS main module
// (`require.main === module`), but this repo's package.json says "type": "module", so
// `node stockfish.js` would load it as ESM and crash on `require`. Compile it as the CJS main instead.
const BOOTSTRAP = `
const Module = require('node:module');
const fs = require('node:fs');
const file = process.argv[1];
const m = new Module(file, null);
m.filename = file;
process.mainModule = m;
m._compile(fs.readFileSync(file, 'utf8'), file);
`;

export function createNodeEngineWorker(opts: { enginePath?: string } = {}): EngineWorkerLike {
  const enginePath = opts.enginePath ?? DEFAULT_ENGINE_PATH;
  const env = { ...process.env };
  delete env.NODE_OPTIONS; // test-runner loaders must not leak into the engine
  const child = spawn(process.execPath, ['--input-type=commonjs', '-e', BOOTSTRAP, enginePath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  });
  let closed = false; // no callbacks after terminate() or a reported failure, like a terminated Worker
  let pending = '';
  let stderrTail = '';

  const worker: EngineWorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(msg: string): void {
      if (!closed && child.stdin.writable) child.stdin.write(`${msg}\n`);
    },
    terminate(): void {
      closed = true;
      child.kill('SIGKILL');
    },
  };

  const fail = (err: Error): void => {
    if (closed) return;
    closed = true;
    worker.onerror?.(err);
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    const lines = (pending + chunk).split('\n');
    pending = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (closed) return;
      if (line) worker.onmessage?.({ data: line });
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-2000);
  });
  child.stdin.on('error', () => {}); // EPIPE once the process is gone; reported through 'close'
  child.on('error', err => fail(err));
  child.on('close', (code, signal) => { // after stdio is drained, so stderr is complete
    const detail = stderrTail.trim();
    fail(new Error(`Engine process exited (code ${code}, signal ${signal})${detail ? `: ${detail}` : ''}`));
  });
  return worker;
}
