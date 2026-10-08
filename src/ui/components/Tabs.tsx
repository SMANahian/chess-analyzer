// Accessible tabs (WAI-ARIA tablist with roving focus: ←/→/Home/End). Panels are rendered by the caller
// with <TabPanel>, so pages keep full control of their content.
import type { ComponentChildren, JSX } from 'preact';
import { useRef } from 'preact/hooks';

export interface TabItem<T extends string> {
  id: T;
  label: ComponentChildren;
  /** Small count shown after the label. */
  count?: number;
}

export interface TabsProps<T extends string> {
  items: readonly TabItem<T>[];
  value: T;
  onChange(id: T): void;
  /** aria-label of the tablist. */
  label: string;
  /** Prefix for element ids (unique per page), default 'tabs'. */
  idPrefix?: string;
}

const tabId = (prefix: string, id: string): string => `${prefix}-tab-${id}`;
const panelId = (prefix: string, id: string): string => `${prefix}-panel-${id}`;

export function Tabs<T extends string>({ items, value, onChange, label, idPrefix = 'tabs' }: TabsProps<T>): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);
  const onKeyDown = (e: KeyboardEvent): void => {
    const i = items.findIndex(t => t.id === value);
    const next =
      e.key === 'ArrowRight' ? (i + 1) % items.length
      : e.key === 'ArrowLeft' ? (i - 1 + items.length) % items.length
      : e.key === 'Home' ? 0
      : e.key === 'End' ? items.length - 1
      : -1;
    const item = items[next];
    if (!item) return;
    e.preventDefault();
    onChange(item.id);
    listRef.current?.querySelector<HTMLElement>(`#${CSS.escape(tabId(idPrefix, item.id))}`)?.focus();
  };
  return (
    <div class="tabs" role="tablist" aria-label={label} ref={listRef} onKeyDown={onKeyDown}>
      {items.map(t => {
        const selected = t.id === value;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={tabId(idPrefix, t.id)}
            class="tab"
            aria-selected={selected}
            aria-controls={panelId(idPrefix, t.id)}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(t.id)}
          >
            {t.label}
            {t.count !== undefined ? <span class="tab-count num">{t.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({ id, idPrefix = 'tabs', children }: { id: string; idPrefix?: string; children: ComponentChildren }): JSX.Element {
  return (
    <div role="tabpanel" id={panelId(idPrefix, id)} aria-labelledby={tabId(idPrefix, id)} tabIndex={0} class="tab-panel">
      {children}
    </div>
  );
}
