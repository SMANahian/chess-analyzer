// About & FAQ: what the numbers mean, how analysis works, privacy, credits and licences.
import type { ComponentChildren, JSX } from 'preact';
import { LOW_CONFIDENCE_BELOW, THRESHOLDS, pawnsForLoss } from '../../core/winrate';
import { SeverityPill } from '../components/SeverityPill';
import { href, type PageProps } from '../router';
import { PRIVACY_TEXT } from './Onboarding';

export const SOURCE_URL = 'https://github.com/SMANahian/chess-analyzer';
const NOTICES_URL = `${SOURCE_URL}/blob/HEAD/THIRD_PARTY_NOTICES.md`;
/** Licence texts shipped with the app (next to index.html), so they are available offline and match the build. */
export const SHIPPED_LICENSES = 'THIRD-PARTY-LICENSES.md';
export const ENGINE_LICENSE = 'engine/COPYING.txt';
/** A file shipped with the build, relative to the app's base (works under any sub-path). */
export const shippedUrl = (path: string, base: string = import.meta.env.BASE_URL): string => `${base.endsWith('/') ? base : `${base}/`}${path}`;

function Ext({ href: url, children }: { href: string; children: ComponentChildren }): JSX.Element {
  return (
    <a href={url} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

function Faq({ q, open, children }: { q: string; open?: boolean; children: ComponentChildren }): JSX.Element {
  return (
    <details class="faq-item" open={open}>
      <summary>{q}</summary>
      <div class="faq-body">{children}</div>
    </details>
  );
}

export default function About(_props: PageProps): JSX.Element {
  return (
    <div class="page page-narrow about">
      <div class="page-head">
        <div>
          <h1>About Chess Analyzer</h1>
          <p class="page-sub">
            Find the opening mistakes you keep repeating — and fix them. Free, private, open source, and it runs entirely in
            your browser.
          </p>
        </div>
      </div>

      <section class="faq" aria-label="Frequently asked questions">
        <Faq q="What is a “leak”?" open>
          <p>
            A leak is a move you played in the <strong>same position in at least two games</strong> that Stockfish says costs
            you at least {THRESHOLDS.inaccuracy}% winning chances. One-off blunders don’t count: the point is the mistakes you
            would repeat next week, in the openings you actually play.
          </p>
          <p>
            Leaks are ranked by how much they cost you recently: how often you played the move (recent games count more) times
            how much it loses.
          </p>
        </Faq>

        <Faq q="What does “win %” mean?">
          <p>
            Engines score positions in pawns. A pawn matters far more in a level position than when you are already winning,
            so — like Lichess — we convert the score into your <strong>chance of winning</strong> and measure how many
            percentage points a move gives away.
          </p>
          <ul class="faq-list">
            <li>
              From an equal position, 5 points ≈ {pawnsForLoss(5).toFixed(2)} pawns and 10 points ≈ {pawnsForLoss(10).toFixed(1)}{' '}
              pawns.
            </li>
            <li>
              <SeverityPill severity="inaccuracy" /> loses {THRESHOLDS.inaccuracy}+ points, <SeverityPill severity="mistake" />{' '}
              {THRESHOLDS.mistake}+, <SeverityPill severity="blunder" /> {THRESHOLDS.blunder}+.
            </li>
            <li>
              Losses between {THRESHOLDS.inaccuracy} and {LOW_CONFIDENCE_BELOW} points are marked <em>borderline</em>: at the
              depth we search, that is within the engine’s own noise. They are hidden unless you turn them on.
            </li>
          </ul>
          <p>Evaluations are always shown from your side: “You: +0.3 → −0.8” means the position went from slightly better for you to worse.</p>
        </Faq>

        <Faq q="Why is my gambit (or favourite opening) flagged?">
          <p>
            Plenty of respected openings — the King’s Gambit, the Budapest, the Blackmar–Diemer — are objectively a little
            dubious. When your move leads to a <strong>named opening position</strong> and costs less than {THRESHOLDS.mistake}{' '}
            points, it is labelled a <SeverityPill severity="inaccuracy" kind="book" /> instead of a leak: it stays out of your
            leak list and training and is shown on the <a href={href('openings')}>Openings</a> page.
          </p>
          <p>Anything else you play on purpose can be marked “This is my repertoire” and won’t be flagged again.</p>
        </Faq>

        <Faq q="How does the analysis work?">
          <ol class="faq-list">
            <li>Your public games are downloaded from Lichess and Chess.com (or read from your PGN file) into this browser.</li>
            <li>
              Every position you reached in two or more games within the first moves (20 half-moves by default) is collected,
              with every move you ever played there.
            </li>
            <li>
              <strong>Stockfish 19</strong> (the “lite” NNUE build, compiled to WebAssembly) checks each one on your device: a
              quick depth-10 search first, then a depth-14 search wherever a move seems to lose 2.5 points or more (Standard
              preset). Quick and Thorough use shallower or deeper searches.
            </li>
            <li>Results are cached, so syncing new games only checks positions that are new.</li>
          </ol>
        </Faq>

        <Faq q="Why is it slow on my phone?">
          <p>
            Stockfish runs on your own device. Phones have fewer fast cores and less memory, so the app uses at most two engines
            there, and a first analysis can take several minutes. Keep the tab open (the app asks the screen to stay on);
            everything found so far is saved, so you can stop and resume at any time. The Quick preset in{' '}
            <a href={href('settings')}>Settings</a> is faster.
          </p>
        </Faq>

        <Faq q="Data & privacy">
          <p>
            <strong>{PRIVACY_TEXT}</strong>
          </p>
          <p>
            Your usernames are sent to Lichess and Chess.com only to download your public games. The app itself is a set of
            static files on GitHub Pages, which — like any web host — sees your IP address. Nothing else leaves your device.
          </p>
          <p>
            Clearing your browser’s site data, or <a href={href('settings')}>Settings → Delete all data</a>, removes everything.
            Download a backup first if you want to keep your training progress.
          </p>
        </Faq>

        <Faq q="Credits & licences">
          <ul class="faq-list">
            <li>
              <Ext href="https://stockfishchess.org">Stockfish 19</Ext> via <Ext href="https://github.com/nmrugg/stockfish.js">stockfish.js</Ext> — GPL-3.0
            </li>
            <li>
              <Ext href="https://github.com/lichess-org/chessground">chessground</Ext> and{' '}
              <Ext href="https://github.com/niklasf/chessops">chessops</Ext> by the Lichess team — GPL-3.0-or-later; cburnett pieces — GPL-2.0-or-later
            </li>
            <li>
              Opening names from <Ext href="https://github.com/lichess-org/chess-openings">lichess-org/chess-openings</Ext> — CC0
            </li>
            <li>Preact (MIT), Dexie.js (Apache-2.0), Workbox (MIT)</li>
          </ul>
          <p>
            Because it bundles GPL components, the app as a whole is distributed under GPL-3.0 terms. Full list:{' '}
            <Ext href={NOTICES_URL}>THIRD_PARTY_NOTICES</Ext>.
          </p>
          <p>
            Shipped with this copy of the app: <Ext href={shippedUrl(SHIPPED_LICENSES)}>full licence texts of the bundled components</Ext> and{' '}
            <Ext href={shippedUrl(ENGINE_LICENSE)}>Stockfish’s licence (GPL-3.0)</Ext>.
          </p>
        </Faq>

        <Faq q="Is this made by Lichess or Chess.com?">
          <p>
            No. Chess Analyzer is an independent open-source project, not affiliated with or endorsed by Lichess or Chess.com.
            It uses their public game APIs.
          </p>
        </Faq>

        <Faq q="I found a bug">
          <p>
            Please open an issue on <Ext href={`${SOURCE_URL}/issues`}>GitHub</Ext> and paste the output of{' '}
            <a href={href('settings')}>Settings → Copy diagnostics</a> (it contains no games).
          </p>
        </Faq>
      </section>

      <section class="card about-source">
        <p>
          Source code: <Ext href={SOURCE_URL}>github.com/SMANahian/chess-analyzer</Ext>
        </p>
      </section>
    </div>
  );
}
