import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent as KeyEvent, type MouseEvent as PointerEvent } from "react";
import { createPortal } from "react-dom";
import { bytes, fileUrl, files, message, upload, type FileEntry, type Listing, type Space } from "./api";
import { useDismiss } from "./dismiss";
import { Dropdown, type Option } from "./Dropdown";
import { Icon, type IconName } from "./Icon";
import { Dialog, Notices, TextField, useNotify } from "./ui";

// ---- names and kinds ----

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const parentOf = (path: string) => path.split("/").slice(0, -1).join("/");
export const extOf = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

type Kind = "folder" | "image" | "video" | "audio" | "document" | "other";

const EXTS: Record<Exclude<Kind, "folder" | "other">, string[]> = {
  image: ["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif", "heic", "ico", "tif", "tiff", "svg"],
  video: ["mp4", "mkv", "mov", "avi", "webm", "m4v", "wmv", "flv", "mpg", "mpeg", "ts"],
  audio: ["mp3", "flac", "wav", "ogg", "m4a", "aac", "opus", "wma"],
  document: ["txt", "md", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "csv", "json", "log", "rtf", "odt", "ods", "odp", "xml", "yaml", "yml", "ini", "conf"],
};

function kindOf(e: FileEntry): Kind {
  if (e.dir) return "folder";
  const ext = extOf(e.name);
  for (const [kind, list] of Object.entries(EXTS)) if (list.includes(ext)) return kind as Kind;
  return "other";
}

const KIND_ICON: Record<Kind, IconName> = { folder: "folder", image: "image", video: "movie", audio: "music_note", document: "description", other: "draft" };

const KINDS: Option<Kind | "all">[] = [
  { value: "all", label: "All items" },
  { value: "folder", label: "Folders", icon: "folder" },
  { value: "image", label: "Pictures", icon: "image" },
  { value: "video", label: "Videos", icon: "movie" },
  { value: "audio", label: "Music", icon: "music_note" },
  { value: "document", label: "Documents", icon: "description" },
  { value: "other", label: "Other files", icon: "draft" },
];

function typeName(e: FileEntry) {
  if (e.dir) return "File folder";
  const ext = extOf(e.name);
  return ext ? `${ext.toUpperCase()} File` : "File";
}

// Files the browser can show by itself open in a new tab; the rest download.
const viewable = (e: FileEntry) => {
  const ext = extOf(e.name);
  return (kindOf(e) === "image" && ext !== "svg") || kindOf(e) === "video" || kindOf(e) === "audio" || ["pdf", "txt", "md", "log", "csv", "json"].includes(ext);
};

const when = (at: number) => (at ? new Date(at * 1000).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "");

type SortKey = "name" | "modified" | "type" | "size";
const SORTS: Option<SortKey>[] = [
  { value: "name", label: "Name" },
  { value: "modified", label: "Date modified" },
  { value: "type", label: "Type" },
  { value: "size", label: "Size" },
];

type View = "details" | "icons";

function remembered<T extends string>(key: string, fallback: T, allowed: T[]): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Kept until the page closes.
  }
}

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

// ---- the explorer ----

export interface Menu { x: number; y: number; on: boolean }

