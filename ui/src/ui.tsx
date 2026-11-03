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
export function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className={"copy" + (done ? " done" : "")} title="Copy"
      onClick={() => {
        navigator.clipboard?.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1400);
      }}>
      <span className="copy-text mono">{text}</span>
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
