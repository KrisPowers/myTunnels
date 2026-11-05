import { useCallback, useEffect, useState } from "react";
import { api, bytes, fileUrl, filesIn, message, type ConvertJob, type ConvertKind, type ConvertState, type FileEntry, type Quality, type Space } from "./api";
import { Dropdown, type Option } from "./Dropdown";
import { extOf } from "./Files";
import { Icon, type IconName } from "./Icon";
import { Thumb } from "./Media";
import { useCan } from "./me";
import { Callout, Dialog, MoreMenu, useNotify, type MenuAction } from "./ui";

const PHOTOS = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif", "heic", "heif", "tif", "tiff"];
const VIDEOS = ["mp4", "mov", "m4v", "webm", "mkv", "avi", "3gp", "mts", "m2ts", "wmv"];

const kindOf = (name: string): ConvertKind | null => {
  const ext = extOf(name);
  return PHOTOS.includes(ext) ? "photo" : VIDEOS.includes(ext) ? "video" : ext === "pdf" ? "pdf" : null;
};

const FORMATS: Record<string, string> = { jpg: "JPEG", webp: "WebP", mp4: "MP4 (H.264)", pdf: "PDF" };
const QUALITIES: Option<Quality>[] = [
  { value: "high", label: "Best quality" },
  { value: "medium", label: "Balanced" },
  { value: "small", label: "Smallest file" },
];
const SHOW: Option<ConvertKind>[] = [
  { value: "photo", label: "Photos", icon: "image" },
  { value: "video", label: "Videos", icon: "movie" },
];
const SPACES: Option<Space>[] = [
  { value: "media", label: "Media", icon: "photo_library" },
  { value: "drive", label: "Drive", icon: "cloud" },
];
const ICONS: Record<ConvertKind, IconName> = { photo: "image", video: "movie", pdf: "picture_as_pdf" };

