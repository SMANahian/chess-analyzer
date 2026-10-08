// IndexedDB schema (Dexie). Tables and indexes follow ARCHITECTURE.md "Storage".
import Dexie, { type EntityTable, type Table } from 'dexie';
import type { Attempt, Mistake, PositionEval, Profile, ReviewState, StoredGame, SyncState } from '../core/types';

export const DB_NAME = 'chess-analyzer';

/** Key/value rows: settings, job records, flags. */
export interface MetaRow {
  key: string;
  value: unknown;
}

export class AppDB extends Dexie {
  profiles!: EntityTable<Profile, 'id'>;
  games!: EntityTable<StoredGame, 'key'>;
  syncState!: EntityTable<SyncState, 'key'>;
  evals!: EntityTable<PositionEval, 'key'>;
  mistakes!: EntityTable<Mistake, 'id'>;
  reviews!: EntityTable<ReviewState, 'mistakeId'>;
  attempts!: EntityTable<Attempt, 'id'>;
  meta!: Table<MetaRow, string>;

  constructor(name: string = DB_NAME) {
    super(name);
    this.version(1).stores({
      profiles: 'id, kind',
      games: 'key, profileId, [profileId+playedAt], [profileId+contentKey]',
      syncState: 'key, profileId',
      evals: 'key, posKey, updatedAt',
      mistakes: 'id, profileId, shortId, [profileId+status]',
      reviews: 'mistakeId, profileId, due',
      attempts: '++id, mistakeId, profileId, at',
      meta: 'key',
    });
  }

  /** Every table, for transactions that span the whole database (backup import, clear). */
  allTables(): Table[] {
    return [this.profiles, this.games, this.syncState, this.evals, this.mistakes, this.reviews, this.attempts, this.meta];
  }
}

let current: AppDB | null = null;
let testDbCounter = 0;

/** The app database (singleton). */
export function getDb(): AppDB {
  current ??= new AppDB();
  return current;
}

/** A fresh, empty database for tests (fake-indexeddb); every later getDb() returns it. */
export function useTestDb(name: string = `chess-analyzer-test-${++testDbCounter}`): AppDB {
  current?.close();
  current = new AppDB(name);
  return current;
}
