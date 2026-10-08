// Modal dialog and bottom sheet on the native <dialog> element (focus trap, Esc and inert background
// for free). A click on the backdrop closes it.
import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { Icon } from './Icon';

export interface ModalProps {
  open: boolean;
  onClose(): void;
  title: string;
  children: ComponentChildren;
  /** Footer buttons. */
  actions?: ComponentChildren;
  /** 'sheet' slides up from the bottom on phones (a centred dialog on wide screens). */
  variant?: 'dialog' | 'sheet';
  /** Hide the visible title (still labels the dialog for screen readers). */
  hideTitle?: boolean;
}

export function Modal({ open, onClose, title, children, actions, variant = 'dialog', hideTitle = false }: ModalProps): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    // 'close' fires for Esc and for d.close(); only report closes we did not cause.
    const onNativeClose = (): void => {
      if (d.dataset.open === 'true') closeRef.current();
    };
    d.addEventListener('close', onNativeClose);
    return () => d.removeEventListener('close', onNativeClose);
  }, []);

  const onClick = (e: MouseEvent): void => {
    if (e.target === ref.current) onClose(); // the backdrop is the dialog element itself
  };

  return (
    <dialog ref={ref} class={`modal modal-${variant}`} aria-label={title} data-open={String(open)} onClick={onClick}>
      <div class="modal-body">
        <div class="modal-head">
          <h2 class={hideTitle ? 'sr-only' : 'modal-title'}>{title}</h2>
          <button type="button" class="btn btn-ghost btn-icon modal-close" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        <div class="modal-content">{children}</div>
        {actions ? <div class="modal-actions">{actions}</div> : null}
      </div>
    </dialog>
  );
}

/** Bottom sheet (phones) — a Modal with variant 'sheet'. */
export function Sheet(props: Omit<ModalProps, 'variant'>): JSX.Element {
  return <Modal {...props} variant="sheet" />;
}
