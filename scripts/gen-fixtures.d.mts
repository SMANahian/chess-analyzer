// Types for the parts of scripts/gen-fixtures.mjs that scripts/build-demo.ts uses.
export const END_TIME: number;

export interface Book {
  readonly lines: readonly { eco: string; name: string; pgn: string; ucis: string[] }[];
}
export interface Repertoire {
  readonly white: unknown;
  readonly black: unknown;
}
export interface SyntheticSide {
  name: string;
  id: string;
  rating: number;
  diff: number;
}
export interface SyntheticGame {
  id: string;
  created: number;
  last: number;
  result: '1-0' | '0-1' | '1/2-1/2';
  white: SyntheticSide;
  black: SyntheticSide;
  sans: string[];
  heroColor: 'white' | 'black';
}

export function loadBook(dataDir?: string): Book;
export function buildRepertoire(book: Book, seed: number): Repertoire;
export function generateGames(opts: {
  book: Book;
  rep: Repertoire;
  seed: number;
  count: number;
  hero: string;
  endTime?: number;
  gapHours?: [number, number];
}): SyntheticGame[];
export function pgnGame(g: SyntheticGame, opts?: { event?: string; utc?: boolean }): string;
