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

/** Two-step destructive button: the first click arms it ("Click again to confirm"), the second runs it. */
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
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), timeoutMs);
    return () => clearTimeout(id);
  }, [armed, timeoutMs]);
  const onClick = async (): Promise<void> => {
    if (!armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
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
      onClick={onClick}
      onBlur={() => setArmed(false)}
      disabled={disabled || busy}
      aria-live="polite"
    >
      {armed ? confirmLabel : children}
    </button>
  );
}
