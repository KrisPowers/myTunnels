import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ago, api, bytes, fileUrl, message, type ConvertJob, type ConvertKind, type ConvertState, type Quality, type Share, type Space } from "./api";
import { DrivePage } from "./Drive";
import { Dropdown, type Option } from "./Dropdown";
import { convertKind } from "./Files";
import { Icon, type IconName } from "./Icon";
import { MediaPage } from "./Media";
import { useCan } from "./me";
import { Copy, Dialog, TextField, useNotify } from "./ui";

// StoragePage is photos, videos and files kept on this host, in one page with a
// tab for each: Photos and videos (the media space) and Files (the drive space).
// Converting is an action on what is picked there, with its progress in a panel.
export function StoragePage({ tab }: { tab: string }) {
  const can = useCan();
  const tabs: [string, string, IconName][] = [
    ...(can("media.view") ? [["", "Photos and videos", "photo_library"] as [string, string, IconName]] : []),
    ...(can("drive.view") ? [["files", "Files", "folder"] as [string, string, IconName]] : []),
  ];
  const current = tabs.some(([k]) => k === tab) ? tab : tabs[0]?.[0] ?? "";
  const reloads = useRef<() => unknown>(() => {});
  const convert = useConvert(() => reloads.current());
  const shares = useShares();

  const nav = tabs.length > 1 && (
    <nav className="sub-nav" aria-label="Storage">
      {tabs.map(([key, label, icon]) => (
        <a key={key} className={"sub-nav-item" + (current === key ? " on" : "")} href={key ? `#/storage/${key}` : "#/storage"} aria-current={current === key ? "page" : undefined}>
          <Icon name={icon} size={18} />
          <span>{label}</span>
        </a>
      ))}
    </nav>
  );
  const onReload = useCallback((reload: () => unknown) => {
    reloads.current = reload;
  }, []);
  const props = { nav, convert, shares, onReload };
  return current === "files" ? <DrivePage {...props} /> : <MediaPage {...props} />;
}

// What a tab is given: the tabs to show under the heading, the converter, and a
// way to say how to reload it once a conversion lands in it.
export interface TabProps {
  nav: ReactNode;
  convert: Converter;
  shares: Sharer;
  onReload: (reload: () => unknown) => void;
}

// ---- share links ----

export interface Sharer {
  // Asks how long a link to these should last, and makes it.
  open: (space: Space, paths: string[]) => void;
  // The button that lists the links made, for the page's actions.
  button: ReactNode;
  // The dialogs, wherever the page puts them.
  ui: ReactNode;
}

const LASTS: Option<number>[] = [
  { value: 1, label: "1 day" },
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
  { value: 0, label: "Never expires" },
];

// useShares makes share links and lists them to end them.
function useShares(): Sharer {
  const [making, setMaking] = useState<{ space: Space; paths: string[] } | null>(null);
  const [listing, setListing] = useState(false);
  const button = (
    <button type="button" className="icon-btn" aria-label="Shared links" title="Shared links" onClick={() => setListing(true)}><Icon name="link" /></button>
  );
  const ui = (
    <>
      {making && <ShareDialog {...making} onClose={() => setMaking(null)} />}
      {listing && <SharesDialog onClose={() => setListing(false)} />}
    </>
  );
  return { open: (space, paths) => setMaking({ space, paths }), button, ui };
}

const shareName = (s: { paths: string[] }) => (s.paths.length === 1 ? baseName(s.paths[0]) : plural(s.paths.length, "item"));

