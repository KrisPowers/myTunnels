import { useLayoutEffect, useRef, useState, type MouseEvent as PointerEvent } from "react";
import { createPortal } from "react-dom";
import { bytes, message, upload, type ConvertKind, type Space } from "./api";
import { useDismiss } from "./dismiss";
import { Icon, type IconName } from "./Icon";
import { Dialog, TextField, useNotify } from "./ui";

// The pieces Storage's tabs share: uploads, right-click menus and the name
// dialog.

export const extOf = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

const PHOTOS = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif", "heic", "heif", "tif", "tiff"];
const VIDEOS = ["mp4", "mov", "m4v", "webm", "mkv", "avi", "3gp", "mts", "m2ts", "wmv"];

// What Convert makes of a file: a photo, a video or a PDF, or nothing.
export const convertKind = (name: string): ConvertKind | null => {
  const ext = extOf(name);
  return PHOTOS.includes(ext) ? "photo" : VIDEOS.includes(ext) ? "video" : ext === "pdf" ? "pdf" : null;
};

// ---- uploads ----

export interface Upload {
  id: number;
  name: string;
  size: number;
  sent: number;
  state: "waiting" | "sending" | "done" | "failed";
  error?: string;
}

export interface Picked { file: File; rel: string }

// What was dropped, folders walked into, each file with its path inside the drop.
export async function dropped(items: DataTransferItemList): Promise<Picked[]> {
  const entries = Array.from(items).map((i) => i.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => !!e);
  const out: Picked[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push({ file, rel: prefix + entry.name });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
      }
    }
  };
  for (const entry of entries) await walk(entry, "");
  return out;
}

// ---- menus and dialogs ----

export interface Menu { x: number; y: number; on: boolean }

export function NameDialog({ title, label, initial, action, onSave, onClose }: {
  title: string;
  label: string;
  initial: string;
  action: string;
  onSave: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const notify = useNotify();
  return (
    <Dialog title={title} onClose={onClose}>
      <form onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await onSave(name.trim());
        } catch (err) {
          notify(message(err), "bad");
          setBusy(false);
        }
      }}>
        <TextField label={label} autoFocus autoComplete="off" value={name} onChange={setName} onFocus={(e) => e.target.select()} />
        <div className="edit-actions">
          <button type="button" className="btn text" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !name.trim()}>{busy && <span className="spinner small on-accent" />}{action}</button>
        </div>
      </form>
    </Dialog>
  );
}

export interface MenuItem { label: string; icon: IconName; run: () => void; hidden?: boolean; danger?: boolean }

// ownMenu is false for a right-click that keeps the browser's menu: in a field,
// or in a dialog, viewer or menu drawn over the page.
export function ownMenu(e: PointerEvent) {
  return !(e.target as HTMLElement).closest("input, textarea, .dialog-scrim, .m-viewer, .pop-menu");
}

