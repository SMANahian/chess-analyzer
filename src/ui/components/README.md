# UI components

Shared building blocks for the pages in `src/ui/pages/`. Pages import only these components, `state/store.ts`
and pure helpers from `src/core/`. Run `npm run dev` and open `#/dev` to see every component in the
dev-only gallery (`Gallery.dev.tsx`, never part of the production build).

## Writing a page

- File: `src/ui/pages/<Name>.tsx`. **Default-export** a component taking `PageProps` (`{ route }` from
  `../router`). `Leaks`, `Train`, `Openings` and `Scout` are lazy-loaded by `app.tsx` when the file exists
  (no edit to `app.tsx` needed). Until then the route shows "Coming soon".
- Routes: `route.name`, `route.id` (`#/leaks/<shortId>`, `#/scout/<profileId>`), `route.query`
  (`#/leaks?opening=Sicilian`). Build links with `href('leaks', shortId, { tab: 'mastered' })` and plain
  `<a href>`; navigate in code with `navigate(href(...), { replace? })`.
- `app.tsx` already guards `leaks`, `train` and `openings`: they render only when a self profile exists.
  Each page is wrapped in an error boundary (a crash shows "Copy diagnostics", not a blank screen).
- Layout classes: `page` (vertical rhythm), `page-head` + `page-sub`, `page-narrow` (760 px reading
  column), `card` / `card-head` / `card-link`, `stack` / `stack-sm` / `stack-lg`, `row` / `row-between`.
  Text: `muted`, `faint`, `small`, `tiny`, `num` (tabular figures), `move` (a SAN move),
  `move-best` (blue) and `move-habit` (orange). Buttons: `btn` + `btn-primary` | `btn-ghost` |
  `btn-danger` | `btn-outline-danger`, sizes `btn-sm` | `btn-lg`, `btn-block`, `btn-icon`; `link-button`.
  Inputs: `input`, `select`. Design tokens are CSS custom properties in `styles/tokens.css`.
- Store actions may throw synchronously or reject. Use `runAction(fn, { success? })` or
  `const [run, pending] = useAction()` from `hooks.ts`: they show a friendly error toast and resolve
  `false` (cancellations are silent).
- Show moves as a chess player writes them: `moveLabel(fen, uci)` → `6…Nxe4`. Show evals from the user's
  side with `<EvalText>`. Best move = **blue**, the user's habit move = **orange** (colour-blind safe,
  always also named in text).

## Components

