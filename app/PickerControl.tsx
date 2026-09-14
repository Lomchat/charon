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
type Choice = { value: string; label: ReactNode; title?: string; disabled?: boolean;
  group?: string; search?: string };

/**
 * A stacked option row: the name, then ONE LINE PER FACT under it.
 *
 * Every picker that had something to say beside the name said it as
 * `Name — fact · fact · fact` on one line, which at 10px in a 340px panel is a
 * wall with no shape to scan. Each fact gets its own line instead, so the eye
 * can run down a column (all the prices, all the context windows) rather than
 * re-reading a sentence per row. Shared markup, so a model catalog and a theme
 * list cannot drift apart.
 *
 * Subtitles are HIDDEN in the collapsed trigger (`claude.css § .picker-line`)
 * — one line of room there, and it belongs to the name.
 */
export function PickerOption(
  { title, sub }: { title: ReactNode; sub?: string | null | (string | null | undefined)[] },
) {
  const lines = (Array.isArray(sub) ? sub : [sub]).filter(Boolean) as string[];
  return (
    <span className="picker-line">
      {title}
      {lines.map((line, i) => <small key={i}>{line}</small>)}
    </span>
  );
}

/** Plain text of a label, for the filter to match on when an option does not
 *  carry an explicit `data-search`. */
function nodeText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join(' ');
  if (isValidElement<{ children?: ReactNode; title?: ReactNode; sub?: unknown }>(node)) {
    // `PickerOption` carries its words as PROPS, not children, so walking
    // children alone would make every stacked row unsearchable.
    const { children, title, sub } = node.props;
    const subText = Array.isArray(sub) ? sub.filter(Boolean).join(' ') : (typeof sub === 'string' ? sub : '');
    return [nodeText(children ?? null), nodeText(title ?? null), subText].filter(Boolean).join(' ');
  }
  return '';
}

/** Keep option labels (including empty-value placeholders), groups and disabled entries. */
function readChoices(nodes: ReactNode, group?: string, groupDisabled = false): Choice[] {
  return Children.toArray(nodes).flatMap((node): Choice[] => {
    if (!isValidElement<{ children?: ReactNode; value?: string | number; label?: string;
      disabled?: boolean; title?: string; 'data-search'?: string }>(node)) return [];
    if (node.type === Fragment) return readChoices(node.props.children, group, groupDisabled);
    if (node.type === 'optgroup') return readChoices(node.props.children, node.props.label, !!node.props.disabled);
    if (node.type !== 'option') return [];
    // `data-search` lets an option be findable by more than it displays — a
    // model row matches its ID as well as its name.
    const own = node.props['data-search'];
    return [{ value: String(node.props.value ?? ''), label: node.props.children, title: node.props.title,
      disabled: groupDisabled || node.props.disabled, group,
      search: (own ?? nodeText(node.props.children)).toLowerCase() }];
  });
}

/** Long enough that a reader scrolls instead of scanning. Below it a filter is
 *  furniture; at 39 models it is the difference between finding one and giving
 *  up. */
const SEARCH_THRESHOLD = 12;

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
  const allChoices = readChoices(children);
  const selected = allChoices.find((choice) => choice.value === String(value) && !choice.disabled)
    ?? allChoices.find((choice) => choice.value === String(value));

  // A filter appears once scanning by eye stops working. Driven by the LIST'S
  // OWN LENGTH rather than a per-picker prop, so every long catalog gets it and
  // none can be forgotten; a short mode ladder never grows a search box.
  const [query, setQuery] = useState('');
  const searchable = allChoices.length >= SEARCH_THRESHOLD;
  const needle = searchable ? query.trim().toLowerCase() : '';
  const terms = needle.split(/\s+/).filter(Boolean);
  // Whitespace is AND, never fuzzy — the same rule as the VPS filter.
  const choices = terms.length
    ? allChoices.filter((c) => terms.every((t) => (c.search ?? '').includes(t)))
    : allChoices;
  const searchInput = useRef<HTMLInputElement>(null);

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
      // The bound that matters is the room the popup actually has (`below` /
      // `above`, already measured). The old flat 340px was a second, arbitrary
      // cap on top of it, and it made any list of more than a handful of rows
      // scroll with half the screen empty underneath. Keep a
      // viewport-proportional ceiling instead, so a long catalog still can't
      // become a full-height wall on a large monitor.
      const maxHeight = Math.max(60, Math.min(Math.round(height * 0.62), upwards ? above : below));
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
    // Always scroll the current choice into view; only TAKE focus when there is
    // no search field, which owns it instead (and would be stolen from here).
    chosen?.scrollIntoView({ block: 'nearest' });
    if (!searchable) chosen?.focus({ preventScroll: true });
    else if (!window.matchMedia?.('(pointer: coarse)').matches) {
      // Coarse pointers never autofocus: a phone keyboard would cover the very
      // list being opened (§11). rAF so the portal is laid out first.
      requestAnimationFrame(() => searchInput.current?.focus());
    }
    setQuery('');
    search.current = { text: '', at: 0 };
    // `searchable` is derived from the child list, which is rebuilt every
    // render; opening is the only moment focus should move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    const fromSearch = e.target === searchInput.current;
    // Enter in the field takes the first match — the whole point of typing two
    // letters and committing without reaching for the mouse.
    if (fromSearch && e.key === 'Enter') {
      e.preventDefault(); e.stopPropagation();
      items[0].click();
      return;
    }
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | undefined;
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
        : (current + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    } else if (!searchable && e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
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
    {searchable && (
      <div className="picker-search">
        <input
          ref={searchInput}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="filter…"
          aria-label="Filter the list"
          autoComplete="off"
          spellCheck={false}
        />
      </div>
    )}
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
    {!choices.length && (
      <div className="picker-group-label">
        {needle ? `nothing matches “${query.trim()}”` : 'No options available'}
      </div>
    )}
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