// ContextMenu is the right-click menu, at the pointer, kept inside the window.
export function ContextMenu({ at, items, onClose }: { at: Menu; items: MenuItem[]; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: at.x, top: at.y });
  useDismiss(true, onClose, panel);
  useLayoutEffect(() => {
    const r = panel.current?.getBoundingClientRect();
    if (r) setPos({ left: Math.min(at.x, innerWidth - r.width - 8), top: Math.min(at.y, innerHeight - r.height - 8) });
    // The wheel, not scrolling: focusing the explorer on the click that opened
    // the menu can scroll the page, which would close it at once.
    const wheel = (e: WheelEvent) => {
      if (!panel.current?.contains(e.target as Node)) onClose();
    };
    addEventListener("wheel", wheel, true);
    addEventListener("resize", onClose);
    return () => {
      removeEventListener("wheel", wheel, true);
      removeEventListener("resize", onClose);
    };
  }, [at, onClose]);
  const shown = items.filter((i) => !i.hidden);
  if (!shown.length) return null;
  return createPortal(
    <div ref={panel} className="menu pop-menu ex-context" role="menu" style={{ left: pos.left, top: pos.top, width: 220 }} onContextMenu={(e) => e.preventDefault()}>
      {shown.map((item) => (
        <button key={item.label} type="button" role="menuitem" className={"menu-item" + (item.danger ? " danger" : "")} onClick={() => {
          onClose();
          item.run();
        }}>
          <Icon name={item.icon} size={20} />{item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}

// useUploads sends picked files into `space` one at a time, keeping the list
// the Uploads panel shows. `done` runs after each batch.
export function useUploads(space: Space, done: () => unknown, after?: (item: Picked, path: string) => Promise<unknown>) {
  const [list, setList] = useState<Upload[]>([]);
  const cancelled = useRef(new Set<number>());
  const nextId = useRef(1);
  const send = async (items: { item: Picked; path: string }[]) => {
    const batch = items.map((x) => ({ ...x, id: nextId.current++ }));
    setList((u) => [...u.filter((x) => x.state !== "done"), ...batch.map((b) => ({ id: b.id, name: b.item.rel, size: b.item.file.size, sent: 0, state: "waiting" as const }))]);
    const patch = (id: number, change: Partial<Upload>) => setList((u) => u.map((x) => (x.id === id ? { ...x, ...change } : x)));
    for (const b of batch) {
      if (cancelled.current.has(b.id)) continue;
      patch(b.id, { state: "sending" });
      try {
        await upload(b.item.file, b.path, false, (sent) => patch(b.id, { sent }), () => cancelled.current.has(b.id), space, true);
        await after?.(b.item, b.path);
        patch(b.id, { state: "done", sent: b.item.file.size });
      } catch (e) {
        patch(b.id, { state: "failed", error: message(e) });
      }
    }
    await done();
  };
  const panel = list.length > 0 && (
    <Uploads list={list}
      onCancel={(id) => {
        cancelled.current.add(id);
        setList((u) => u.map((x) => (x.id === id && x.state === "waiting" ? { ...x, state: "failed", error: "Cancelled" } : x)));
      }}
      onClear={() => setList((u) => u.filter((x) => x.state === "waiting" || x.state === "sending"))} />
  );
  return { send, panel };
}

// A name not yet in `taken`, as "photo (2).jpg" after "photo.jpg".
export function freeName(name: string, taken: Set<string>) {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 2; ; n++) {
    const next = `${stem} (${n})${ext}`;
    if (!taken.has(next)) return next;
  }
}

// Uploads is the panel of files going up, at the bottom right.
export function Uploads({ list, onCancel, onClear }: { list: Upload[]; onCancel: (id: number) => void; onClear: () => void }) {
  const [small, setSmall] = useState(false);
  const left = list.filter((u) => u.state === "waiting" || u.state === "sending").length;
  const failed = list.filter((u) => u.state === "failed").length;
  const total = list.reduce((n, u) => n + u.size, 0);
  const sent = list.reduce((n, u) => n + u.sent, 0);
  return (
    <section className="ex-uploads" aria-label="Uploads">
      <div className="ex-uploads-head">
        <b>{left ? `Uploading ${left} item${left === 1 ? "" : "s"}` : failed ? `${failed} upload${failed === 1 ? "" : "s"} failed` : "Uploads done"}</b>
        <button type="button" className="icon-btn small" aria-label={small ? "Show uploads" : "Hide uploads"} onClick={() => setSmall((s) => !s)}>
          <Icon name="expand_more" size={18} className={small ? "flip" : undefined} />
        </button>
        {!left && <button type="button" className="icon-btn small" aria-label="Close" onClick={onClear}><Icon name="close" size={18} /></button>}
      </div>
      <div className="ex-progress"><span style={{ width: `${total ? (sent / total) * 100 : 100}%` }} /></div>
      {!small && (
        <ul>
          {list.map((u) => (
            <li key={u.id} className={u.state}>
              <Icon name={u.state === "done" ? "check_circle" : u.state === "failed" ? "error" : "upload_file"} size={18} />
              <span className="ex-up-name" title={u.name}>{u.name}</span>
              <small>{u.state === "failed" ? u.error : u.state === "done" ? bytes(u.size) : `${bytes(u.sent)} of ${bytes(u.size)}`}</small>
              {(u.state === "waiting" || u.state === "sending") && (
                <button type="button" className="icon-btn small" aria-label={`Cancel ${u.name}`} onClick={() => onCancel(u.id)}><Icon name="close" size={16} /></button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