### `Board` (`Board.tsx`)
Chessground wrapper driven by props. Sizes to its container width (square via CSS `aspect-ratio`;
chessground's own ResizeObserver re-lays out). Destroyed on unmount.

| prop | type | notes |
| --- | --- | --- |
| `fen` | `string` | position shown |
| `orientation` | `'white' \| 'black'` | default `'white'` |
| `interactive` | `boolean` | lets the side to move play legal moves (default `false`) |
| `onMove` | `(uci: string) => void` | **standard UCI** (`e1g1`, `e7e8n`). The board then shows the move, view-only, until props change or `reset()` |
| `arrows` | `BoardArrow[]` | `{ from, to, color: 'blue' \| 'orange' \| 'green' \| 'red' }`; build with `arrowFromUci(uci, color)` |
| `lastMove` | `string` | standard UCI to highlight |
| `check` | `boolean` | default: from the FEN |
| `coordinates` | `boolean` | fixed at mount, default `true` |
| `label` | `string` | accessible description of the position |
| `controller` | `Ref<BoardController>` | see below |
| `class` | `string` | extra classes |

Promotions open a picker over the board (queen, knight, rook, bishop; Esc/click outside cancels).
Castling is accepted by dropping the king on g1/c1.

`BoardController`:
- `replayLine(fromFen, ucis, msPerPly = 450): { done: Promise<boolean>, skip() }` animates a line
  (tap the board or the Skip chip to jump to the end; `done` resolves `false` when skipped). With
  `prefers-reduced-motion` it shows the final position at once. The board stays on the final position,
  view-only, until a prop changes or `reset()`; props changed during a replay are applied when it ends.
  Call it from `useLayoutEffect` to avoid a flash of the `fen` prop.
- `reset()` re-applies the props (e.g. after a wrong move or a refutation replay).

`replayFrames(fromFen, ucis)` is the pure frame list behind it.

Typical Train card: render `<Board fen={card.fen} interactive={!replaying} orientation={userColor}
lastMove={prevMove} controller={ref} onMove={submit} />`, call
`ref.current.replayLine(startFen, lastPlies)` in a layout effect, then enable `interactive`.

### `MoveInput` (`MoveInput.tsx`)
Keyboard/screen-reader move entry. Props: `fen`, `onSubmit(uci)`, `disabled?`, `label?` ('Type your
move'), `placeholder?`, `hideLabel?`. Accepts SAN (`Nf3`, `nf3`, `0-0`, `e8=N`, `exd5+`), or UCI. Suggests
the legal moves (datalist). Illegal input shows an inline error. Helpers in `moves.ts`:
`legalMoves(fen)`, `parseTypedMove(fen, text)`.

### `SeverityPill` (`SeverityPill.tsx`)
`severity`, `kind?` (`'book'` → "Book choice"), `confidence?` (`'low'` → dashed + "borderline"),
`compact?` (glyph only; the word stays for screen readers). Glyphs `?!` / `?` / `??` are exported as
`SEVERITY_GLYPH`, words as `SEVERITY_WORD`.

### `EvalText` (`EvalText.tsx`)
"You: +0.3 → −0.8 (slightly worse)". Props: `from: Score`, `to?: Score` (side-to-move scores, usually
`scoreBest` / `scorePlayed`), `sideToMove: Color` (the FEN's turn), `user: Color`, `who?` ('You').

### `ProgressCard` (`ProgressCard.tsx`)
No props needed (`showFinished?`, default `true`). Reads `syncProgress`, `analysisProgress`, `busy`,
`otherTabBusy` from the store: phase text, counts, progress by weight, ETA, Cancel, "keep this tab
open", "running in another tab", and dismissible "failed / stopped" states with Retry/Resume. Renders
nothing when idle. `JobStatusPill` is the compact header version. `jobView()` is the pure model.

### Notices (`Notice.tsx`, `hooks.ts`)
- `toast(kind, text, action?)` shows a toast (store.notice): `toast('success', 'Snoozed for 30 days', {
  label: 'Undo', run: undo })`. Errors stay until dismissed; others fade (longer with an action).
- `<Banner tone="info|warn|danger|good" icon? title? actions? onDismiss?>` for in-page messages.
- `<NoticeHost>` is mounted once by the app; `<ToastView>` is the presentational toast.

### `LeakRow` (`LeakRow.tsx`)
`<ol class="leak-list">{ms.map(m => <LeakRow key={m.id} m={m} />)}</ol>` — one `ViewMistake` per row:
compact severity pill, habit move (`6…Nxe4`), "in k of n games" (view counts), opening and colour; links
to `#/leaks/<shortId>`. Used by the Dashboard's top leaks.

### `EmptyState` (`EmptyState.tsx`)
`icon?`, `title`, children (text), `actions?`, `tone?: 'neutral' | 'success'`.

### `Modal` / `Sheet` (`Modal.tsx`)
Native `<dialog>` (focus trap, Esc). `open`, `onClose`, `title`, children, `actions?`, `hideTitle?`,
`variant?: 'dialog' | 'sheet'` (`Sheet` = bottom sheet on phones).

### `Spinner` (`Spinner.tsx`)
`label?` ('Loading'; pass `''` when visible text already says it), `size?` (px).

### `Tabs` / `TabPanel` (`Tabs.tsx`)
`<Tabs items={[{ id, label, count? }]} value onChange label idPrefix? />` (arrow keys, Home/End) and
`<TabPanel id idPrefix?>…</TabPanel>`. Use an explicit type argument for literal ids:
`<Tabs<'active' | 'mastered'> …>`.

### `Stat` / `StatGrid` (`Stat.tsx`)
`<Stat label value detail? tone?: 'neutral'|'good'|'warn'|'danger' href? />` inside `<StatGrid>`
(2 columns on phones, 4 on desktop).

### `GameLink` (`GameLink.tsx`)
`game` (a `StoredGame`, `{ platform, sourceId, url? }`, or a game key such as `Occurrence.g`), `ply?`
(plies played: `mistake.ply` = before the habit move, `+ 1` = after it; Lichess only), `color?` (board
orientation on Lichess), children (link text; default "View on Lichess"). PGN imports render plain text.
Pure helpers: `gameUrl`, `parseGameKey` in `format.ts`.

### Buttons (`buttons.tsx`)
- `CopyButton`: `text: string | () => string | Promise<string>`, `label?`, `class?`. Shows "Copied".
- `ConfirmButton`: two-step destructive action. `onConfirm`, children, `confirmLabel?`, `class?`,
  `disabled?`, `timeoutMs?` (4 s).

### Forms (`forms.tsx`)
- `Field`: `label`, `htmlFor`, `hint?`, `error?`, children (the control; give it
  `aria-describedby={`${id}-hint`}`).
- `Segmented<T>`: radio group; `label`, `options: { value, label, hint? }[]`, `value`, `onChange`,
  `hideLabel?`, `disabled?`.
- `Toggle`: switch; `checked`, `onChange`, `label`, `hint?`, `disabled?`.
- `RangeField`: slider with value; `label`, `value`, `min`, `max`, `step?`, `onChange` (on release),
  `format?`, `hint?`.
- `FileButton`: `onFile(file)`, `accept?`, children, `class?`.
- `DropZone`: drag-and-drop + tap to choose; `onFile`, `accept?`, `title`, `hint?`, `disabled?`.

### `Icon` (`Icon.tsx`)
`<Icon name="leaks" size={20} label? />` — decorative unless `label` is given. Names: see `IconName`.

### Feature-page components (Leaks, Train, Openings, Scout)
Styles live in `styles/features.css`, imported by those lazily loaded pages.
- `LeakFilters` (`LeakFilters.tsx`): the Leaks filter bar — search, colour, sort inline; time controls,
  date range, severity, minimum games, opening, rated / borderline / book in a "Filters" sheet. Writes
  `store.setFilters` live. Prop: `now`.
- `LeakListItem` (`LeakListItem.tsx`): a Leaks row — `m`, `href`, `k`/`n` (view counts), `depth`/`parent`
  (indented "after 6.Bc5?!"), `selected`, `now`, optional `status` and `action` (Restore). Also exports
  `OutcomeBadge`.
- `LineView` (`LineView.tsx`): a line of moves ("6…Nxe4 7.Qe2 d5") as buttons — `startFen`, `ucis`,
  `current?`, `onSelect?(i)`, `lead?: 'best' | 'habit'`, `label`, `maxPlies?`. `useLineCursor(path, lines,
  main, contentKey)` steps path → root → line (← / →) and gives the board position to show;
  `stepCursor` is the pure step function.
- `ScoreBar` (`ScoreBar.tsx`): a 0..1 score as "46%" with a coloured bar (`compact` = number only).
- `Skeleton`, `SkeletonRows`, `SkeletonBoard` (`Skeleton.tsx`): loading placeholders with the final size.
- `gestures.ts`: `useSwipe(handlers, enabled)` (horizontal swipes on phones), `isShortcut(e)` /
  `isTypingTarget(target)` for single-key shortcuts.
- `leakView.ts` (pure): tabs (`tabOf`, `tabList`), copy (`habitLabel` → '6…Nxe4?', `headlineOf` /
  `headlineText`, `outcomeBadge`, `punishmentOf` / `punishmentText`, `standingText`), `groupByParent`,
  `viewOfMistake` / `scoreSplit` (view numbers for any status), date ranges (`sinceForMonths`,
  `monthsOfSince`), `filterChips` / `clearedFilters` / `toggleSpeed`, openings (`openingFamily`,
  `openingOptions`, `groupFamilies`, `inOpening`), `lichessAnalysisUrl`, `lineMoves` / `lineText`.
- `trainFlow.ts` (pure): a training card's model — `cardSpec` (self card or prep drill), `replayPlan`,
  `afterVerdict` (done / retry / reveal), `hint`, `reveal`, `gradeAttempt` (via core/srs `autoGrade`),
  `cleanSolve`, `isGraded`, `practiceCards`.

## Helpers

- `format.ts`: `plural`, `formatCount`, `formatPercent`, `relativeTime(ms, now)`, `formatEta`,
  `formatCountdown`, `moveLabel(fen, uci)`, `sideToMove(fen)`, `evalWords(score)`,
  `scoreFor(score, sideToMove, viewer)`, `colorName`, `speedName`, `platformName`, `gameUrl`,
  `parseGameKey`, `isoDate`, `shortDate`.
- `hooks.ts`: `useNow(ms)`, `useMediaQuery(q)`, `prefersReducedMotion()`, `toast`, `runAction`,
  `useAction`, `downloadBlob(blob, name)`, `copyText(text)`.
- `errors.ts`: `friendlyError(err)` → `{ kind, title, text, platform?, suggestPgn }` for store errors
  (`SourceError`, `AccountError`, network `TypeError`, aborts).
- `diagnostics.ts`: boot state (`bootState`, `boot()`) and `collectDiagnostics()` (JSON for bug reports).
- `visits.ts`: `recordVisit(now)` → `{ previous, current }` for "since your last visit".
