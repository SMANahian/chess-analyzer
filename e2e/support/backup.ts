// A hand-made v3 backup holding one leak whose answer is an under-promotion: the Lasker Trap,
// 1.d4 d5 2.c4 e5 3.dxe5 d4 4.e3 Bb4+ 5.Bd2 dxe3 6.Bxb4 exf2+ 7.Ke2 — Black's best is 7…fxg1=N+!,
// while the (made-up) habit is 7…fxg1=Q. The verdicts come from the stored leak, not the engine.
import { START_FEN, lineToSan, playUci, posFromFen, posKey } from '../../src/core/chess';
import { shortId } from '../../src/core/hash';
import { DEFAULT_SETTINGS, type Mistake, type Occurrence, type Profile, type StoredGame } from '../../src/core/types';
import { severityOf, winLoss } from '../../src/core/winrate';
import type { BackupFile } from '../../src/db/backup';

const DAY = 86_400_000;
export const LASKER_PATH = ['d2d4', 'd7d5', 'c2c4', 'e7e5', 'd4e5', 'd5d4', 'e2e3', 'f8b4', 'c1d2', 'd4e3', 'd2b4', 'e3f2', 'e1e2'];
export const LASKER_BEST = 'f2g1n';
export const LASKER_HABIT = 'f2g1q';

function fenAfter(ucis: readonly string[]): string {
  let fen = START_FEN;
  for (const uci of ucis) {
    const next = playUci(fen, uci);
    if (!next) throw new Error(`illegal ${uci} in ${fen}`);
    fen = next;
  }
  return fen;
}

function legalLine(fen: string, line: string[]): string[] {
  if (lineToSan(fen, line).length !== line.length) throw new Error(`illegal line ${line.join(' ')}`);
  return line;
}

export function promotionBackup(now: number): { file: BackupFile; leak: Mistake } {
  const profile: Profile = {
    id: 'me-lasker',
    name: 'Lasker Fan',
    kind: 'self',
    accounts: [],
    aliases: ['lasker fan'],
    createdAt: now - 30 * DAY,
    lastAnalysisAt: now - DAY,
  };
  const games: StoredGame[] = [1, 2, 3].map(i => ({
    key: `${profile.id}|pgn:lasker${i}`,
    profileId: profile.id,
    platform: 'pgn',
    sourceId: `lasker${i}`,
    contentKey: `opponent ${i}|lasker fan|?|${[...LASKER_PATH, LASKER_HABIT].join(' ')}`,
    playedAt: now - i * 7 * DAY,
    color: 'black',
    opponent: `Opponent ${i}`,
    speed: 'blitz',
    rated: true,
    outcome: 'loss',
    moves: [...LASKER_PATH, LASKER_HABIT].join(' '),
  }));
  const fen = fenAfter(LASKER_PATH);
  const key = posKey(posFromFen(fen)!);
  const occurrences: Occurrence[] = games.map(g => ({ g: g.key, t: g.playedAt, s: g.speed, r: g.rated, o: g.outcome, m: LASKER_HABIT }));
  const scoreBest = { cp: 180 };
  const scorePlayed = { cp: -250 };
  const loss = winLoss(scoreBest, scorePlayed);
  const leak: Mistake = {
    id: `${profile.id}|${key}|${LASKER_HABIT}`,
    shortId: shortId(key, LASKER_HABIT),
    profileId: profile.id,
    color: 'black',
    posKey: key,
    fen,
    ply: LASKER_PATH.length,
    path: LASKER_PATH,
    move: LASKER_HABIT,
    kind: 'mistake',
    count: games.length,
    positionCount: games.length,
    occurrences,
    bestMove: LASKER_BEST,
    acceptable: [LASKER_BEST],
    bestLine: legalLine(fen, [LASKER_BEST, 'e2e1', 'd8h4', 'e1d2', 'b8c6']),
    playedLine: legalLine(fen, [LASKER_HABIT, 'h1g1']),
    scoreBest,
    scorePlayed,
    winLoss: loss,
    severity: severityOf(loss, scoreBest, scorePlayed) ?? 'inaccuracy',
    confidence: 'normal',
    impact: 20,
    lastPlayedAt: games[0]!.playedAt,
    lastOutcome: 'habit',
    fixedStreak: 0,
    openingEco: 'D08',
    openingName: 'Queen’s Gambit Declined: Albin Countergambit, Lasker Trap',
    evalDepth: 14,
    engine: 'sf19-lite@1',
    status: 'active',
    createdAt: now - DAY,
    updatedAt: now - DAY,
  };
  const file: BackupFile = {
    app: 'chess-analyzer',
    version: 3,
    exportedAt: now,
    profiles: [profile],
    games,
    syncState: [],
    mistakes: [leak],
    reviews: [],
    attempts: [],
    settings: DEFAULT_SETTINGS,
  };
  return { file, leak };
}
