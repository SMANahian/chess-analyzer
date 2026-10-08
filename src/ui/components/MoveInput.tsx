// Type a move instead of dragging: SAN ('Nf3', '0-0', 'e8=N') or UCI, with the legal moves as suggestions.
// Enter submits standard UCI. The keyboard / screen-reader way to play on the Board.
import type { JSX } from 'preact';
import { useId, useMemo, useState } from 'preact/hooks';
import { legalMoves, parseTypedMove } from './moves';

export interface MoveInputProps {
  /** Position the move is played in. */
  fen: string;
  onSubmit(uci: string): void;
  disabled?: boolean;
  /** Visible label, default 'Type your move'. */
  label?: string;
  placeholder?: string;
  /** Hide the visible label (keeps it for screen readers). */
  hideLabel?: boolean;
}

export function MoveInput({ fen, onSubmit, disabled, label = 'Type your move', placeholder = 'e.g. Nf3', hideLabel }: MoveInputProps): JSX.Element {
  const id = useId();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const moves = useMemo(() => legalMoves(fen), [fen]);

  const submit = (e: Event): void => {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;
    const uci = parseTypedMove(fen, value);
    if (!uci) {
      setError(`“${value}” isn’t a legal move here.`);
      return;
    }
    setError(null);
    setText('');
    onSubmit(uci);
  };

  return (
    <form class="move-input" onSubmit={submit}>
      <label for={id} class={hideLabel ? 'sr-only' : 'field-label'}>
        {label}
      </label>
      <div class="move-input-row">
        <input
          id={id}
          class="input"
          type="text"
          inputMode="text"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellcheck={false}
          list={`${id}-moves`}
          placeholder={placeholder}
          value={text}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onInput={e => {
            setText(e.currentTarget.value);
            if (error) setError(null);
          }}
        />
        <button type="submit" class="btn" disabled={disabled || !text.trim()}>
          Play
        </button>
      </div>
      <datalist id={`${id}-moves`}>
        {moves.map(m => (
          <option key={m.uci} value={m.san} />
        ))}
      </datalist>
      {error ? (
        <p class="field-error" id={`${id}-error`} role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