// Explorer is a file explorer over Storage, laid out like Windows': back,
// forward and up beside the address bar, a command bar, folders down the
// left, the folder's items, and a status bar. Every change is checked on the
// server against what the viewer may do.
export function Explorer({ title }: { title: string }) {
  const [path, setPath] = useState("");
  const [back, setBack] = useState<string[]>([]);
  const [ahead, setAhead] = useState<string[]>([]);
  const [listing, setListing] = useState<Listing | null>(null);
  const [problem, setProblem] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const [view, setView] = useState<View>(() => remembered("storage.view", "details", ["details", "icons"]));
  const [sort, setSort] = useState<{ key: SortKey; up: boolean }>({ key: "name", up: true });
  const [kind, setKind] = useState<Kind | "all">("all");
  const [q, setQ] = useState("");
  const [searching, setSearching] = useState(false);
  const [clip, setClip] = useState<{ cut: boolean; paths: string[] } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [asking, setAsking] = useState<null | "folder" | "file" | "delete">(null);
  const [replacing, setReplacing] = useState<{ picked: Picked[]; into: string; clashes: string[] } | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dropping, setDropping] = useState<string | null>(null);
  const [tree, setTree] = useState<Record<string, string[]>>({});
  const [open, setOpen] = useState<Set<string>>(new Set([""]));
  const box = useRef<HTMLDivElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const cancelled = useRef(new Set<number>());
  const nextId = useRef(1);
  const notify = useNotify();

  const load = useCallback(async (at: string) => {
    try {
      const l = await files.list(at);
      setListing(l);
      setProblem("");
      setTree((t) => ({ ...t, [at]: l.entries.filter((e) => e.dir).map((e) => e.name).sort((a, b) => a.localeCompare(b)) }));
    } catch (e) {
      setListing(null);
      setProblem(message(e));
    }
  }, []);

  useEffect(() => {
    setListing(null);
    setSelected(new Set());
    setRenaming(null);
    load(path);
    // Folders on the way here are open in the tree.
    setOpen((o) => {
      const next = new Set(o);
      path.split("/").forEach((_, i, parts) => next.add(parts.slice(0, i).join("/")));
      return next;
    });
  }, [path, load]);

  const refresh = () => load(path);

  const go = (to: string) => {
    if (to === path) return;
    setBack((b) => [...b, path]);
    setAhead([]);
    setPath(to);
    setQ("");
  };
  const goBack = () => {
    const to = back[back.length - 1];
    if (to === undefined) return;
    setBack(back.slice(0, -1));
    setAhead([path, ...ahead]);
    setPath(to);
  };
  const goAhead = () => {
    const to = ahead[0];
    if (to === undefined) return;
    setAhead(ahead.slice(1));
    setBack([...back, path]);
    setPath(to);
  };

  const access = listing?.access ?? "browse";
  const canWrite = access === "write";

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = (listing?.entries ?? []).filter((e) => (!needle || e.name.toLowerCase().includes(needle)) && (kind === "all" || kindOf(e) === kind));
    const by = (a: FileEntry, b: FileEntry) => {
      if (sort.key === "modified") return a.modified - b.modified;
      if (sort.key === "size") return a.size - b.size;
      if (sort.key === "type") return typeName(a).localeCompare(typeName(b));
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    };
    // Folders stay above files, as in Windows.
    return list.sort((a, b) => Number(b.dir) - Number(a.dir) || (sort.up ? 1 : -1) * by(a, b) || a.name.localeCompare(b.name));
  }, [listing, q, kind, sort]);

  const picked = shown.filter((e) => selected.has(e.name));
  const pickedPaths = picked.map((e) => join(path, e.name));
  const pickedFiles = picked.filter((e) => !e.dir);

  // ---- selecting ----

  const choose = (e: PointerEvent, name: string) => {
    e.stopPropagation();
    if (e.shiftKey && anchor.current) {
      const names = shown.map((x) => x.name);
      const [a, b] = [names.indexOf(anchor.current), names.indexOf(name)].sort((x, y) => x - y);
      if (a >= 0) setSelected(new Set(names.slice(a, b + 1)));
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      setSelected(next);
    } else {
      setSelected(new Set([name]));
    }
    anchor.current = name;
  };

  // ---- doing ----

  const run = async (work: () => Promise<unknown>, done?: string) => {
    try {
      await work();
      if (done) notify(done);
    } catch (e) {
      notify(message(e), "bad");
    }
    await load(path);
  };

  const openEntry = (e: FileEntry) => {
    if (e.dir) return go(join(path, e.name));
    if (access === "browse") return;
    if (viewable(e)) window.open(fileUrl(join(path, e.name), true), "_blank", "noopener");
    else download([e]);
  };

  const download = (entries: FileEntry[]) => {
    for (const e of entries.filter((x) => !x.dir)) {
      const a = document.createElement("a");
      a.href = fileUrl(join(path, e.name));
      a.download = e.name;
      document.body.append(a);
      a.click();
      a.remove();
    }
  };

  const paste = (into = path) => {
    if (!clip) return;
    const { cut, paths } = clip;
    run(async () => {
      await files.move(paths, into, !cut);
      if (cut) setClip(null);
    }, `${cut ? "Moved" : "Copied"} ${paths.length} item${paths.length === 1 ? "" : "s"}`);
  };

  const rename = (from: string, name: string) => {
    setRenaming(null);
    const trimmed = name.trim();
    if (!trimmed || trimmed === from) return;
    run(async () => {
      await files.rename(join(path, from), trimmed);
      setSelected(new Set([trimmed]));
    });
  };

  // ---- uploading ----

  const send = async (items: Picked[], into: string, replace: boolean) => {
    const batch = items.map((p) => ({ ...p, id: nextId.current++ }));
    setUploads((u) => [...u.filter((x) => x.state !== "done"), ...batch.map((b) => ({ id: b.id, name: b.rel, size: b.file.size, sent: 0, state: "waiting" as const }))]);
    const patch = (id: number, change: Partial<Upload>) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, ...change } : x)));
    for (const item of batch) {
      if (cancelled.current.has(item.id)) continue;
      patch(item.id, { state: "sending" });
      try {
        await upload(item.file, join(into, item.rel), replace, (sent) => patch(item.id, { sent }), () => cancelled.current.has(item.id));
        patch(item.id, { state: "done", sent: item.file.size });
      } catch (e) {
        patch(item.id, { state: "failed", error: message(e) });
      }
    }
    await load(path);
  };

  // Names already in the folder are asked about once, for the whole lot.
  const start = (items: Picked[], into = path) => {
    if (!items.length) return;
    const here = into === path ? new Set((listing?.entries ?? []).map((e) => e.name)) : new Set<string>();
    const clashes = [...new Set(items.filter((p) => !p.rel.includes("/") && here.has(p.rel)).map((p) => p.rel))];
    if (clashes.length) setReplacing({ picked: items, into, clashes });
    else send(items, into, false);
  };

  const fromInput = (list: FileList | null) => {
    if (!list) return;
    start(Array.from(list, (file) => ({ file, rel: file.webkitRelativePath || file.name })));
  };

  // ---- dragging ----

  const INTERNAL = "application/x-mytunnels-storage";

  const dragStart = (e: DragEvent, name: string) => {
    const names = selected.has(name) ? [...selected] : [name];
    if (!selected.has(name)) setSelected(new Set([name]));
    e.dataTransfer.setData(INTERNAL, JSON.stringify(names.map((n) => join(path, n))));
    e.dataTransfer.effectAllowed = "copyMove";
  };

  const dragOver = (e: DragEvent, target: string) => {
    const types = Array.from(e.dataTransfer.types);
    if (!canWrite || !(types.includes("Files") || types.includes(INTERNAL))) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = types.includes(INTERNAL) && !e.ctrlKey ? "move" : "copy";
    setDropping(target);
  };

  const drop = async (e: DragEvent, into: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDropping(null);
    if (!canWrite) return;
    const internal = e.dataTransfer.getData(INTERNAL);
    if (internal) {
      const paths: string[] = JSON.parse(internal);
      if (paths.includes(into)) return;
      const copy = e.ctrlKey;
      return run(() => files.move(paths, into, copy), `${copy ? "Copied" : "Moved"} ${paths.length} item${paths.length === 1 ? "" : "s"}`);
    }
    start(await dropped(e.dataTransfer.items), into);
  };

  // ---- keys ----

  const onKey = (e: KeyEvent) => {
    if ((e.target as HTMLElement).closest("input, textarea")) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === "a") {
      e.preventDefault();
      setSelected(new Set(shown.map((x) => x.name)));
    } else if (mod && (k === "c" || k === "x") && pickedPaths.length) {
      if (k === "x" && !canWrite) return;
      setClip({ cut: k === "x", paths: pickedPaths });
    } else if (mod && k === "v" && canWrite) {
      paste();
    } else if (e.key === "Delete" && canWrite && picked.length) {
      setAsking("delete");
    } else if (e.key === "F2" && canWrite && picked.length === 1) {
      setRenaming(picked[0].name);
    } else if (e.key === "Enter" && picked.length === 1) {
      openEntry(picked[0]);
    } else if (e.key === "Backspace" || (e.altKey && e.key === "ArrowLeft")) {
      e.preventDefault();
      goBack();
    } else if (e.altKey && e.key === "ArrowRight") {
      goAhead();
    } else if (e.altKey && e.key === "ArrowUp") {
      if (path) go(parentOf(path));
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const names = shown.map((x) => x.name);
      const at = anchor.current ? names.indexOf(anchor.current) : -1;
      const next = names[Math.max(0, Math.min(names.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))];
      if (next) {
        setSelected(new Set([next]));
        anchor.current = next;
      }
    } else if (e.key === "Escape") {
      setSelected(new Set());
    }
  };

  const contextMenu = (e: PointerEvent, name: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    if (name && !selected.has(name)) {
      setSelected(new Set([name]));
      anchor.current = name;
    }
    if (!name) setSelected(new Set());
    setMenu({ x: e.clientX, y: e.clientY, on: !!name });
  };

  const crumbs = path ? path.split("/") : [];
  const here = crumbs.length ? crumbs[crumbs.length - 1] : title;
  const totalSize = pickedFiles.reduce((n, e) => n + e.size, 0);

  return (
    <div className="explorer" ref={box} tabIndex={0} onKeyDown={onKey}
      onContextMenu={(e) => {
        // Menus and dialogs are drawn outside the explorer and keep their own.
        const t = e.target as HTMLElement;
        if (box.current?.contains(t) && !t.closest("input, textarea")) contextMenu(e, null);
      }}>
      <div className="ex-bar">
        <div className="ex-nav">
          <button type="button" className="icon-btn" aria-label="Back" title="Back (Alt+Left)" disabled={!back.length} onClick={goBack}><Icon name="arrow_back" /></button>
          <button type="button" className="icon-btn" aria-label="Forward" title="Forward (Alt+Right)" disabled={!ahead.length} onClick={goAhead}><Icon name="arrow_forward" /></button>
          <button type="button" className="icon-btn" aria-label="Up" title="Up (Alt+Up)" disabled={!path} onClick={() => go(parentOf(path))}><Icon name="arrow_upward" /></button>
          <button type="button" className="icon-btn" aria-label="Refresh" title="Refresh" onClick={refresh}><Icon name="refresh" /></button>
        </div>
        <Address title={title} crumbs={crumbs} onGo={go} dropping={dropping} onDragOver={dragOver} onDrop={drop} onLeave={() => setDropping(null)} />
        {searching ? (
          <div className="ex-search">
            <Icon name="search" size={18} />
            <input autoFocus type="text" aria-label={`Search ${here}`} placeholder={`Search ${here}`} value={q} spellCheck={false} autoComplete="off"
              onChange={(e) => setQ(e.target.value)}
              onBlur={() => !q && setSearching(false)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setQ("");
                  setSearching(false);
                  box.current?.focus();
                }
              }} />
            {q && <button type="button" className="icon-btn small" aria-label="Clear search" onClick={() => setQ("")}><Icon name="close" size={18} /></button>}
          </div>
        ) : (
          <button type="button" className="icon-btn" aria-label={`Search ${here}`} title="Search" onClick={() => setSearching(true)}><Icon name="search" /></button>
        )}
      </div>

      <div className="ex-commands" role="toolbar" aria-label="Commands">
        <MenuButton icon="add" label="New" disabled={!canWrite} items={[
          { label: "Folder", icon: "create_new_folder", run: () => setAsking("folder") },
          { label: "File", icon: "draft", run: () => setAsking("file") },
        ]} />
        <MenuButton icon="upload" label="Upload" disabled={!canWrite} items={[
          { label: "Files", icon: "upload_file", run: () => filesInput.current?.click() },
          { label: "Folder", icon: "folder", run: () => folderInput.current?.click() },
        ]} />
        <span className="ex-sep" />
        <button type="button" className="icon-btn" aria-label="Cut" title="Cut (Ctrl+X)" disabled={!canWrite || !picked.length} onClick={() => setClip({ cut: true, paths: pickedPaths })}><Icon name="content_cut" /></button>
        <button type="button" className="icon-btn" aria-label="Copy" title="Copy (Ctrl+C)" disabled={access === "browse" || !picked.length} onClick={() => setClip({ cut: false, paths: pickedPaths })}><Icon name="content_copy" /></button>
        <button type="button" className="icon-btn" aria-label="Paste" title="Paste (Ctrl+V)" disabled={!canWrite || !clip} onClick={() => paste()}><Icon name="content_paste" /></button>
        <button type="button" className="icon-btn" aria-label="Rename" title="Rename (F2)" disabled={!canWrite || picked.length !== 1} onClick={() => setRenaming(picked[0]?.name ?? null)}><Icon name="edit" /></button>
        <button type="button" className="icon-btn" aria-label="Download" title="Download" disabled={access === "browse" || !pickedFiles.length} onClick={() => download(pickedFiles)}><Icon name="download" /></button>
        <button type="button" className="icon-btn danger" aria-label="Delete" title="Delete (Del)" disabled={!canWrite || !picked.length} onClick={() => setAsking("delete")}><Icon name="delete" /></button>
        <span className="ex-grow" />
        <div className="ex-pick">
          <Dropdown label="Show" value={kind} options={KINDS} onChange={setKind} />
        </div>
        <div className="ex-pick">
          <Dropdown label="Sort by" value={sort.key} options={SORTS} onChange={(key) => setSort({ key, up: key === "name" || key === "type" })} />
        </div>
        <button type="button" className="icon-btn" aria-label={sort.up ? "Ascending" : "Descending"} title={sort.up ? "Ascending" : "Descending"} onClick={() => setSort((s) => ({ ...s, up: !s.up }))}>
          <Icon name="sort" className={sort.up ? "flip" : undefined} />
        </button>
        <button type="button" className="icon-btn" aria-label={view === "details" ? "Large icons" : "Details"} title={view === "details" ? "Large icons" : "Details"}
          onClick={() => {
            const next = view === "details" ? "icons" : "details";
            setView(next);
            remember("storage.view", next);
          }}>
          <Icon name={view === "details" ? "grid_view" : "view_list"} />
        </button>
      </div>

      <div className="ex-main">
        <nav className="ex-tree" aria-label="Folders">
          <TreeNode at="" name={title} depth={0} path={path} tree={tree} open={open}
            onToggle={(at) => {
              const next = new Set(open);
              if (next.has(at)) next.delete(at);
              else {
                next.add(at);
                if (!tree[at]) files.list(at).then((l) => setTree((t) => ({ ...t, [at]: l.entries.filter((e) => e.dir).map((e) => e.name).sort((a, b) => a.localeCompare(b)) }))).catch(() => setTree((t) => ({ ...t, [at]: [] })));
              }
              setOpen(next);
            }}
            onGo={go} />
        </nav>

        <div className={"ex-items" + (dropping === path ? " drop" : "")}
          onClick={() => setSelected(new Set())}
          onContextMenu={(e) => contextMenu(e, null)}
          onDragOver={(e) => dragOver(e, path)}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(null);
          }}
          onDrop={(e) => drop(e, path)}>
          {problem ? (
            <div className="ex-empty"><Icon name="error" size={32} /><span>{problem}</span></div>
          ) : !listing ? (
            <div className="ex-empty"><span className="spinner" /></div>
          ) : shown.length === 0 ? (
            <div className="ex-empty"><Icon name="folder" size={40} /><span>{q || kind !== "all" ? "No items match." : "This folder is empty."}</span></div>
          ) : view === "details" ? (
            <table className="ex-table">
              <thead>
                <tr>
                  {SORTS.map((s) => (
                    <th key={s.value} className={"col-" + s.value} aria-sort={sort.key === s.value ? (sort.up ? "ascending" : "descending") : undefined}>
                      <button type="button" onClick={(e) => {
                        e.stopPropagation();
                        setSort((cur) => ({ key: s.value, up: cur.key === s.value ? !cur.up : s.value === "name" || s.value === "type" }));
                      }}>
                        {s.label}
                        {sort.key === s.value && <Icon name="expand_more" size={16} className={sort.up ? "flip" : undefined} />}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((e) => (
                  <tr key={e.name} className={(selected.has(e.name) ? "on" : "") + (clip?.cut && clip.paths.includes(join(path, e.name)) ? " cut" : "") + (dropping === join(path, e.name) ? " drop" : "")}
                    draggable={canWrite && renaming !== e.name}
                    onDragStart={(ev) => dragStart(ev, e.name)}
                    onDragOver={e.dir ? (ev) => dragOver(ev, join(path, e.name)) : undefined}
                    onDrop={e.dir ? (ev) => drop(ev, join(path, e.name)) : undefined}
                    onClick={(ev) => choose(ev, e.name)}
                    onDoubleClick={() => openEntry(e)}
                    onContextMenu={(ev) => contextMenu(ev, e.name)}>
                    <td className="col-name">
                      <span className="ex-name">
                        <Icon name={KIND_ICON[kindOf(e)]} className={"kind " + kindOf(e)} />
                        {renaming === e.name ? <Rename name={e.name} onDone={(n) => rename(e.name, n)} onCancel={() => setRenaming(null)} /> : <span className="ex-label">{e.name}</span>}
                      </span>
                    </td>
                    <td className="col-modified">{when(e.modified)}</td>
                    <td className="col-type">{typeName(e)}</td>
                    <td className="col-size">{e.dir ? "" : bytes(e.size)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <ul className="ex-grid">
              {shown.map((e) => (
                <li key={e.name} className={"ex-tile" + (selected.has(e.name) ? " on" : "") + (clip?.cut && clip.paths.includes(join(path, e.name)) ? " cut" : "") + (dropping === join(path, e.name) ? " drop" : "")}
                  draggable={canWrite && renaming !== e.name}
                  onDragStart={(ev) => dragStart(ev, e.name)}
                  onDragOver={e.dir ? (ev) => dragOver(ev, join(path, e.name)) : undefined}
                  onDrop={e.dir ? (ev) => drop(ev, join(path, e.name)) : undefined}
                  onClick={(ev) => choose(ev, e.name)}
                  onDoubleClick={() => openEntry(e)}
                  onContextMenu={(ev) => contextMenu(ev, e.name)}
                  title={e.dir ? e.name : `${e.name}\n${bytes(e.size)}\n${when(e.modified)}`}>
                  <span className="ex-thumb">
                    {kindOf(e) === "image" && extOf(e.name) !== "svg" && access !== "browse"
                      ? <img src={fileUrl(join(path, e.name), true)} alt="" loading="lazy" draggable={false} />
                      : <Icon name={KIND_ICON[kindOf(e)]} size={56} className={"kind " + kindOf(e)} />}
                  </span>
                  {renaming === e.name ? <Rename name={e.name} onDone={(n) => rename(e.name, n)} onCancel={() => setRenaming(null)} /> : <span className="ex-label">{e.name}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="ex-status">
        <span>{shown.length} item{shown.length === 1 ? "" : "s"}</span>
        {picked.length > 0 && <span>{picked.length} selected{totalSize ? `, ${bytes(totalSize)}` : ""}</span>}
        {access === "read" && <span className="chip">Read only</span>}
        <span className="ex-grow" />
        {listing?.space && <span>{bytes(listing.space.free)} free of {bytes(listing.space.total)}</span>}
      </div>

      <input ref={filesInput} type="file" multiple hidden onChange={(e) => {
        fromInput(e.target.files);
        e.target.value = "";
      }} />
      <input ref={folderInput} type="file" multiple hidden {...{ webkitdirectory: "" }} onChange={(e) => {
        fromInput(e.target.files);
        e.target.value = "";
      }} />

      {menu && (
        <ContextMenu at={menu} onClose={() => setMenu(null)} items={menu.on ? [
          { label: "Open", icon: picked[0]?.dir ? "folder" : "open_in_new", hidden: picked.length !== 1 || (access === "browse" && !picked[0]?.dir), run: () => picked[0] && openEntry(picked[0]) },
          { label: "Download", icon: "download", hidden: access === "browse" || !pickedFiles.length, run: () => download(pickedFiles) },
          { label: "Cut", icon: "content_cut", hidden: !canWrite, run: () => setClip({ cut: true, paths: pickedPaths }) },
          { label: "Copy", icon: "content_copy", hidden: access === "browse", run: () => setClip({ cut: false, paths: pickedPaths }) },
          { label: "Paste into folder", icon: "content_paste", hidden: !canWrite || !clip || picked.length !== 1 || !picked[0]?.dir, run: () => paste(join(path, picked[0]!.name)) },
          { label: "Rename", icon: "edit", hidden: !canWrite || picked.length !== 1, run: () => setRenaming(picked[0]?.name ?? null) },
          { label: "Delete", icon: "delete", danger: true, hidden: !canWrite, run: () => setAsking("delete") },
        ] : [
          { label: "New folder", icon: "create_new_folder", hidden: !canWrite, run: () => setAsking("folder") },
          { label: "New file", icon: "draft", hidden: !canWrite, run: () => setAsking("file") },
          { label: "Upload files", icon: "upload_file", hidden: !canWrite, run: () => filesInput.current?.click() },
          { label: "Upload folder", icon: "upload", hidden: !canWrite, run: () => folderInput.current?.click() },
          { label: "Paste", icon: "content_paste", hidden: !canWrite || !clip, run: () => paste() },
          { label: "Select all", icon: "select_all", run: () => setSelected(new Set(shown.map((x) => x.name))) },
          { label: "Refresh", icon: "refresh", run: refresh },
        ]} />
      )}

      {asking === "folder" && (
        <NameDialog title="New folder" label="Folder name" initial="New folder" action="Create" onClose={() => setAsking(null)}
          onSave={async (name) => {
            await files.folder(join(path, name));
            setAsking(null);
            await load(path);
            setSelected(new Set([name]));
          }} />
      )}
      {asking === "file" && (
        <NameDialog title="New file" label="File name" initial="New file.txt" action="Create" onClose={() => setAsking(null)}
          onSave={async (name) => {
            await upload(new File([], name), join(path, name), false, () => {}, () => false);
            setAsking(null);
            await load(path);
            setSelected(new Set([name]));
          }} />
      )}
      {asking === "delete" && (
        <Dialog title={picked.length === 1 ? `Delete ${picked[0]?.name}?` : `Delete ${picked.length} items?`} onClose={() => setAsking(null)}>
          <p className="muted">They are removed from the host for good. There is no recycle bin.</p>
          <div className="edit-actions">
            <button type="button" className="btn text" onClick={() => setAsking(null)}>Cancel</button>
            <button type="button" className="btn primary danger-fill" autoFocus onClick={() => {
              const paths = pickedPaths;
              setAsking(null);
              run(() => files.remove(paths), `Deleted ${paths.length} item${paths.length === 1 ? "" : "s"}`);
            }}>Delete</button>
          </div>
        </Dialog>
      )}
      {replacing && (
        <Dialog title={replacing.clashes.length === 1 ? `${replacing.clashes[0]} is already here` : `${replacing.clashes.length} items are already here`} onClose={() => setReplacing(null)}>
          <p className="muted">Replace them with the ones being uploaded, or skip those and upload the rest.</p>
          <div className="edit-actions">
            <button type="button" className="btn text" onClick={() => setReplacing(null)}>Cancel</button>
            <button type="button" className="btn" onClick={() => {
              const { picked: all, into, clashes } = replacing;
              setReplacing(null);
              send(all.filter((p) => !clashes.includes(p.rel)), into, false);
            }}>Skip them</button>
            <button type="button" className="btn primary" onClick={() => {
              const { picked: all, into } = replacing;
              setReplacing(null);
              send(all, into, true);
            }}>Replace</button>
          </div>
        </Dialog>
      )}

      {uploads.length > 0 && (
        <Uploads list={uploads}
          onCancel={(id) => {
            cancelled.current.add(id);
            setUploads((u) => u.map((x) => (x.id === id && x.state === "waiting" ? { ...x, state: "failed", error: "Cancelled" } : x)));
          }}
          onClear={() => setUploads((u) => u.filter((x) => x.state === "waiting" || x.state === "sending"))} />
      )}
    </div>
  );
}

// Address is the path as a row of folders, each one a way back to it and a
// place to drop onto. Clicking the empty end of the bar types a path instead.
function Address({ title, crumbs, onGo, dropping, onDragOver, onDrop, onLeave }: {
  title: string;
  crumbs: string[];
  onGo: (path: string) => void;
  dropping: string | null;
  onDragOver: (e: DragEvent, path: string) => void;
  onDrop: (e: DragEvent, path: string) => void;
  onLeave: () => void;
}) {
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState("");
  const list = useRef<HTMLDivElement>(null);
  // The end of a long path stays in view.
  useLayoutEffect(() => {
    if (list.current) list.current.scrollLeft = list.current.scrollWidth;
  }, [crumbs]);

  if (typing) {
    return (
      <form className="ex-address typing" onSubmit={(e: FormEvent) => {
        e.preventDefault();
        setTyping(false);
        onGo(text.split(/[\\/]/).filter(Boolean).join("/"));
      }}>
        <Icon name="hard_drive" size={18} />
        <input autoFocus aria-label="Path" value={text} spellCheck={false} autoComplete="off" onChange={(e) => setText(e.target.value)}
          onBlur={() => setTyping(false)} onKeyDown={(e) => e.key === "Escape" && setTyping(false)} />
      </form>
    );
  }
  const all = [title, ...crumbs];
  return (
    <div className="ex-address" ref={list} onClick={(e) => {
      if (e.target === e.currentTarget) {
        setText(crumbs.join("/"));
        setTyping(true);
      }
    }}>
      <Icon name="hard_drive" size={18} />
      {all.map((name, i) => {
        const at = crumbs.slice(0, i).join("/");
        return (
          <span key={i} className="ex-crumb-wrap">
            {i > 0 && <Icon name="chevron_right" size={16} className="ex-crumb-sep" />}
            <button type="button" className={"ex-crumb" + (dropping === at && i < all.length - 1 ? " drop" : "")} onClick={() => onGo(at)}
              onDragOver={i < all.length - 1 ? (e) => onDragOver(e, at) : undefined}
              onDragLeave={onLeave}
              onDrop={i < all.length - 1 ? (e) => onDrop(e, at) : undefined}>{name}</button>
          </span>
        );
      })}
    </div>
  );
}

// TreeNode is one folder down the left, its folders under it once opened.
function TreeNode({ at, name, depth, path, tree, open, onToggle, onGo }: {
  at: string;
  name: string;
  depth: number;
  path: string;
  tree: Record<string, string[]>;
  open: Set<string>;
  onToggle: (at: string) => void;
  onGo: (at: string) => void;
}) {
  const expanded = open.has(at);
  const children = tree[at];
  return (
    <>
      <div className={"ex-node" + (path === at ? " on" : "")} style={{ paddingLeft: 4 + depth * 14 }}>
        <button type="button" className={"ex-twist" + (expanded ? " open" : "")} aria-label={expanded ? `Close ${name}` : `Open ${name}`}
          disabled={children !== undefined && children.length === 0} onClick={() => onToggle(at)}>
          <Icon name="chevron_right" size={16} />
        </button>
        <button type="button" className="ex-node-name" onClick={() => onGo(at)} title={name}>
          <Icon name={depth === 0 ? "hard_drive" : "folder"} size={18} className={depth === 0 ? undefined : "kind folder"} />
          <span>{name}</span>
        </button>
      </div>
      {expanded && children?.map((child) => (
        <TreeNode key={child} at={join(at, child)} name={child} depth={depth + 1} path={path} tree={tree} open={open} onToggle={onToggle} onGo={onGo} />
      ))}
    </>
  );
}

function Rename({ name, onDone, onCancel }: { name: string; onDone: (name: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(name);
  const input = useRef<HTMLInputElement>(null);
  // The name is picked, its extension left alone, as in Windows.
  useEffect(() => {
    const dot = name.lastIndexOf(".");
    input.current?.setSelectionRange(0, dot > 0 ? dot : name.length);
  }, [name]);
  return (
    <input ref={input} className="ex-rename" autoFocus value={text} spellCheck={false} aria-label="New name"
      onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => onDone(text)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") onDone(text);
        if (e.key === "Escape") onCancel();
      }} />
  );
}

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

// MenuButton is a command that opens a menu of `items` under it, drawn over
// the page so nothing below cuts it off.
export function MenuButton({ icon, label, disabled, items }: { icon: IconName; label: string; disabled: boolean; items: MenuItem[] }) {
  const [at, setAt] = useState<Menu | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  // A press on the button while open closes the menu; the click after must not reopen it.
  const wasOpen = useRef(false);
  const close = useCallback(() => setAt(null), []);
  return (
    <>
      <button ref={button} type="button" className="ex-cmd" disabled={disabled} aria-haspopup="menu" aria-expanded={!!at}
        onMouseDown={() => {
          wasOpen.current = !!at;
        }}
        onClick={() => {
          const r = button.current?.getBoundingClientRect();
          if (wasOpen.current || !r) {
            wasOpen.current = false;
            return setAt(null);
          }
          setAt({ x: r.left, y: r.bottom + 4, on: false });
        }}>
        <Icon name={icon} size={20} /><span>{label}</span><Icon name="expand_more" size={18} />
      </button>
      {at && <ContextMenu at={at} items={items} onClose={close} />}
    </>
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

// StorageApp is the explorer alone, as the storage address shows it.
export function StorageApp() {
  const [user, setUser] = useState<string | null>(null);
  useEffect(() => {
    // A sign-in that ended sends the page back through the gateway.
    const again = () => location.reload();
    addEventListener("signed-out", again);
    files.list("").then((l) => setUser(l.user)).catch(() => {});
    return () => removeEventListener("signed-out", again);
  }, []);
  return (
    <Notices>
      <div className="storage-app">
        <header className="storage-top">
          <span className="brand"><span className="brand-mark"><Icon name="hard_drive" size={20} /></span><span className="brand-name">File System</span></span>
          <span className="ex-grow" />
          {user && (
            <>
              <span className="muted">{user}</span>
              <a className="btn text" href="/__gate/logout"><Icon name="logout" size={18} />Sign out</a>
            </>
          )}
        </header>
        <Explorer title="File System" />
      </div>
    </Notices>
  );
}