const sizeLabel = (kind: ConvertKind, size: number) =>
  size === 0 ? "Original size" : kind === "video" ? (size === 2160 ? "4K" : `${size}p`) : `${size} px`;
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ConvertPage makes copies of photos, videos and PDFs kept in Media and Drive,
// in another format or smaller, each saved beside its original. Its list is
// the queue, newest first.
export function ConvertPage({ space, path }: { space: string; path: string }) {
  const can = useCan();
  const spaces = SPACES.map((s) => s.value).filter((s) => (s === "media" ? can("media.view") && can("media.upload") : can("drive.view") && can("drive.edit")));
  const [state, setState] = useState<ConvertState | null>(null);
  const [problem, setProblem] = useState("");
  const [picking, setPicking] = useState<{ space: Space; path: string } | null>(() => (space === "media" || space === "drive" ? { space, path } : null));
  const notify = useNotify();

  const load = useCallback(async () => {
    try {
      setState(await api.convert());
      setProblem("");
    } catch (e) {
      setProblem(message(e));
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  // A file sent here from Media or Drive is picked once; the address goes back
  // to the page itself without reloading it.
  useEffect(() => {
    if (space) history.replaceState(null, "", "#/convert");
  }, [space]);

  const jobs = state?.jobs ?? [];
  const left = jobs.filter((j) => j.state === "waiting" || j.state === "running").length;
  useEffect(() => {
    if (!left) return;
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [left, load]);

  const remove = async (job: ConvertJob) => {
    try {
      await api.removeConvert(job.id);
    } catch (e) {
      notify(message(e), "bad");
    }
    await load();
  };

  return (
    <div className="convert">
      <div className="page-head">
        <div className="page-head-main">
          <h1>Convert</h1>
          {left > 0 && <div className="page-sub"><span><b>{left}</b> in the queue</span></div>}
        </div>
        <div className="page-actions">
          {spaces.length > 0 && (
            <button type="button" className="btn primary" onClick={() => setPicking({ space: spaces[0], path: "" })}>
              <Icon name="swap_horiz" size={18} />Convert
            </button>
          )}
        </div>
      </div>

      {problem && <Callout tone="bad" icon="error">{problem}</Callout>}
      {state && (
        <div className="page-body">
          {jobs.length === 0 ? (
            <div className="card welcome">
              <Icon name="swap_horiz" size={40} />
              <h2>Convert photos, videos and PDFs</h2>
              <p className="muted">Pick files from Media or Drive. Each copy is saved beside its original.</p>
              {spaces.length > 0 && (
                <button type="button" className="btn primary" onClick={() => setPicking({ space: spaces[0], path: "" })}>
                  <Icon name="swap_horiz" size={18} />Convert
                </button>
              )}
            </div>
          ) : (
            <div className="card">
              <div className="table-wrap">
                <table className="table cv-table">
                  <thead><tr><th className="grow">File</th><th>Result</th><th aria-label="Actions" /></tr></thead>
                  <tbody>{jobs.map((j) => <JobRow key={j.id} job={j} onRemove={() => remove(j)} />)}</tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {picking && state && (
        <Picker kinds={state.kinds} spaces={spaces} start={picking} onClose={() => setPicking(null)}
          onStarted={async (n) => {
            setPicking(null);
            notify(`Converting ${plural(n, "file")}`);
            await load();
          }} />
      )}
    </div>
  );
}

function JobRow({ job, onRemove }: { job: ConvertJob; onRemove: () => void }) {
  const done = job.state === "done" && job.output;
  const name = baseName(job.output ?? job.source);
  const what = [FORMATS[job.to] ?? job.to.toUpperCase(), ...(job.kind === "pdf" ? [] : [sizeLabel(job.kind, job.size)]), QUALITIES.find((q) => q.value === job.quality)?.label].join(" · ");
  const tone = { waiting: "", running: "plain", done: "ok", failed: "bad" }[job.state];
  const open = (inline: boolean) => {
    if (!job.output) return;
    const url = fileUrl(job.output, inline, job.space);
    if (inline) return window.open(url, "_blank", "noopener");
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
  };
  const actions: MenuAction[] = done ? [
    { label: "Open", icon: "open_in_new", onClick: () => open(true) },
    { label: "Download", icon: "download", onClick: () => open(false) },
    { label: "Remove from list", icon: "close", onClick: onRemove },
  ] : job.state === "failed" ? [
    { label: "Remove from list", icon: "close", onClick: onRemove },
  ] : [
    { label: "Cancel", icon: "close", danger: true, onClick: onRemove },
  ];
  return (
    <tr>
      <td>
        <div className="cv-name">
          <span className={"dot " + tone} title={job.state} />
          <Icon name={ICONS[job.kind]} className="cv-kind" />
          <span className="cv-name-text">
            <b title={job.source}>{name}</b>
            <small className={job.state === "failed" ? "bad" : undefined} title={job.error ?? undefined}>{job.state === "failed" ? job.error : what}</small>
            {job.state === "running" && job.kind === "video" && <span className="cv-bar"><span style={{ width: `${Math.round(job.progress * 100)}%` }} /></span>}
          </span>
        </div>
      </td>
      <td className="num">
        {job.state === "waiting" ? "Waiting"
          : job.state === "running" ? (job.kind === "video" ? `${Math.round(job.progress * 100)}%` : <span className="spinner small" />)
          : done ? `${bytes(job.source_size)} → ${bytes(job.output_size)}`
          : "Failed"}
      </td>
      <td className="cv-menu"><MoreMenu label={`Actions for ${name}`} actions={actions} /></td>
    </tr>
  );
}

// Picker chooses files from Media or Drive and what to make of them. Media
// shows photos or videos, since each has its own choices; Drive shows its
// folders and PDFs.
function Picker({ kinds, spaces, start, onClose, onStarted }: {
  kinds: ConvertState["kinds"];
  spaces: Space[];
  start: { space: Space; path: string };
  onClose: () => void;
  onStarted: (n: number) => void;
}) {
  const [space, setSpace] = useState<Space>(spaces.includes(start.space) ? start.space : spaces[0]);
  const [dir, setDir] = useState(start.space === "drive" && start.path.includes("/") ? start.path.slice(0, start.path.lastIndexOf("/")) : "");
  const [show, setShow] = useState<ConvertKind>(kindOf(start.path) === "video" ? "video" : "photo");
  const [picked, setPicked] = useState<Set<string>>(() => new Set(start.path && kindOf(start.path) ? [start.path] : []));
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [problem, setProblem] = useState("");
  const [to, setTo] = useState("");
  const [size, setSize] = useState(0);
  const [quality, setQuality] = useState<Quality>("medium");
  const [busy, setBusy] = useState(false);
  const notify = useNotify();

  useEffect(() => {
    let live = true;
    setEntries(null);
    filesIn(space).list(space === "media" ? "" : dir).then((l) => {
      if (live) {
        setEntries(l.entries);
        setProblem("");
      }
    }, (e) => live && setProblem(message(e)));
    return () => {
      live = false;
    };
  }, [space, dir]);

  const kind: ConvertKind = space === "drive" ? "pdf" : show;
  const spec = kinds.find((k) => k.kind === kind);
  const formats = spec?.formats ?? [];
  const sizes = spec?.sizes ?? [0];
  // A choice that does not fit what is shown falls back to the first one.
  const format = formats.includes(to) ? to : formats[0] ?? "";
  const scale = sizes.includes(size) ? size : 0;

  const files = (entries ?? [])
    .filter((e) => !e.dir && kindOf(e.name) === kind)
    .sort((a, b) => (space === "media" ? b.modified - a.modified : a.name.localeCompare(b.name, undefined, { numeric: true })));
  const folders = space === "drive" ? (entries ?? []).filter((e) => e.dir).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })) : [];
  const crumbs = dir ? dir.split("/") : [];

  const toggle = (path: string) => {
    const next = new Set(picked);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setPicked(next);
  };

  const submit = async () => {
    setBusy(true);
    try {
      const { queued } = await api.startConvert({ space, paths: [...picked], to: format, size: scale, quality });
      onStarted(queued);
    } catch (e) {
      notify(message(e), "bad");
      setBusy(false);
    }
  };

  return (
    <Dialog title="Convert" onClose={onClose}>
      <div className="cv-picker">
        <div className="cv-bar-row">
          {spaces.length > 1 && (
            <div className="ex-pick"><Dropdown label="From" value={space} options={SPACES.filter((s) => spaces.includes(s.value))} onChange={(s) => {
              setSpace(s);
              setDir("");
              setPicked(new Set());
            }} /></div>
          )}
          {space === "media" && (
            <div className="ex-pick"><Dropdown label="Show" value={show} options={SHOW} onChange={(k) => {
              setShow(k);
              setPicked(new Set());
            }} /></div>
          )}
          {picked.size > 0 && <span className="cv-count">{picked.size} picked</span>}
        </div>

        {space === "drive" && crumbs.length > 0 && (
          <div className="cv-crumbs">
            {["Drive", ...crumbs].map((name, i) => (
              <span key={i} className="ex-crumb-wrap">
                {i > 0 && <Icon name="chevron_right" size={18} className="ex-crumb-sep" />}
                {i === crumbs.length ? <span className="d-crumb on">{name}</span> : (
                  <button type="button" className="d-crumb" onClick={() => setDir(crumbs.slice(0, i).join("/"))}>{name}</button>
                )}
              </span>
            ))}
          </div>
        )}

        <div className="cv-pick">
          {problem ? <Callout tone="bad" icon="error">{problem}</Callout>
            : !entries ? <span className="spinner" />
            : files.length === 0 && folders.length === 0 ? (
              <p className="muted cv-empty">{space === "drive" ? "No PDFs here" : `No ${show === "photo" ? "photos" : "videos"} in Media`}</p>
            ) : space === "media" ? (
              <ul className="m-grid cv-grid">
                {files.map((e) => {
                  const on = picked.has(e.name);
                  return (
                    <li key={e.name} className={"m-tile picking" + (on ? " on" : "")}>
                      <button type="button" className="m-open" title={e.name} aria-pressed={on} onClick={() => toggle(e.name)}>
                        <Thumb name={e.name} />
                        {show === "video" && <Icon name="play_circle" size={20} className="m-badge" />}
                      </button>
                      <span className="m-check" aria-hidden="true"><Icon name="check" size={16} /></span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <ul className="cv-list">
                {folders.map((f) => (
                  <li key={f.name}>
                    <button type="button" className="d-row-name" onClick={() => setDir(join(dir, f.name))}>
                      <Icon name="folder" className="kind folder" /><span>{f.name}</span>
                    </button>
                  </li>
                ))}
                {files.map((f) => {
                  const path = join(dir, f.name);
                  const on = picked.has(path);
                  return (
                    <li key={f.name}>
                      <button type="button" className={"d-row-name pdf" + (on ? " on" : "")} aria-pressed={on} onClick={() => toggle(path)}>
                        <Icon name={on ? "check_circle" : "picture_as_pdf"} /><span>{f.name}</span><small>{bytes(f.size)}</small>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
        </div>

        <div className="cv-bar-row">
          {formats.length > 1 && <div className="ex-pick"><Dropdown label="Format" value={format} options={formats.map((f) => ({ value: f, label: FORMATS[f] ?? f.toUpperCase() }))} onChange={setTo} /></div>}
          {sizes.length > 1 && <div className="ex-pick"><Dropdown label="Size" value={scale} options={sizes.map((s) => ({ value: s, label: sizeLabel(kind, s) }))} onChange={setSize} /></div>}
          <div className="ex-pick"><Dropdown label="Quality" value={quality} options={QUALITIES} onChange={setQuality} /></div>
        </div>

        <div className="edit-actions">
          <button type="button" className="btn text" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy || !picked.size || !format} onClick={submit}>
            {busy && <span className="spinner small on-accent" />}Convert {picked.size ? plural(picked.size, "file") : ""}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
