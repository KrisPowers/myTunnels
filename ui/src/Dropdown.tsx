import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useDismiss, usePlace } from "./dismiss";
import { Icon, type IconName } from "./Icon";

export interface Option<T> {
  value: T;
  label: string;
  // A line under the label, saying what the choice does.
  hint?: string;
  icon?: IconName;
  // Shown but not pickable, such as a choice whose app is not installed.
  disabled?: boolean;
}

// Dropdown picks one of `options`: a field showing the choice that opens a
// list of them. The list is drawn over the page, under the field, so no
// card or scroll area cuts it off; it closes on a click outside, Escape, or
// the page scrolling. Arrow keys move through it and Enter picks.
export function Dropdown<T extends string | number>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [at, setAt] = useState({ left: 0, width: 0 });
  const field = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, field, list);
  const current = options.find((o) => o.value === value) ?? options[0];

  // The list lines up with the field; how high is `usePlace`'s.
  useLayoutEffect(() => {
    if (!open || !field.current) return;
    const r = field.current.getBoundingClientRect();
    setAt({ left: r.left, width: Math.max(r.width, 220) });
    // The page scrolling moves the field away; the list scrolling is the list.
    const shut = (e: Event) => {
      if (!list.current?.contains(e.target as Node)) setOpen(false);
    };
    const resized = () => setOpen(false);
    addEventListener("scroll", shut, true);
    addEventListener("resize", resized);
    return () => {
      removeEventListener("scroll", shut, true);
      removeEventListener("resize", resized);
    };
  }, [open, options.length]);
  usePlace(open, field, list, at.left);

  const pick = (v: T) => {
    if (options.find((o) => o.value === v)?.disabled) return;
    onChange(v);
    setOpen(false);
    field.current?.focus();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        setActive(Math.max(0, options.indexOf(current)));
        return setOpen(true);
      }
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((a) => {
        let next = a;
        for (let i = 0; i < options.length; i++) {
          next = (next + step + options.length) % options.length;
          if (!options[next].disabled) break;
        }
        return next;
      });
    } else if ((e.key === "Enter" || e.key === " ") && open) {
      e.preventDefault();
      pick(options[active].value);
    }
  };

  return (
    <>
      <button ref={field} type="button" className={"dropdown" + (open ? " open" : "")} aria-haspopup="listbox" aria-expanded={open} aria-label={label}
        onKeyDown={onKey}
        onClick={() => {
          setActive(Math.max(0, options.indexOf(current)));
          setOpen((o) => !o);
        }}>
        {current?.icon && <Icon name={current.icon} size={18} />}
        <span className="dropdown-value">{current?.label ?? String(value)}</span>
        <svg className="dropdown-caret" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5z" /></svg>
      </button>
      {open && createPortal(
        <ul ref={list} className="dropdown-list" role="listbox" aria-label={label}
          style={{ left: at.left, minWidth: at.width }}>
          {options.map((o, i) => (
            <li key={String(o.value)} role="option" aria-selected={o.value === value} aria-disabled={o.disabled || undefined}
              className={"dropdown-option" + (i === active && !o.disabled ? " active" : "") + (o.disabled ? " unpickable" : "")}
              onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(o.value)}>
              {o.icon && <Icon name={o.icon} size={20} className="dropdown-icon" />}
              <span className="dropdown-text">
                <span>{o.label}</span>
                {o.hint && <small>{o.hint}</small>}
              </span>
            </li>
          ))}
        </ul>,
        document.body,
      )}
    </>
  );
}

// MultiDropdown picks any number of `options`: a field naming what is picked
// that opens the list over the page, where each click adds or removes one and
// the list stays open. Nothing picked means everything.
export function MultiDropdown<T extends string>({ label, values, options, allLabel, onChange }: {
  label: string;
  values: T[];
  options: Option<T>[];
  allLabel: string;
  onChange: (values: T[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState({ left: 0, width: 0 });
  const field = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, field, list);

  useLayoutEffect(() => {
    if (!open || !field.current) return;
    const r = field.current.getBoundingClientRect();
    setAt({ left: r.left, width: Math.max(r.width, 220) });
    const away = (e: Event) => {
      if (!list.current?.contains(e.target as Node)) close();
    };
    addEventListener("scroll", away, true);
    addEventListener("resize", close);
    return () => {
      removeEventListener("scroll", away, true);
      removeEventListener("resize", close);
    };
  }, [open, close]);

  usePlace(open, field, list, at.left);

  const picked = options.filter((o) => values.includes(o.value));
  const shown = picked.length === 0 || picked.length === options.length ? allLabel : picked.map((o) => o.label).join(", ");
  const toggle = (v: T) => onChange(values.includes(v) ? values.filter((x) => x !== v) : [...values, v]);

  return (
    <>
      <button ref={field} type="button" className={"dropdown" + (open ? " open" : "")} aria-haspopup="listbox" aria-expanded={open} aria-label={label}
        onClick={() => setOpen((o) => !o)}>
        <span className="dropdown-value">{shown}</span>
        <svg className="dropdown-caret" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5z" /></svg>
      </button>
      {open && createPortal(
        <ul ref={list} className="dropdown-list multi" role="listbox" aria-multiselectable="true" aria-label={label}
          style={{ left: at.left, minWidth: at.width }}>
          {options.map((o) => (
            <li key={o.value} role="option" aria-selected={values.includes(o.value)} className="dropdown-option"
              onMouseDown={(e) => e.preventDefault()} onClick={() => toggle(o.value)}>
              <span className="check-box" aria-hidden>{values.includes(o.value) && <Icon name="check" size={16} />}</span>
              {o.icon && <Icon name={o.icon} size={20} className="dropdown-icon" />}
              <span className="dropdown-text">
                <span>{o.label}</span>
                {o.hint && <small>{o.hint}</small>}
              </span>
            </li>
          ))}
        </ul>,
        document.body,
      )}
    </>
  );
}
