import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHANNEL,
  JOB_LOCK,
  broadcastJob,
  holdWakeLock,
  isJobLockHeld,
  onJobBroadcast,
  queryJobLock,
  requestPersistentStorage,
  withJobLock,
  type JobMessage,
} from './jobs';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A minimal navigator.locks with `ifAvailable` semantics (one holder per name). */
function fakeLocks(): { held: Set<string>; request: (name: string, opts: { ifAvailable: boolean }, cb: (lock: unknown) => Promise<unknown>) => Promise<unknown> } {
  const held = new Set<string>();
  return {
    held,
    async request(name, opts, cb) {
      if (held.has(name)) {
        if (opts.ifAvailable) return cb(null);
        throw new Error('test lock manager only supports ifAvailable');
      }
      held.add(name);
      try {
        return await cb({ name });
      } finally {
        held.delete(name);
      }
    },
  };
}

const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 20));

describe('withJobLock', () => {
  it('runs the job directly where Web Locks are unsupported', async () => {
    vi.stubGlobal('navigator', {});
    expect(await withJobLock(async () => 7)).toBe(7);
  });

  it('holds the lock while the job runs; a second job (another tab) gets null and does not run', async () => {
    const locks = fakeLocks();
    vi.stubGlobal('navigator', { locks });
    let release!: () => void;
    const first = withJobLock(
      () =>
        new Promise<string>(resolve => {
          release = () => resolve('first');
        }),
    );
    await flush();
    expect(locks.held.has(JOB_LOCK)).toBe(true);
    const ran = vi.fn(async () => 'second');
    expect(await withJobLock(ran)).toBeNull();
    expect(ran).not.toHaveBeenCalled();
    release();
    expect(await first).toBe('first');
    expect(locks.held.size).toBe(0);
    expect(await withJobLock(ran)).toBe('second');
  });

  it('isJobLockHeld reports a lock held by any tab, and false when it cannot tell', async () => {
    vi.stubGlobal('navigator', { locks: { query: async () => ({ held: [{ name: JOB_LOCK }] }) } });
    expect(await isJobLockHeld()).toBe(true);
    vi.stubGlobal('navigator', { locks: { query: async () => ({ held: [{ name: 'other' }], pending: [] }) } });
    expect(await isJobLockHeld()).toBe(false);
    vi.stubGlobal('navigator', {});
    expect(await isJobLockHeld()).toBe(false);
  });

  it('queryJobLock tells "not held" from "cannot tell"', async () => {
    vi.stubGlobal('navigator', { locks: { query: async () => ({ held: [{ name: JOB_LOCK }] }) } });
    expect(await queryJobLock()).toBe(true);
    vi.stubGlobal('navigator', { locks: { query: async () => ({ held: [] }) } });
    expect(await queryJobLock()).toBe(false);
    vi.stubGlobal('navigator', { locks: { query: async () => Promise.reject(new Error('blocked')) } });
    expect(await queryJobLock()).toBeNull();
    vi.stubGlobal('navigator', { locks: { request: async () => undefined } });
    expect(await queryJobLock()).toBeNull();
    vi.stubGlobal('navigator', {});
    expect(await queryJobLock()).toBeNull();
  });

  it('releases the lock when the job fails', async () => {
    const locks = fakeLocks();
    vi.stubGlobal('navigator', { locks });
    await expect(withJobLock(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(locks.held.size).toBe(0);
  });
});

describe('job broadcasts', () => {
  it('delivers messages from other tabs and ignores malformed ones', async () => {
    const received: JobMessage[] = [];
    const off = onJobBroadcast(msg => received.push(msg));
    const otherTab = new BroadcastChannel(CHANNEL);
    otherTab.postMessage({ type: 'job-started', profileId: 'p1' });
    otherTab.postMessage({ type: 'something-else' });
    otherTab.postMessage({ type: 'job-done', profileId: 'p1' });
    await flush();
    expect(received).toEqual([
      { type: 'job-started', profileId: 'p1' },
      { type: 'job-done', profileId: 'p1' },
    ]);
    off();
    otherTab.postMessage({ type: 'job-done', profileId: 'p2' });
    await flush();
    expect(received).toHaveLength(2);
    otherTab.close();
  });

  it('broadcasts to other tabs but not to this one', async () => {
    const mine: JobMessage[] = [];
    const off = onJobBroadcast(msg => mine.push(msg));
    const otherTab = new BroadcastChannel(CHANNEL);
    const theirs: unknown[] = [];
    otherTab.onmessage = e => theirs.push(e.data);
    broadcastJob({ type: 'job-done', profileId: 'p9' });
    await flush();
    expect(theirs).toEqual([{ type: 'job-done', profileId: 'p9' }]);
    expect(mine).toEqual([]);
    off();
    otherTab.close();
  });
});

describe('holdWakeLock', () => {
  it('is a no-op without the Wake Lock API', async () => {
    vi.stubGlobal('navigator', {});
    const release = await holdWakeLock();
    expect(() => release()).not.toThrow();
  });

  it('acquires the screen lock, re-acquires it when the page becomes visible, and releases it', async () => {
    const sentinels: { released: boolean }[] = [];
    const request = vi.fn(async () => {
      const s = { released: false, release: async () => void (s.released = true) };
      sentinels.push(s);
      return s;
    });
    vi.stubGlobal('navigator', { wakeLock: { request } });
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    vi.stubGlobal('document', doc);
    const release = await holdWakeLock();
    expect(request).toHaveBeenCalledWith('screen');
    doc.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    release();
    await flush();
    expect(sentinels.at(-1)!.released).toBe(true);
    doc.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('runs without the lock when the browser refuses it', async () => {
    vi.stubGlobal('navigator', { wakeLock: { request: async () => Promise.reject(new Error('NotAllowedError')) } });
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    await expect(holdWakeLock()).resolves.toBeTypeOf('function');
  });
});

describe('requestPersistentStorage', () => {
  it('asks for persistence unless storage is already persistent', async () => {
    const persist = vi.fn(async () => true);
    vi.stubGlobal('navigator', { storage: { persisted: async () => false, persist } });
    expect(await requestPersistentStorage()).toBe(true);
    expect(persist).toHaveBeenCalledOnce();

    const persistAgain = vi.fn(async () => true);
    vi.stubGlobal('navigator', { storage: { persisted: async () => true, persist: persistAgain } });
    expect(await requestPersistentStorage()).toBe(true);
    expect(persistAgain).not.toHaveBeenCalled();
  });

  it('is false when unsupported or refused', async () => {
    vi.stubGlobal('navigator', {});
    expect(await requestPersistentStorage()).toBe(false);
    vi.stubGlobal('navigator', { storage: { persist: async () => Promise.reject(new Error('nope')) } });
    expect(await requestPersistentStorage()).toBe(false);
  });
});
