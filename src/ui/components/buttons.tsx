// CopyButton and ConfirmButton.
import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { copyText, toast } from './hooks';
import { Icon } from './Icon';
import { messageOf } from './errors';

export interface CopyButtonProps {
  /** Text to copy, or a (possibly async) producer called on click. */
  text: string | (() => string | Promise<string>);
  label?: ComponentChildren;
  /** Button classes, default 'btn btn-sm'. */
  class?: string;
}

/** Copies text to the clipboard and confirms with "Copied" for 2 s. */
export function CopyButton({ text, label = 'Copy', class: cls = 'btn btn-sm' }: CopyButtonProps): JSX.Element {
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const onClick = async (): Promise<void> => {
    setState('busy');
    try {
      await copyText(typeof text === 'string' ? text : await text());
      setState('done');
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setState('idle'), 2000);
    } catch (err) {
      setState('idle');
      toast('error', `Couldn’t copy: ${messageOf(err)}`);
    }
  };
  return (
    <button type="button" class={cls} onClick={onClick} disabled={state === 'busy'} aria-live="polite">
      <Icon name={state === 'done' ? 'check' : 'copy'} size={18} />
      {state === 'done' ? 'Copied' : label}
    </button>
  );
}

/**
 * A confirming click must come at least this long after the one that armed the button: the second
 * click of a double-click (or an auto-repeated Enter) is not a decision.
 */
export const MIN_CONFIRM_MS = 600;

/**
 * What a click on a two-step button does. `armedAt` is when it was armed (null when not armed),
 * `detail` the click's MouseEvent.detail (2+ for the later clicks of a double/triple click, 0 for
 * keyboard activation).
 */
export function confirmStep(armedAt: number | null, now: number, detail: number): 'arm' | 'confirm' | 'ignore' {
  if (armedAt === null) return 'arm';
  if (detail > 1 || now - armedAt < MIN_CONFIRM_MS) return 'ignore';
  return 'confirm';
}

/** keydown handler for buttons that must not be activated by key auto-repeat (holding Enter or Space). */
export function blockKeyRepeat(e: KeyboardEvent): void {
  if (e.repeat && (e.key === 'Enter' || e.key === ' ')) e.preventDefault();
}

/** Click guard for a destructive button inside a dialog: ignores clicks during the first MIN_CONFIRM_MS and repeated clicks. */
export function isDeliberateClick(openedAt: number, now: number, detail: number): boolean {
  return detail <= 1 && now - openedAt >= MIN_CONFIRM_MS;
}

export interface ConfirmButtonProps {
  children: ComponentChildren;
  /** Label of the second, confirming click. */
  confirmLabel?: ComponentChildren;
  onConfirm(): void | Promise<void>;
  /** Button classes for the first state, default 'btn btn-outline-danger'. */
  class?: string;
  disabled?: boolean;
  /** ms before the armed state reverts, default 4000. */
  timeoutMs?: number;
}

/**
 * Two-step destructive button: the first click arms it ("Click again to confirm"), a second, separate
 * click at least MIN_CONFIRM_MS later runs it. A double-click or a held-down Enter does nothing more
 * than arm it.
 */
export function ConfirmButton({
  children,
  confirmLabel = 'Click again to confirm',
  onConfirm,
  class: cls = 'btn btn-outline-danger',
  disabled,
  timeoutMs = 4000,
}: ConfirmButtonProps): JSX.Element {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const armedAt = useRef<number | null>(null);
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), timeoutMs);
    return () => clearTimeout(id);
  }, [armed, timeoutMs]);
  const disarm = (): void => {
    armedAt.current = null;
    setArmed(false);
  };
  const onClick = async (e: MouseEvent): Promise<void> => {
    const step = confirmStep(armed ? armedAt.current ?? 0 : null, Date.now(), e.detail);
    if (step === 'ignore') return;
    if (step === 'arm') {
      armedAt.current = Date.now();
      setArmed(true);
      return;
    }
    disarm();
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      class={armed ? 'btn btn-danger' : cls}
      onClick={e => void onClick(e)}
      onKeyDown={blockKeyRepeat}
      onBlur={disarm}
      disabled={disabled || busy}
      aria-live="polite"
    >
      {armed ? confirmLabel : children}
    </button>
  );
}