function ShareDialog({ space, paths, onClose }: { space: Space; paths: string[]; onClose: () => void }) {
  const [days, setDays] = useState(7);
  const [password, setPassword] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const notify = useNotify();
  const make = async () => {
    setBusy(true);
    try {
      setUrl((await api.share({ space, paths, password, days })).url);
    } catch (e) {
      notify(message(e), "bad");
    }
    setBusy(false);
  };
  return (
    <Dialog title={`Share ${shareName({ paths })}`} onClose={onClose}>
      {url ? (
        <div className="cv-picker">
          <p className="muted">Anyone with this link can open it{password ? " with the password" : ""}, without an account.</p>
          <div className="token-secret"><Copy text={url} /></div>
          <div className="edit-actions"><button type="button" className="btn primary" onClick={onClose}>Done</button></div>
        </div>
      ) : (
        <div className="cv-picker">
          <div className="cv-bar-row">
            <div className="ex-pick"><Dropdown label="Lasts" value={days} options={LASTS} onChange={setDays} /></div>
          </div>
          <TextField label="Password, if you want one" type="password" autoComplete="new-password" value={password} onChange={setPassword} />
          <div className="edit-actions">
            <button type="button" className="btn text" onClick={onClose}>Cancel</button>
            <button type="button" className="btn primary" disabled={busy} onClick={make}>{busy && <span className="spinner small on-accent" />}Make link</button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

// SharesDialog lists the links made, each with when it ends and an end button.
function SharesDialog({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<Share[] | null>(null);
  const notify = useNotify();
  const load = useCallback(() => api.shares().then((r) => setList(r.shares)).catch((e) => notify(message(e), "bad")), [notify]);
  useEffect(() => {
    load();
  }, [load]);
  const end = async (s: Share) => {
    try {
      await api.endShare(s.id);
      notify("Link ended");
    } catch (e) {
      notify(message(e), "bad");
    }
    await load();
  };
  return (
    <Dialog title="Shared links" onClose={onClose}>
      {!list ? <span className="spinner" /> : list.length === 0 ? (
        <p className="muted">No links yet. Share from an item's menu.</p>
      ) : (
        <ul className="item-list">
          {list.map((s) => (
            <li key={s.id} className="item-row">
              <Icon name={s.protected ? "lock" : "link"} size={18} className="item-icon" />
              <span className="person">
                <span className="scan-target">{shareName(s)}</span>
                <small>{[s.expires ? `ends ${new Date(s.expires * 1000).toLocaleDateString()}` : "never ends", `made ${ago(s.created_at)}`, `opened ${plural(s.opened, "time")}`].join(", ")}</small>
              </span>
              <button type="button" className="icon-btn small danger" aria-label={`End the link to ${shareName(s)}`} title="End link" onClick={() => end(s)}>
                <Icon name="close" size={18} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

// ---- converting ----

const FORMATS: Record<string, string> = { jpg: "JPEG", webp: "WebP", mp4: "MP4 (H.264)", pdf: "PDF" };
const QUALITIES: Option<Quality>[] = [
  { value: "high", label: "Best quality" },
  { value: "medium", label: "Balanced" },
  { value: "small", label: "Smallest file" },
];
const sizeLabel = (kind: ConvertKind, size: number) =>
  size === 0 ? "Original size" : kind === "video" ? (size === 2160 ? "4K" : `${size}p`) : `${size} px`;
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export interface Converter {
  // Asks how to convert these files, all of one kind, from one space.
  open: (space: Space, paths: string[]) => void;
  // The conversions under way and done, at the bottom right.
  panel: ReactNode;
}

// useConvert keeps the conversion queue: the dialog that adds to it, and the
// panel that follows it. `onFinished` runs when a conversion lands.
function useConvert(onFinished: () => void): Converter {
  const [state, setState] = useState<ConvertState | null>(null);
  const [asking, setAsking] = useState<{ space: Space; paths: string[]; kind: ConvertKind } | null>(null);
  const [hidden, setHidden] = useState(false);
  const [small, setSmall] = useState(false);
  const notify = useNotify();
  const finished = useRef(onFinished);
  finished.current = onFinished;

  const load = useCallback(async () => {
    try {
      setState(await api.convert());
    } catch {
      // The panel stays as it was until the next look.
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const jobs = state?.jobs ?? [];
  const left = jobs.filter((j) => j.state === "waiting" || j.state === "running").length;
  const before = useRef(left);
  useEffect(() => {
    if (left < before.current) finished.current();
    before.current = left;
    if (!left) return;
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [left, load]);

  const open = (space: Space, paths: string[]) => {
    const kinds = new Set(paths.map(convertKind));
    const [kind] = [...kinds];
    if (kinds.size !== 1 || !kind) return notify("Pick photos, videos or PDFs of one kind to convert", "bad");
    setAsking({ space, paths, kind });
  };

  const clear = async () => {
    await Promise.all(jobs.filter((j) => j.state === "done" || j.state === "failed").map((j) => api.removeConvert(j.id).catch(() => {})));
    setHidden(true);
    await load();
  };
  const cancel = async (job: ConvertJob) => {
    await api.removeConvert(job.id).catch((e) => notify(message(e), "bad"));
    await load();
  };

  const failed = jobs.filter((j) => j.state === "failed").length;
  const panel = jobs.length > 0 && !hidden && (
    <section className="ex-uploads" aria-label="Conversions">
      <div className="ex-uploads-head">
        <b>{left ? `Converting ${plural(left, "file")}` : failed ? `${plural(failed, "conversion")} failed` : "Conversions done"}</b>
        <button type="button" className="icon-btn small" aria-label={small ? "Show conversions" : "Hide conversions"} onClick={() => setSmall((s) => !s)}>
          <Icon name="expand_more" size={18} className={small ? "flip" : undefined} />
        </button>
        {!left && <button type="button" className="icon-btn small" aria-label="Close" onClick={clear}><Icon name="close" size={18} /></button>}
      </div>
      {!small && (
        <ul>
          {jobs.map((j) => <JobRow key={j.id} job={j} onCancel={() => cancel(j)} />)}
        </ul>
      )}
    </section>
  );

  const dialog = asking && state && (
    <ConvertDialog {...asking} kinds={state.kinds} onClose={() => setAsking(null)}
      onStarted={async (n) => {
        setAsking(null);
        setHidden(false);
        notify(`Converting ${plural(n, "file")}`);
        await load();
      }} />
  );
  return { open, panel: <>{panel}{dialog}</> };
}

function JobRow({ job, onCancel }: { job: ConvertJob; onCancel: () => void }) {
  const name = baseName(job.output ?? job.source);
  const busy = job.state === "waiting" || job.state === "running";
  const note = job.state === "failed" ? job.error
    : job.state === "done" ? `${bytes(job.source_size)} → ${bytes(job.output_size)}`
    : job.state === "waiting" ? "Waiting"
    : job.kind === "video" ? `${Math.round(job.progress * 100)}%` : "Converting";
  return (
    <li className={job.state === "done" ? "done" : job.state === "failed" ? "failed" : undefined}>
      <Icon name={job.state === "done" ? "check_circle" : job.state === "failed" ? "error" : "swap_horiz"} size={18} />
      <span className="ex-up-name" title={job.source}>{name}</span>
      <small title={job.error ?? undefined}>{note}</small>
      {busy ? (
        <button type="button" className="icon-btn small" aria-label={`Cancel ${name}`} onClick={onCancel}><Icon name="close" size={16} /></button>
      ) : job.state === "done" && job.output ? (
        <a className="icon-btn small" href={fileUrl(job.output, true, job.space)} target="_blank" rel="noopener" aria-label={`Open ${name}`}><Icon name="open_in_new" size={16} /></a>
      ) : <span />}
    </li>
  );
}

// ConvertDialog asks what to make of the picked files: a format, a size and a
// quality. Each copy is saved beside its original.
function ConvertDialog({ space, paths, kind, kinds, onClose, onStarted }: {
  space: Space;
  paths: string[];
  kind: ConvertKind;
  kinds: ConvertState["kinds"];
  onClose: () => void;
  onStarted: (n: number) => void;
}) {
  const spec = kinds.find((k) => k.kind === kind);
  const formats = spec?.formats ?? [];
  const sizes = spec?.sizes ?? [0];
  const [to, setTo] = useState(formats[0] ?? "");
  const [size, setSize] = useState(0);
  const [quality, setQuality] = useState<Quality>("medium");
  const [busy, setBusy] = useState(false);
  const notify = useNotify();

  const submit = async () => {
    setBusy(true);
    try {
      const { queued } = await api.startConvert({ space, paths, to, size, quality });
      onStarted(queued);
    } catch (e) {
      notify(message(e), "bad");
      setBusy(false);
    }
  };

  return (
    <Dialog title={paths.length === 1 ? `Convert ${baseName(paths[0])}` : `Convert ${plural(paths.length, "file")}`} onClose={onClose}>
      <div className="cv-picker">
        <div className="cv-bar-row">
          {formats.length > 1 && <div className="ex-pick"><Dropdown label="Format" value={to} options={formats.map((f) => ({ value: f, label: FORMATS[f] ?? f.toUpperCase() }))} onChange={setTo} /></div>}
          {sizes.length > 1 && <div className="ex-pick"><Dropdown label="Size" value={size} options={sizes.map((s) => ({ value: s, label: sizeLabel(kind, s) }))} onChange={setSize} /></div>}
          <div className="ex-pick"><Dropdown label="Quality" value={quality} options={QUALITIES} onChange={setQuality} /></div>
        </div>
        <p className="muted">Each copy is saved beside its original, which is never changed.</p>
        <div className="edit-actions">
          <button type="button" className="btn text" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" autoFocus disabled={busy || !to} onClick={submit}>
            {busy && <span className="spinner small on-accent" />}Convert
          </button>
        </div>
      </div>
    </Dialog>
  );
}
