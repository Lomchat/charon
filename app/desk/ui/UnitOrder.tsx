'use client';
// The order given to a robot, at the foot of its drawer.
//
// It IS the session's composer draft (app/inputDraftStore.ts): what is typed
// here waits for its robot — another robot, another island, the session
// opened in full — and holds back a new-build reload meanwhile.
//
// An image pasted (or a file dropped) here takes Charon's attachment route
// (app/sessionAttachments.ts): uploaded beside the session's code, and its
// PATH spliced into the order — never the bytes (§14.73).
//
// One instance per robot: mount it with `key={session.id}`.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useInputDraft } from '@/app/inputDraftStore';
import { fmtSize, useSessionAttachments } from '@/app/sessionAttachments';

type Props = {
  sessionId: string;
  name: string;
  orderRef: RefObject<HTMLTextAreaElement | null>;
  /** Put the caret in the order as soon as this robot is selected. */
  autoFocus: boolean;
  /** Enter in an EMPTY order: still "Open", as on the board. */
  onOpen: () => void;
  /** Tab in an EMPTY order: on to the next robot that wants you. */
  onNext: (back: boolean) => void;
  onOrder: (text: string) => Promise<void>;
};

export default function UnitOrder({ sessionId, name, orderRef, autoFocus, onOpen, onNext, onOrder }: Props) {
  const [order, setOrder] = useInputDraft(sessionId);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const { pending, upload, dismissPending } = useSessionAttachments(sessionId);
  // An entry with an `error` is a finished failure, not an upload in flight.
  const uploading = pending.some((p) => !p.error);

  // The text and the caret as they are NOW: a path lands seconds after its
  // paste, in whatever was typed meanwhile.
  const orderNow = useRef(order);
  orderNow.current = order;
  const caret = useRef<number | null>(null);

  // Selected ⇒ ready to be given an order: the caret goes to the end of what
  // was already typed for it. Read once, on mount: `autoFocus` changing later
  // must not steal the focus back.
  useEffect(() => {
    const field = orderRef.current;
    if (!field || !autoFocus) return;
    field.focus({ preventScroll: true });
    field.setSelectionRange(field.value.length, field.value.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Two lines that grow with what is typed, up to a third of the drawer.
  useLayoutEffect(() => {
    const field = orderRef.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${Math.min(Math.max(field.scrollHeight, 42), 220)}px`;
  }, [order, orderRef]);

  // The composer's own splice: the path at the caret, a space on either side
  // where there is none.
  const insert = useCallback((text: string) => {
    const cur = orderNow.current;
    const pos = Math.min(caret.current ?? cur.length, cur.length);
    const before = cur.slice(0, pos);
    const after = cur.slice(pos);
    const chunk = `${before && !/\s$/.test(before) ? ' ' : ''}${text}${!after || !/^\s/.test(after) ? ' ' : ''}`;
    const next = before + chunk + after;
    const at = before.length + chunk.length;
    orderNow.current = next;
    caret.current = at;
    setOrder(next);
    // After React commits the value: a selection set before is overwritten.
    requestAnimationFrame(() => {
      const field = orderRef.current;
      if (!field) return;
      field.focus({ preventScroll: true });
      try { field.setSelectionRange(at, at); } catch { /* detached */ }
    });
  }, [setOrder, orderRef]);

  const attach = useCallback((files: File[]) => {
    if (!files.length) return;
    caret.current = orderRef.current?.selectionStart ?? caret.current;
    // One path per file, as each upload lands.
    void upload(files, (att) => insert(att.remotePath));
  }, [upload, insert, orderRef]);

  const send = async () => {
    const text = order.trim();
    // A path still on its way would be missing from what is sent.
    if (!text || sending || uploading) return;
    setSending(true);
    setError(null);
    try {
      await onOrder(text);
      setOrder('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
      // The field was disabled while sending, which drops the caret: back in
      // it, the next order (or the fix of a refused one) is typed right away.
      requestAnimationFrame(() => orderRef.current?.focus({ preventScroll: true }));
    }
  };

  return (
    <form
      className="dk-order"
      data-over={over || undefined}
      onSubmit={(e) => { e.preventDefault(); void send(); }}
      onDragOver={(e) => {
        if (!Array.from(e.dataTransfer.types).includes('Files')) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        const files = Array.from(e.dataTransfer.files ?? []);
        setOver(false);
        if (!files.length) return;
        e.preventDefault();
        attach(files);
      }}
    >
      <span aria-hidden="true">&gt;</span>
      <textarea
        ref={orderRef}
        rows={2}
        value={order}
        onChange={(e) => setOrder(e.target.value)}
        onSelect={(e) => { caret.current = e.currentTarget.selectionStart; }}
        onPaste={(e) => {
          // A screenshot in the clipboard; plain text is the browser's to paste.
          const files = Array.from(e.clipboardData?.files ?? []);
          if (!files.length) return;
          e.preventDefault();
          attach(files);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            // Nothing typed: Enter is still "Open", as on the board.
            if (order.trim()) void send();
            else if (!uploading) onOpen();
          } else if (e.key === 'Tab' && !order && !uploading) {
            e.preventDefault();
            onNext(e.shiftKey);
          }
        }}
        placeholder={`Give ${name} an order…`}
        aria-label={`order for ${name}`}
        disabled={sending}
        spellCheck={false}
        autoComplete="off"
      />
      <button type="submit" className="dk-btn dk-btn-yes" disabled={sending || uploading || !order.trim()}>
        {sending ? 'Sending…' : 'Send'}
      </button>
      {pending.length > 0 && (
        <ul className="dk-order-files" aria-label="attachments on their way">
          {pending.map((p) => (
            <li key={p.key} data-failed={p.error ? '' : undefined} title={p.error ?? undefined}>
              <b>{p.name}</b>
              <span>{p.error ? p.error : `uploading… ${fmtSize(p.size)}`}</span>
              {p.error && (
                // Back to the order: the keys after this click are still for it.
                <button type="button" onClick={() => { dismissPending(p.key); orderRef.current?.focus({ preventScroll: true }); }} aria-label={`dismiss ${p.name}`}>×</button>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <p className="dk-order-error" role="alert">{error}</p>}
    </form>
  );
}
