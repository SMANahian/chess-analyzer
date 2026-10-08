// Form building blocks: Field, Segmented (radio group), Toggle (switch), RangeField, FileButton, DropZone.
import type { ComponentChildren, JSX } from 'preact';
import { useId, useRef, useState } from 'preact/hooks';
import { Icon } from './Icon';

export interface FieldProps {
  label: ComponentChildren;
  /** Id of the control inside (for the <label for>). */
  htmlFor: string;
  hint?: ComponentChildren;
  error?: ComponentChildren;
  children: ComponentChildren;
}

/** Label + control + hint/error. Give the control aria-describedby={`${htmlFor}-hint`} when there is a hint. */
export function Field({ label, htmlFor, hint, error, children }: FieldProps): JSX.Element {
  return (
    <div class="field">
      <label class="field-label" for={htmlFor}>
        {label}
      </label>
      {children}
      {error ? (
        <p class="field-error" id={`${htmlFor}-error`} role="alert">
          {error}
        </p>
      ) : hint ? (
        <p class="field-hint" id={`${htmlFor}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: ComponentChildren;
  /** One line under the label (wide layouts) — e.g. a preset's plain-language explanation. */
  hint?: ComponentChildren;
}

export interface SegmentedProps<T extends string> {
  /** Group label (visible legend). */
  label: ComponentChildren;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange(value: T): void;
  /** Visually hide the legend. */
  hideLabel?: boolean;
  disabled?: boolean;
}

/** Single choice among 2–5 options, as native radios (keyboard: arrows). */
export function Segmented<T extends string>({ label, options, value, onChange, hideLabel, disabled }: SegmentedProps<T>): JSX.Element {
  const name = useId();
  const withHints = options.some(o => o.hint);
  return (
    <fieldset class={`segmented${withHints ? ' segmented-hints' : ''}`} disabled={disabled}>
      <legend class={hideLabel ? 'sr-only' : 'field-label'}>{label}</legend>
      <div class="segmented-options">
        {options.map(o => (
          <label key={o.value} class={`segmented-option${o.value === value ? ' is-checked' : ''}`}>
            <input
              type="radio"
              class="sr-only"
              name={name}
              value={o.value}
              checked={o.value === value}
              onChange={() => onChange(o.value)}
            />
            <span class="segmented-label">{o.label}</span>
            {o.hint ? <span class="segmented-hint">{o.hint}</span> : null}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export interface ToggleProps {
  checked: boolean;
  onChange(checked: boolean): void;
  label: ComponentChildren;
  hint?: ComponentChildren;
  disabled?: boolean;
}

/** On/off switch (a checkbox with role="switch"). */
export function Toggle({ checked, onChange, label, hint, disabled }: ToggleProps): JSX.Element {
  const id = useId();
  return (
    <div class="toggle-row">
      <div class="toggle-text">
        <label for={id} class="field-label">
          {label}
        </label>
        {hint ? (
          <p class="field-hint" id={`${id}-hint`}>
            {hint}
          </p>
        ) : null}
      </div>
      <input
        id={id}
        type="checkbox"
        role="switch"
        class="switch"
        checked={checked}
        disabled={disabled}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={e => onChange(e.currentTarget.checked)}
      />
    </div>
  );
}

export interface RangeFieldProps {
  label: ComponentChildren;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange(value: number): void;
  /** Formats the value shown next to the label, e.g. v => v === 0 ? 'Auto' : `${v} workers`. */
  format?(value: number): string;
  hint?: ComponentChildren;
  disabled?: boolean;
}

/** Slider with its value shown; commits on release (onChange) and previews while dragging. */
export function RangeField({ label, value, min, max, step = 1, onChange, format = String, hint, disabled }: RangeFieldProps): JSX.Element {
  const id = useId();
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? value;
  return (
    <div class="field range-field">
      <div class="row-between">
        <label class="field-label" for={id}>
          {label}
        </label>
        <output class="range-value num" for={id}>
          {format(shown)}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={shown}
        disabled={disabled}
        aria-valuetext={format(shown)}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onInput={e => setDraft(Number(e.currentTarget.value))}
        onChange={e => {
          setDraft(null);
          onChange(Number(e.currentTarget.value));
        }}
      />
      {hint ? (
        <p class="field-hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export interface FileButtonProps {
  onFile(file: File): void;
  accept?: string;
  children: ComponentChildren;
  /** Button classes, default 'btn'. */
  class?: string;
  disabled?: boolean;
}

/** A button that opens the file picker. */
export function FileButton({ onFile, accept, children, class: cls = 'btn', disabled }: FileButtonProps): JSX.Element {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" class={cls} disabled={disabled} onClick={() => input.current?.click()}>
        {children}
      </button>
      <input
        ref={input}
        type="file"
        accept={accept}
        hidden
        onChange={e => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = ''; // picking the same file again still fires
          if (file) onFile(file);
        }}
      />
    </>
  );
}

export interface DropZoneProps {
  onFile(file: File): void;
  accept?: string;
  title: ComponentChildren;
  hint?: ComponentChildren;
  disabled?: boolean;
}

/** Drag-and-drop target that is also a big keyboard/tap-friendly "choose a file" button. */
export function DropZone({ onFile, accept, title, hint, disabled }: DropZoneProps): JSX.Element {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const onDrop = (e: DragEvent): void => {
    e.preventDefault();
    setOver(false);
    const file = e.dataTransfer?.files[0];
    if (file && !disabled) onFile(file);
  };
  return (
    <div
      class={`dropzone${over ? ' is-over' : ''}${disabled ? ' is-disabled' : ''}`}
      onDragOver={e => {
        e.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <button type="button" class="dropzone-button" disabled={disabled} onClick={() => input.current?.click()}>
        <Icon name="upload" size={24} class="dropzone-icon" />
        <span class="dropzone-title">{title}</span>
        {hint ? <span class="dropzone-hint">{hint}</span> : null}
      </button>
      <input
        ref={input}
        type="file"
        accept={accept}
        hidden
        onChange={e => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = '';
          if (file) onFile(file);
        }}
      />
    </div>
  );
}
