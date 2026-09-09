'use client';
import { Children, Fragment, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ButtonHTMLAttributes, CSSProperties, KeyboardEvent, ReactNode } from 'react';

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'value' | 'onChange' | 'children'> & {
  value: string | number;
  onValueChange: (value: string) => void;
  children: ReactNode;
  presentation?: 'select' | 'list';
};
type Choice = { value: string; label: ReactNode; title?: string; disabled?: boolean; group?: string };

/** Keep option labels (including empty-value placeholders), groups and disabled entries. */
function readChoices(nodes: ReactNode, group?: string, groupDisabled = false): Choice[] {
  return Children.toArray(nodes).flatMap((node): Choice[] => {
    if (!isValidElement<{ children?: ReactNode; value?: string | number; label?: string; disabled?: boolean; title?: string }>(node)) return [];
    if (node.type === Fragment) return readChoices(node.props.children, group, groupDisabled);
    if (node.type === 'optgroup') return readChoices(node.props.children, node.props.label, !!node.props.disabled);
    if (node.type !== 'option') return [];
    return [{ value: String(node.props.value ?? ''), label: node.props.children, title: node.props.title,
      disabled: groupDisabled || node.props.disabled, group }];
  });
}

/** Shared select: a trigger + viewport-contained popup, or a direct list in the session header. */
export default function PickerControl({ value, onValueChange, children, presentation = 'select', disabled,
  className, style, id, onClick, ...buttonProps }: Props) {
  const inline = presentation === 'list';
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' });
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef({ text: '', at: 0 });
  const generatedId = useId();
  const menuId = `${id ?? generatedId}-options`;
  const choices = readChoices(children);
  const selected = choices.find((choice) => choice.value === String(value) && !choice.disabled)
    ?? choices.find((choice) => choice.value === String(value));

  function close(restoreFocus = true) {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  }

  useLayoutEffect(() => {
    if (!open || inline) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const viewport = window.visualViewport;
      const edgeX = viewport?.offsetLeft ?? 0, edgeY = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? innerWidth, height = viewport?.height ?? innerHeight;
      const below = height + edgeY - rect.bottom - 14, above = rect.top - edgeY - 14;
      const upwards = below < 180 && above > below;
      const menuWidth = Math.min(Math.max(rect.width, 240), width - 24);
      const maxHeight = Math.max(60, Math.min(340, upwards ? above : below));
      setPosition({ width: menuWidth, maxHeight,
        left: Math.max(edgeX + 12, Math.min(rect.left, edgeX + width - menuWidth - 12)),
        top: upwards ? Math.max(edgeY + 12, rect.top - 6 - Math.min(menu.current?.scrollHeight ?? maxHeight, maxHeight)) : rect.bottom + 6 });
    };
    place();
    const observer = new ResizeObserver(place);
    if (menu.current) observer.observe(menu.current);
    const onScroll = (e: Event) => { if (!menu.current?.contains(e.target as Node)) place(); };
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    window.visualViewport?.addEventListener('resize', place);
    window.visualViewport?.addEventListener('scroll', place);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
      window.visualViewport?.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('scroll', place);
    };
  }, [open, inline]);

  useEffect(() => {
    if (!inline && !open) return;
    const chosen = menu.current?.querySelector<HTMLButtonElement>('[data-selected="true"]:not(:disabled)')
      ?? menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)');
    chosen?.focus({ preventScroll: true });
    chosen?.scrollIntoView({ block: 'nearest' });
    search.current = { text: '', at: 0 };
  }, [inline, open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open || inline) return;
    const outside = (e: PointerEvent) => {
      if (!trigger.current?.contains(e.target as Node) && !menu.current?.contains(e.target as Node)) setOpen(false);
    };
    // Capture Escape before a surrounding modal/wizard can close itself.
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      if (e.key === 'Tab') close();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, inline]);

  function navigate(e: KeyboardEvent) {
    const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
    if (!items.length) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | undefined;
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
        : (current + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    } else if (e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const now = Date.now();
      search.current.text = now - search.current.at > 700 ? e.key : search.current.text + e.key;
      search.current.at = now;
      const typed = search.current.text.toLowerCase();
      const prefix = [...typed].every((c) => c === typed[0]) ? typed[0] : typed;
      for (let step = 1; step <= items.length; step++) {
        const index = (current + step) % items.length;
        if (items[index].textContent?.trim().toLowerCase().startsWith(prefix)) { next = index; break; }
      }
    }
    if (next !== undefined) { e.preventDefault(); e.stopPropagation(); items[next].focus(); }
  }

  const list = <div ref={menu} id={menuId} className={`picker-options${inline ? '' : ' picker-popup'}`}
    style={inline ? undefined : position} role={inline ? 'menu' : 'listbox'}
    aria-label={buttonProps['aria-label'] ?? buttonProps.title ?? (inline ? 'Choices' : undefined)}
    aria-labelledby={!inline && !buttonProps['aria-label'] && !buttonProps.title ? id ?? generatedId : undefined}
    onKeyDown={navigate} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
    {choices.map((choice, index) => <Fragment key={`${choice.value}-${index}`}>
      {choice.group && choice.group !== choices[index - 1]?.group && <div className="picker-group-label" role="presentation">{choice.group}</div>}
      <button type="button" role={inline ? 'menuitemradio' : 'option'}
        aria-checked={inline ? choice.value === String(value) : undefined}
        aria-selected={!inline ? choice.value === String(value) : undefined}
        data-selected={choice.value === String(value)} tabIndex={-1}
        disabled={disabled || choice.disabled} title={choice.title}
        onClick={() => { if (!inline) close(); onValueChange(choice.value); }}>
        <span>{inline && choice.value === '' && !choice.disabled ? 'Default' : choice.label}</span>
        <span className="picker-check" aria-hidden="true">{choice.value === String(value) ? '✓' : ''}</span>
      </button>
    </Fragment>)}
    {!choices.length && <div className="picker-group-label">No options available</div>}
  </div>;

  if (inline) return list;
  return <>
    <button {...buttonProps} ref={trigger} id={id ?? generatedId} type="button" role="combobox" aria-haspopup="listbox"
      aria-controls={open ? menuId : undefined} aria-expanded={open} disabled={disabled}
      className={`picker-trigger${className ? ` ${className}` : ''}`} style={style}
      onClick={(e) => { onClick?.(e); if (!e.defaultPrevented) setOpen((v) => !v); }}
      onKeyDown={(e) => {
        buttonProps.onKeyDown?.(e);
        if (!e.defaultPrevented && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
          e.preventDefault(); e.stopPropagation(); setOpen(true);
        }
      }}>
      <span>{selected?.label ?? String(value || 'Select…')}</span><span className="picker-chevron" aria-hidden="true">⌄</span>
    </button>
    {open && createPortal(list, trigger.current?.closest('.claude-root') ?? document.body)}
  </>;
}
