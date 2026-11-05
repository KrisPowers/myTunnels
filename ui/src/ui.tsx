import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useDismiss } from "./dismiss";
import { message } from "./api";
import { Icon, type IconName } from "./Icon";

// Card is a soft filled block with a heading.
export function Card({ title, sub, action, children }: { title: ReactNode; sub?: ReactNode; action?: ReactNode; children?: ReactNode }) {
  return (
    <section className="card">
      <div className="card-head">
        <div className="card-titles">
          <h2>{title}</h2>
          {sub && <p>{sub}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

// Row is a setting: what it is on the left, its control on the right.
export function Row({ title, sub, children }: { title: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="setting">
      <div className="setting-text">
        <div className="setting-title">{title}</div>
        {sub && <div className="setting-sub">{sub}</div>}
      </div>
      {children}
    </div>
  );
}

export function Switch({ label, on, onChange, disabled }: { label: string; on: boolean; onChange: (on: boolean) => void; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className="switch" disabled={disabled} onClick={() => onChange(!on)}>
      <span />
    </button>
  );
}

// SaveField is a text field that saves itself when it loses focus or Enter is
// pressed, if it changed, and says so beside it.
export function SaveField({ label, value, onSave, placeholder, mono, numeric, width }: {
  label: string;
  value: string;
  onSave: (value: string) => Promise<unknown>;
  placeholder?: string;
  mono?: boolean;
  numeric?: boolean;
  width?: number;
}) {
  const [text, setText] = useState(value);
  const [state, setState] = useState<"" | "saving" | "saved">("");
  const notify = useNotify();
  useEffect(() => setText(value), [value]);
  useEffect(() => {
    if (state !== "saved") return;
    const t = setTimeout(() => setState(""), 1600);
    return () => clearTimeout(t);
  }, [state]);

  const save = async () => {
    if (text === value) return;
    setState("saving");
    try {
      await onSave(text);
      setState("saved");
    } catch (e) {
      setState("");
      setText(value);
      notify(message(e), "bad");
    }
  };

  return (
    <span className="save-field">
      <SaveMark state={state} />
      <input className={"input" + (mono ? " mono" : "")} aria-label={label} value={text} placeholder={placeholder}
        inputMode={numeric ? "numeric" : undefined} style={width ? { width } : undefined}
        autoComplete="off" spellCheck={false} data-1p-ignore data-lpignore="true"
        onChange={(e) => setText(numeric ? e.target.value.replace(/\D/g, "").slice(0, 5) : e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
    </span>
  );
}

export function SaveMark({ state }: { state: "" | "saving" | "saved" }) {
  if (state === "saving") return <span className="spinner small" aria-label="Saving" />;
  if (state === "saved") return <span className="saved"><Icon name="check" size={16} />Saved</span>;
  return null;
}

// ArmedButton asks twice: the first press arms it for a few seconds.
export function ArmedButton({ icon, label, armedLabel, onConfirm }: { icon: IconName; label: string; armedLabel: string; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button type="button" className={"btn danger" + (armed ? " armed" : "")} onClick={() => (armed ? onConfirm() : setArmed(true))}>
      <Icon name={icon} size={18} />
      <span>{armed ? armedLabel : label}</span>
    </button>
  );
}

export function Callout({ tone, icon, children }: { tone?: "bad" | "warn" | "ok"; icon: IconName; children: ReactNode }) {
  return (
    <div className={"callout" + (tone ? " " + tone : "")}>
      <Icon name={icon} />
      <span>{children}</span>
    </div>
  );
}

// Dialog is a panel over the whole page, the page dimmed behind it, so nothing
// on the page moves. Escape, the close button or a click outside closes it.
// Menus opened inside it sit above it.
export function Dialog({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  const id = useId();
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      // A menu open inside the dialog takes Escape first.
      if (e.key === "Escape" && !document.querySelector(".dropdown-list, .pop-menu")) onClose();
    };
    document.addEventListener("keydown", esc);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", esc);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);
  return createPortal(
    <div className="dialog-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={id}>
        <div className="dialog-head">
          <h2 id={id}>{title}</h2>
          <button type="button" className="icon-btn" aria-label="Close" title="Close" onClick={onClose}><Icon name="close" /></button>
        </div>
        <div className="dialog-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

// Tooltips shows what an element's title says in a small dark label under it
// (or over it, near the bottom of the window), in place of the browser's own.
// A title is moved to data-tip the first time the pointer rests on it.
export function Tooltips() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number; above: boolean } | null>(null);
  useEffect(() => {
    let target: HTMLElement | null = null;
    let timer = 0;
    const hide = () => {
      clearTimeout(timer);
      target = null;
      setTip(null);
    };
    const over = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const el = (e.target as Element | null)?.closest?.("[title], [data-tip]") as HTMLElement | null;
      if (el === target) return;
      hide();
      if (!el || el instanceof SVGElement) return;
      const title = el.getAttribute("title");
      if (title) {
        el.dataset.tip = title;
        el.removeAttribute("title");
      }
      const text = el.dataset.tip;
      if (!text) return;
      target = el;
      timer = window.setTimeout(() => {
        if (target !== el || !el.isConnected) return;
        const r = el.getBoundingClientRect();
        const above = r.bottom + 40 > innerHeight;
        const x = Math.min(Math.max(r.left + r.width / 2, 120), innerWidth - 120);
        setTip({ text, x, y: above ? r.top - 6 : r.bottom + 6, above });
      }, 350);
    };
    document.addEventListener("pointerover", over);
    document.addEventListener("pointerdown", hide, true);
    addEventListener("scroll", hide, true);
    addEventListener("blur", hide);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerdown", hide, true);
      removeEventListener("scroll", hide, true);
      removeEventListener("blur", hide);
    };
  }, []);
  if (!tip) return null;
  return createPortal(
    <div className="tip" role="tooltip" style={{ left: tip.x, top: tip.y, transform: tip.above ? "translate(-50%, -100%)" : undefined }}>{tip.text}</div>,
    document.body,
  );
}

// Notices pop up at the bottom left for a few seconds.
type Notify = (text: string, tone?: "ok" | "bad") => void;
const NotifyContext = createContext<Notify>(() => {});
export const useNotify = () => useContext(NotifyContext);

export function Notices({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ text: string; tone: "ok" | "bad"; at: number } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);
  const notify = useCallback<Notify>((text, tone = "ok") => setToast({ text, tone, at: Date.now() }), []);
  return (
    <NotifyContext.Provider value={notify}>
      {children}
      {toast && (
        <div key={toast.at} className={"toast " + toast.tone} role={toast.tone === "bad" ? "alert" : "status"}>
          <Icon name={toast.tone === "bad" ? "error" : "check_circle"} />
          <span>{toast.text}</span>
        </div>
      )}
    </NotifyContext.Provider>
  );
}

// Copy is a value that copies itself when clicked.
export function Copy({ text, copyText, plain }: { text: string; copyText?: string; plain?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className={"copy" + (done ? " done" : "")} title="Copy"
      onClick={() => {
        navigator.clipboard?.writeText(copyText ?? text);
        setDone(true);
        setTimeout(() => setDone(false), 2500);
      }}>
      <span className={"copy-text" + (plain ? "" : " mono")}>{text}</span>
      <Icon name={done ? "check" : "content_copy"} size={16} className="copy-icon" />
    </button>
  );
}

// TextField is an outlined field whose label rests inside it and floats onto
// the outline once it has focus or a value. `trailing` sits at its right end,
// such as a Show button or a spinner; `hint` is the line under it.
export function TextField({ label, value, onChange, hint, trailing, mono, className, ...rest }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: ReactNode;
  trailing?: ReactNode;
  mono?: boolean;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  const id = useId();
  const input = "tf-input" + (mono ? " mono" : "");
  return (
    <div className={"tf" + (trailing ? " has-trailing" : "") + (className ? " " + className : "")}>
      <div className="tf-box">
        <input id={id} className={input} value={value} spellCheck={false} {...rest} placeholder={rest.placeholder ?? " "}
          onChange={(e) => onChange(e.target.value)} />
        <label className="tf-label" htmlFor={id}>{label}</label>
        {trailing && <span className="tf-trailing">{trailing}</span>}
      </div>
      {hint && <div className="tf-hint">{hint}</div>}
    </div>
  );
}

// SubNav is the bar under a page's heading, as in EPS: the way back, a short
// rule, then the page's sub-pages, the open one underlined in the accent colour.
export function SubNav({ back, backLabel, base, items, current }: {
  back: string;
  backLabel: string;
  base: string;
  items: [string, string, IconName][];
  current: string;
}) {
  return (
    <nav className="sub-nav" aria-label="Sub-pages">
      <a className="sub-nav-back" href={back}><Icon name="arrow_back" size={18} />{backLabel}</a>
      <span className="sub-nav-rule" />
      {items.map(([key, label, icon]) => (
        <a key={key} className={"sub-nav-item" + (current === key ? " on" : "")} href={`${base}/${key}`} aria-current={current === key ? "page" : undefined}>
          <Icon name={icon} size={18} />
          <span>{label}</span>
        </a>
      ))}
    </nav>
  );
}

// Avatar is a round mark with someone's initials, in a colour of their own.
export function Avatar({ name, big }: { name: string; big?: boolean }) {
  const initials = name.split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
  let hue = 0;
  for (const c of name) hue = (hue * 31 + c.charCodeAt(0)) % 360;
  return <span className={"avatar" + (big ? " big" : "")} style={{ backgroundColor: `hsl(${hue} 45% 42%)` }} aria-hidden>{initials}</span>;
}

export interface LogEntry {
  at: number;
  // "ok", "bad", or "" for neither.
  tone: string;
  event: string;
  who?: ReactNode;
  ip?: string | null;
  country?: string | null;
}

// When something happened: the time today, the date and time before that.
function when(at: number) {
  const d = new Date(at * 1000);
  if (d.toDateString() === new Date().toDateString()) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// LogTable is a log as a table: when, what happened, who, and where from,
// newest first.
export function LogTable({ entries, who = "Who" }: { entries: LogEntry[]; who?: string }) {
  return (
    <div className="table-wrap">
      <table className="table log-table">
        <thead>
          <tr>
            <th>Time</th>
            <th className="grow">Event</th>
            <th>{who}</th>
            <th>Address</th>
            <th>Country</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e, i) => (
            <tr key={i}>
              <td className="log-time">{when(e.at)}</td>
              <td><span className="log-event"><span className={"dot " + e.tone} />{e.event}</span></td>
              <td>{e.who ?? <span className="muted">Unknown</span>}</td>
              <td className="mono muted">{e.ip ?? ""}</td>
              <td className="muted">{e.country ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// usePopover places a panel over the page under its button, so no card or scroll
// area cuts it off. A click outside, Escape, scrolling the page or resizing closes it.
function usePopover(width: number) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState({ top: 0, left: 0 });
  const anchor = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, anchor, panel);
  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const r = anchor.current.getBoundingClientRect();
    setAt({ top: r.bottom + 4, left: Math.max(8, Math.min(r.right - width, innerWidth - width - 8)) });
    const away = (e: Event) => {
      if (!panel.current?.contains(e.target as Node)) close();
    };
    addEventListener("scroll", away, true);
    addEventListener("resize", close);
    return () => {
      removeEventListener("scroll", away, true);
      removeEventListener("resize", close);
    };
  }, [open, close, width]);
  return { open, setOpen, close, anchor, panel, style: { top: at.top, left: at.left, width } };
}

export interface PickItem {
  id: string;
  label: string;
  sub?: string;
  // A name to draw initials from, for people.
  avatar?: string;
  // Already there: listed, not pickable, with `note` in place of `sub`.
  disabled?: boolean;
  note?: string;
}

// AddMenu is a plus that opens a menu: a search, then the items, narrowed as
// you type. Items already added stay listed, greyed out.
export function AddMenu({ label, placeholder, items, onPick, empty }: {
  label: string;
  placeholder: string;
  items: PickItem[];
  onPick: (id: string) => void;
  empty?: ReactNode;
}) {
  const pop = usePopover(300);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const needle = q.trim().toLowerCase();
  const matches = items.filter((i) => !needle || [i.label, i.sub ?? ""].some((v) => v.toLowerCase().includes(needle))).slice(0, 8);
  const pick = (item: PickItem) => {
    if (item.disabled) return;
    pop.close();
    onPick(item.id);
  };
  return (
    <div className="menu-wrap" ref={pop.anchor}>
      <button type="button" className="icon-btn" aria-label={label} title={label} aria-expanded={pop.open}
        onClick={() => {
          setQ("");
          setActive(0);
          pop.setOpen((o) => !o);
        }}>
        <Icon name="add" />
      </button>
      {pop.open && createPortal(
        <div ref={pop.panel} className="menu pop-menu" style={pop.style}>
          {items.length === 0 ? empty : (
            <>
              <input className="menu-search" type="text" placeholder={placeholder} aria-label={placeholder} autoFocus autoComplete="off" spellCheck={false}
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setActive(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    e.preventDefault();
                    setActive((i) => Math.max(0, Math.min(matches.length - 1, i + (e.key === "ArrowDown" ? 1 : -1))));
                  } else if (e.key === "Enter" && matches[active]) {
                    e.preventDefault();
                    pick(matches[active]);
                  }
                }} />
              {matches.length === 0 && <div className="menu-note">Nothing by that name</div>}
              {matches.map((item, i) => (
                <button key={item.id} type="button" className={"menu-item pick-item" + (i === active ? " active" : "")} disabled={item.disabled}
                  onMouseEnter={() => setActive(i)} onClick={() => pick(item)}>
                  {item.avatar !== undefined && <Avatar name={item.avatar} />}
                  <span className="person">
                    <span>{item.label}</span>
                    {(item.disabled ? item.note : item.sub) && <small>{item.disabled ? item.note : item.sub}</small>}
                  </span>
                </button>
              ))}
            </>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}

export interface MenuAction {
  label: string;
  icon: IconName;
  onClick: () => void;
  danger?: boolean;
  // Asked once more, with this label, before it runs.
  confirm?: string;
}

// MoreMenu is the three dots that hold a page's less frequent actions.
export function MoreMenu({ label, actions }: { label: string; actions: MenuAction[] }) {
  const pop = usePopover(240);
  const [armed, setArmed] = useState("");
  return (
    <div className="menu-wrap" ref={pop.anchor}>
      <button type="button" className="icon-btn" aria-label={label} title={label} aria-expanded={pop.open}
        onClick={() => {
          setArmed("");
          pop.setOpen((o) => !o);
        }}>
        <Icon name="more_vert" />
      </button>
      {pop.open && createPortal(
        <div ref={pop.panel} className="menu pop-menu" style={pop.style} role="menu">
          {actions.map((a) => (
            <button key={a.label} type="button" role="menuitem" className={"menu-item" + (a.danger ? " danger" : "") + (armed === a.label ? " armed" : "")}
              onClick={() => {
                if (a.confirm && armed !== a.label) return setArmed(a.label);
                pop.close();
                a.onClick();
              }}>
              <Icon name={a.icon} size={20} />
              {armed === a.label && a.confirm ? a.confirm : a.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}

// ValueRow shows a setting's value as text, with an edit button that opens a
// dialog with the field, Save and Cancel.
export function ValueRow({ title, value, empty = "None", type, hint, onSave }: {
  title: string;
  value: string;
  empty?: string;
  type?: string;
  hint?: ReactNode;
  onSave: (value: string) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const notify = useNotify();

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await onSave(draft.trim());
      setEditing(false);
    } catch (err) {
      notify(message(err), "bad");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Row title={title} sub={value || empty}>
      {editing && (
        <Dialog title={`Change ${title.toLowerCase()}`} onClose={() => setEditing(false)}>
          <form onSubmit={save}>
            <TextField label={title} type={type} autoFocus autoComplete="off" value={draft} onChange={setDraft} hint={hint} />
            <div className="edit-actions">
              <button type="button" className="btn text" onClick={() => setEditing(false)}>Cancel</button>
              <button className="btn primary" disabled={busy}>Save</button>
            </div>
          </form>
        </Dialog>
      )}
      <button type="button" className="icon-btn" aria-label={`Change ${title.toLowerCase()}`} title={`Change ${title.toLowerCase()}`}
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}>
        <Icon name="edit" size={20} />
      </button>
    </Row>
  );
}
