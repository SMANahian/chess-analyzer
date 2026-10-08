# Source fixtures

**Hand-made, not recorded.** Lichess and Chess.com could not be reached from the sandbox these were
written in. Each file follows the documented response format (Lichess OpenAPI `GameJson` and the
`apiGamesUser` example; Chess.com PubAPI as publicly documented), but the games, ids and timestamps
are invented. Every game that starts from the standard position was checked for legality with
chessops when the files were generated (the Chess960, thematic, bughouse and odds games were not). When real responses are captured (for example by a live-smoke workflow), add them next to
these files instead of replacing them: the tests rely on the edge cases below.

| File | What it is | Edge cases |
| --- | --- | --- |
| `lichess-games.ndjson` | `GET /api/games/user/SMA-Nahian` with `moves=true&tags=true` (NDJSON, newest first, 14 games) | mixed-case user `SMA-Nahian` (id `sma-nahian`); draws without `winner`; a Lichess AI opponent (`aiLevel`, no `user`); an anonymous opponent (`{}`); a `chess960` game; an `aborted` game; a `noStart` game; a thematic arena game (`variant: standard` + `initialFen`); castling both sides (incl. O-O-O); en passant; a promotion (`bxa8=Q`); ultraBullet, bullet, blitz, rapid, classical and correspondence; games longer than 40 plies; a titled opponent with a flair |
| `lichess-user.json` | `GET /api/user/SMA-Nahian` | `count.all` |
| `chesscom-archives.json` | `GET /pub/player/sma-nahian/games/archives` | oldest first |
| `chesscom-2024-04.json` | monthly archive | live blitz with `[%clk]` comments and `[Link]`; a daily game (`/game/daily/`, `1/259200`, `start_time`, no UTC tags, O-O-O); a `chess960` game; a rapid draw by repetition |
| `chesscom-2024-05.json` | monthly archive | bullet win on time for Black (game starts 23:59:40 UTC); a `bughouse` game with drops; a `timevsinsufficient` draw whose PGN has no `UTCDate`/`UTCTime` (exercises the `end_time` fallback); knight odds with `rules: chess` and a non-standard `initial_setup` |
| `chesscom-player.json` | `GET /pub/player/sma-nahian` | the API `username` is lower-case, the profile `url` keeps the display case |
| `games.pgn` | a PGN file mixing LF and CRLF | a Lichess export (same game as the first NDJSON line), a Chess.com export (same game as the first April archive game), an annotated OTB game (comments, `;` comments, nested variations, NAGs, `0-0`, glued move numbers), a Chess960 game, a `[FEN]` start, a forfeit without moves |

`testing.ts` holds the helpers the tests share (fixture loading, a scripted `fetch`, controllable
response bodies). It is Node-only and never imported by the app.
