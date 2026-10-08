// One leak in a list: severity, the habit move as a player writes it, "k of n games", opening and colour.
// Links to #/leaks/<shortId>. Use inside an <ol class="leak-list">.
import type { JSX } from 'preact';
import type { ViewMistake } from '../../core/types';
import { href } from '../router';
import { colorName, moveLabel, plural } from './format';
import { Icon } from './Icon';
import { SeverityPill } from './SeverityPill';

export function LeakRow({ m }: { m: ViewMistake }): JSX.Element {
  return (
    <li>
      <a class="leak-row" href={href('leaks', m.shortId)}>
        <SeverityPill severity={m.severity} kind={m.kind} confidence={m.confidence} compact />
        <span class="leak-main">
          <span class="leak-title">
            <span class="move move-habit">{moveLabel(m.fen, m.move)}</span>
            <span class="leak-count num">
              {' '}
              in {m.viewCount} of {plural(m.viewPositionCount, 'game')}
            </span>
          </span>
          <span class="leak-sub">
            {m.openingName ?? 'Unnamed line'} · as {colorName(m.color)}
          </span>
        </span>
        <Icon name="chevron" size={18} class="leak-chevron" />
      </a>
    </li>
  );
}
