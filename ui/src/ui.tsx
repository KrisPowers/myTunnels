import { createContext, useCallback, useContext, useEffect, useId, useState, type InputHTMLAttributes, type ReactNode } from "react";
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
  text: ReactNode;
  where?: string;
}

function dayOf(at: number) {
  const d = new Date(at * 1000);
  if (d.toDateString() === new Date().toDateString()) return "Today";
  if (d.toDateString() === new Date(Date.now() - 86_400_000).toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

// LogDays is a log: a heading per day, then one quiet line per entry with a dot,
// the time, what happened, and where from.
export function LogDays({ entries }: { entries: LogEntry[] }) {
  const days: [string, LogEntry[]][] = [];
  for (const e of entries) {
    const label = dayOf(e.at);
    if (days.at(-1)?.[0] !== label) days.push([label, []]);
    days.at(-1)![1].push(e);
  }
  return (
    <>
      {days.map(([label, list]) => (
        <section key={label} className="log-day">
          <h3>{label}</h3>
          <ul className="log-list">
            {list.map((e, i) => (
              <li key={i} className="log-line">
                <span className={"dot " + e.tone} />
                <time className="log-time">{new Date(e.at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
                <span className="log-text">{e.text}</span>
                {e.where && <span className="log-where">{e.where}</span>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
