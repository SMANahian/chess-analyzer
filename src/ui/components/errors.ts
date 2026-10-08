// Friendly copy for errors thrown by store actions. Store errors are duck-typed: sources throw a
// SourceError ({ kind, status?, retryAfterMs? }); the store may attach the failing `account`.
import type { Account, OnlinePlatform, SourceErrorKind } from '../../core/types';
import { platformName } from './format';

export interface FriendlyError {
  kind: SourceErrorKind;
  title: string;
  text: string;
  /** The failing site, when known. */
  platform?: OnlinePlatform;
  /** Offer the PGN upload as a way around the problem. */
  suggestPgn: boolean;
}

const KINDS: ReadonlySet<string> = new Set(['not-found', 'closed', 'rate-limited', 'network', 'http', 'aborted', 'unknown']);

function field(err: unknown, key: string): unknown {
  return typeof err === 'object' && err !== null ? (err as Record<string, unknown>)[key] : undefined;
}

function kindOf(err: unknown): SourceErrorKind {
  const kind = field(err, 'kind');
  if (typeof kind === 'string' && KINDS.has(kind)) return kind as SourceErrorKind;
  if (field(err, 'name') === 'AbortError') return 'aborted';
  // fetch() rejects with a bare TypeError when the request is blocked (offline, CORS, ad-blockers).
  if (err instanceof TypeError && /fetch|network|load failed/i.test(err.message)) return 'network';
  return 'unknown';
}

function accountOf(err: unknown): Account | undefined {
  const account = field(err, 'account');
  const platform = field(account, 'platform');
  const username = field(account, 'username');
  if ((platform === 'lichess' || platform === 'chesscom') && typeof username === 'string') return { platform, username };
  return undefined;
}

function platformOf(err: unknown, account: Account | undefined): OnlinePlatform | undefined {
  if (account) return account.platform;
  const p = field(err, 'platform');
  if (p === 'lichess' || p === 'chesscom') return p;
  const msg = messageOf(err).toLowerCase();
  if (msg.includes('lichess')) return 'lichess';
  if (msg.includes('chess.com') || msg.includes('chesscom')) return 'chesscom';
  return undefined;
}

export function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  const msg = field(err, 'message');
  return typeof msg === 'string' ? msg : String(err);
}

/** Maps any thrown value to a title + one-paragraph explanation for the user. */
export function friendlyError(err: unknown): FriendlyError {
  const kind = kindOf(err);
  const account = accountOf(err);
  const platform = platformOf(err, account);
  const site = platform ? platformName(platform) : 'the chess site';
  const who = account ? `“${account.username}”` : 'that username';
  const base = { kind, platform, suggestPgn: false };
  switch (kind) {
    case 'not-found':
      return {
        ...base,
        title: platform ? `No ${site} account ${who}` : 'Account not found',
        text: `We couldn’t find ${who} on ${site}. Check the spelling (capitals don’t matter) — it’s the name in your profile URL.`,
      };
    case 'closed':
      return {
        ...base,
        title: 'This account is closed',
        text: `${site} reports ${who} as closed, so its games can’t be downloaded. If you have a PGN export, you can upload it instead.`,
        suggestPgn: true,
      };
    case 'rate-limited':
      return {
        ...base,
        title: `${platform ? site : 'The site'} asked us to slow down`,
        text: 'Too many requests in a short time. Wait a minute and try again — games already downloaded are kept.',
        suggestPgn: true,
      };
    case 'network':
      return {
        ...base,
        title: `Couldn’t reach ${platform ? site : 'Lichess or Chess.com'}`,
        text: 'Check your internet connection. Ad-blockers, privacy extensions or school/work networks can also block it. You can upload a PGN file instead.',
        suggestPgn: true,
      };
    case 'aborted':
      return { ...base, title: 'Cancelled', text: 'The operation was cancelled.' };
    case 'http':
      return {
        ...base,
        title: `${platform ? site : 'The site'} returned an error`,
        text: `Please try again in a moment. (${messageOf(err)})`,
        suggestPgn: true,
      };
    default:
      return { ...base, title: 'Something went wrong', text: messageOf(err) || 'Unknown error.' };
  }
}
