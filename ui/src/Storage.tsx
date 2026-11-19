import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ago, api, bytes, fileUrl, files, locations, message, openPlace, type ConvertJob, type ConvertKind, type ConvertState, type DriveRoot, type DuplicateCopy, type Quality, type Share, type StorageLocation } from "./api";
import { Meter } from "./charts";
import { DrivePage } from "./Drive";
import { Dropdown, type Option } from "./Dropdown";
import { convertKind } from "./Files";
import { Icon } from "./Icon";
import { useCan, useMe } from "./me";
import { Copy, Dialog, MoreMenu, TextField, useNotify } from "./ui";

// StoragePage is network storage, as a NAS keeps it: locations, each a drive
// or a folder on this computer, browsed here and opened in File Explorer or
// Finder; and the account's own files, kept by myTunnels. Converting and share
// links are actions on the account's own files.
export function StoragePage() {
  const reloads = useRef<() => unknown>(() => {});
  const convert = useConvert(() => reloads.current());
  const shares = useShares();
  const [finding, setFinding] = useState(false);
  // The location open, "own" for the account's files, null for the list.
  const [open, setOpen] = useState<StorageLocation | "own" | null>(null);
  const show = (to: StorageLocation | "own" | null) => {
    openPlace(to && to !== "own" ? to.id : "");
    setOpen(to);
  };
  // Leaving Storage leaves the next visit on the account's own files.
  useEffect(() => () => openPlace(""), []);
  const tools = (
    <>
      {shares.button}
      <button type="button" className="icon-btn" aria-label="Find duplicates" title="Find duplicates" onClick={() => setFinding(true)}><Icon name="content_copy" /></button>
    </>
  );
  const extra = (
    <>
      {shares.ui}
      {finding && <DuplicatesDialog onClose={() => setFinding(false)} onChanged={() => reloads.current()} />}
    </>
  );

  const onReload = useCallback((reload: () => unknown) => {
    reloads.current = reload;
  }, []);
  if (!open) return <Locations onOpen={show} />;
  const own = open === "own";
  return (
    <DrivePage key={own ? "own" : open.id} title={own ? "My files" : open.name} onBack={() => show(null)} plain={!own}
      convert={convert} shares={shares} tools={own ? tools : null} extra={own ? extra : null} onReload={onReload} />
  );
}

// ---- locations ----

// Locations lists where Storage keeps files: the account's own, then each
// drive of its own, with its room and the address File Explorer and Finder
// open it at, or how far along it is while it is made.
function Locations({ onOpen }: { onOpen: (to: StorageLocation | "own") => void }) {
  const me = useMe();
  const notify = useNotify();
  const [list, setList] = useState<StorageLocation[] | null>(null);
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => locations.list().then((r) => setList(r.locations)).catch((e) => notify(message(e), "bad")), [notify]);
  useEffect(() => {
    load();
  }, [load]);
  // While a drive is being made, its progress is looked at again.
  const making = (list ?? []).some((l) => l.making !== null);
  useEffect(() => {
    if (!making) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [making, load]);
  const remove = async (l: StorageLocation) => {
    try {
      setList((await locations.remove(l.id)).locations);
      notify(`Removed ${l.name} and what was on it`);
    } catch (e) {
      notify(message(e), "bad");
    }
  };

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>Storage</h1>
          {list && <div className="page-sub"><span><b>{list.length}</b> {list.length === 1 ? "location" : "locations"}</span></div>}
        </div>
        <div className="page-actions">
          {me.admin && <button type="button" className="btn primary" onClick={() => setAdding(true)}><Icon name="add" size={18} />Add location</button>}
        </div>
      </div>
      <div className="page-body stack">
        <div className="card svc-card">
          <div className="table-wrap">
            <table className="table svc">
              <thead><tr><th className="grow">Location</th><th>Space</th><th>Network address</th><th /></tr></thead>
              <tbody>
                <tr className="svc-link" onClick={() => onOpen("own")}>
                  <td><span className="svc-name"><span className="svc-text"><b>My files</b><small className="plain">Kept by myTunnels for your account</small></span></span></td>
                  <td /><td /><td />
                </tr>
                {(list ?? []).map((l) => (
                  <tr key={l.id} className={"svc-link" + (l.here ? "" : " svc-down")} onClick={() => l.here && onOpen(l)}>
                    <td><span className="svc-name"><span className="svc-text"><b>{l.name}</b><small className="plain mono">{l.path}</small></span></span></td>
                    <td className="loc-space">
                      {l.making !== null ? <Meter value={l.making} max={100} tone="" label={`Making the drive · ${l.making}%`} />
                        : l.error ? <span className="chip bad" title={l.error}>Not made: {l.error}</span>
                        : l.space ? <Meter value={l.space.total - l.space.free} max={l.space.total} label={`${bytes(l.space.free)} free of ${bytes(l.space.total)}`} />
                        : <span className="chip">Not attached</span>}
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      {l.url ? <Copy text={mapCommand(l.url)} /> : <a href="#/routes/new">Expose this dashboard to reach it</a>}
                    </td>
                    <td className="svc-menu" onClick={(e) => e.stopPropagation()}>
                      {me.admin && l.making === null && <MoreMenu label={`Actions for ${l.name}`} actions={[{ label: "Remove", icon: "delete", danger: true, confirm: "Remove with everything on it", onClick: () => remove(l) }]} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      {adding && <AddLocation onClose={() => setAdding(false)} onAdded={(r) => {
        setList(r);
        setAdding(false);
      }} />}
    </>
  );
}

const GB = 1 << 30;

// The command that maps a location as a drive with a letter of its own on
// another Windows computer: File Explorer shows it under This PC with its size
// and free room, rather than as a network folder.
const mapCommand = (url: string) => {
  const { host, pathname } = new URL(url);
  return `net use * "\\\\${host}@SSL${pathname.replace(/\//g, "\\")}" /persistent:yes`;
};

// AddLocation makes a drive of its own: the drive whose free room it takes,
// how much, the letter it gets, and its name.
function AddLocation({ onClose, onAdded }: { onClose: () => void; onAdded: (list: StorageLocation[]) => void }) {
  const notify = useNotify();
  const [drives, setDrives] = useState<DriveRoot[] | null>(null);
  const [letters, setLetters] = useState<string[]>([]);
  const [from, setFrom] = useState("");
  const [size, setSize] = useState("");
  const [letter, setLetter] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    locations.drives().then((d) => {
      setDrives(d.drives);
      setLetters(d.letters);
      // The drive with the most room, and the first free letter.
      const roomiest = [...d.drives].sort((a, b) => (b.space?.free ?? 0) - (a.space?.free ?? 0))[0];
      if (roomiest) setFrom(roomiest.path);
      if (d.letters[0]) setLetter(d.letters[0]);
    }).catch((e) => notify(message(e), "bad"));
  }, [notify]);
  const source = drives?.find((d) => d.path === from);
  // Room left over on the drive it comes from, so that drive never fills.
  // A drive holds 2040 GB at most.
  const most = Math.min(2040, Math.max(0, Math.floor((source?.space?.free ?? 0) / GB) - 1));
  const gb = Number(size);
  const ok = !!from && !!letter && !!name && gb >= 1 && gb <= most;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ok) return;
    setBusy(true);
    try {
      onAdded((await locations.add(name, from, gb, letter)).locations);
      notify(`Making ${letter}: from ${from}`);
    } catch (err) {
      notify(message(err), "bad");
      setBusy(false);
    }
  };
  return (
    <Dialog title="Add location" onClose={onClose}>
      <form onSubmit={submit}>
        {drives && drives.length === 0 && <p className="muted">There is no drive here to make one from.</p>}
        <div className="tf static">
          <div className="tf-box">
            <Dropdown label="Take room from" value={from} onChange={setFrom}
              options={(drives ?? []).map((d) => ({ value: d.path, label: d.path, hint: d.space ? `${bytes(d.space.free)} free of ${bytes(d.space.total)}` : undefined }))} />
            <span className="tf-label">Take room from</span>
          </div>
        </div>
        <TextField label="Size in GB" mono inputMode="numeric" autoComplete="off" value={size}
          onChange={(v) => setSize(v.replace(/\D/g, "").slice(0, 6))}
          hint={source ? `Up to ${most} GB; it is all set aside on ${from} now` : undefined} />
        <div className="tf static">
          <div className="tf-box">
            <Dropdown label="Letter" value={letter} onChange={setLetter} options={letters.map((l) => ({ value: l, label: `${l}:` }))} />
            <span className="tf-label">Letter</span>
          </div>
        </div>
        <TextField label="Name" autoComplete="off" value={name}
          onChange={(v) => setName(v.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32))}
          hint={name ? `Its address ends in /dav/${name}` : undefined} />
        <div className="edit-actions">
          <button type="button" className="btn text" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !ok}>{busy && <span className="spinner small on-accent" />}Make drive</button>
        </div>
      </form>
    </Dialog>
  );
}

// What the file browser is given: the converter, share links, and a way to say
// how to reload it once a conversion lands in it.
export interface StorageProps {
  convert: Converter;
  shares: Sharer;
  // The buttons for the whole of Storage, for the page's actions, and their dialogs.
  tools: ReactNode;
  extra: ReactNode;
  onReload: (reload: () => unknown) => void;
  // The heading, and the way back to the list of locations.
  title?: string;
  onBack?: () => void;
  // A location on this computer: no share links or converting, which are the
  // account's own files'.
  plain?: boolean;
}

// ---- the duplicate finder ----

// DuplicatesDialog lists files kept more than once, by content. One copy in each set is kept, the oldest unless another is picked.
function DuplicatesDialog({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const can = useCan();
  const [groups, setGroups] = useState<DuplicateCopy[][] | null>(null);
  const [keep, setKeep] = useState<Record<number, number>>({});
  const [busy, setBusy] = useState(false);
  const notify = useNotify();
  const load = useCallback(async () => {
    try {
      setGroups((await api.duplicates()).groups);
      setKeep({});
    } catch (e) {
      notify(message(e), "bad");
    }
  }, [notify]);
  useEffect(() => {
    load();
  }, [load]);

  const mayDelete = can("drive.delete");
  const extras = (i: number) => (groups?.[i] ?? []).filter((_, j) => j !== (keep[i] ?? 0));
  const remove = async (copies: DuplicateCopy[]) => {
    setBusy(true);
    try {
      await files.remove(copies.map((c) => c.path));
      notify(`Deleted ${copies.length === 1 ? "1 copy" : `${copies.length} copies`}`);
      onChanged();
    } catch (e) {
      notify(message(e), "bad");
    }
    setBusy(false);
    await load();
  };
  const all = (groups ?? []).flatMap((_, i) => extras(i));
  const saved = (groups ?? []).reduce((n, g, i) => n + g[0].size * extras(i).length, 0);

  return (
    <Dialog title="Duplicates" onClose={onClose}>
      {!groups ? <span className="spinner" /> : groups.length === 0 ? (
        <p className="muted">No file is kept more than once.</p>
      ) : (
        <div className="cv-picker">
          <p className="muted">{plural(groups.length, "file")} kept more than once. Deleting the other copies frees {bytes(saved)}.</p>
          <div className="dup-list">
            {groups.map((g, i) => (
              <section key={i} className="dup-group">
                <div className="dup-head">
                  <b>{baseName(g[keep[i] ?? 0].path)}</b>
                  <small>{bytes(g[0].size)} each</small>
                  <button type="button" className="btn text" disabled={busy || !mayDelete} onClick={() => remove(extras(i))}>Delete other copies</button>
                </div>
                <ul className="item-list">
                  {g.map((c, j) => (
                    <li key={c.path} className="item-row">
                      <input type="radio" name={`keep-${i}`} aria-label={`Keep ${c.path}`} checked={(keep[i] ?? 0) === j} onChange={() => setKeep({ ...keep, [i]: j })} />
                      <span className="person">
                        <span className="scan-target">{c.path}</span>
                        <small>{new Date(c.modified * 1000).toLocaleDateString()}{(keep[i] ?? 0) === j ? ", kept" : ""}</small>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
          <div className="edit-actions">
            <button type="button" className="btn text" onClick={onClose}>Close</button>
            <button type="button" className="btn primary danger-fill" disabled={busy || !all.length || !mayDelete} onClick={() => remove(all)}>
              {busy && <span className="spinner small on-accent" />}Delete all other copies
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

// ---- share links ----

export interface Sharer {
  // Asks how long a link to these should last, and makes it.
  open: (paths: string[]) => void;
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
  const [making, setMaking] = useState<string[] | null>(null);
  const [listing, setListing] = useState(false);
  const button = (
    <button type="button" className="icon-btn" aria-label="Shared links" title="Shared links" onClick={() => setListing(true)}><Icon name="link" /></button>
  );
  const ui = (
    <>
      {making && <ShareDialog paths={making} onClose={() => setMaking(null)} />}
      {listing && <SharesDialog onClose={() => setListing(false)} />}
    </>
  );
  return { open: setMaking, button, ui };
}

const shareName = (s: { paths: string[] }) => (s.paths.length === 1 ? baseName(s.paths[0]) : plural(s.paths.length, "item"));

function ShareDialog({ paths, onClose }: { paths: string[]; onClose: () => void }) {
  const [days, setDays] = useState(7);
  const [password, setPassword] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const notify = useNotify();
  const make = async () => {
    setBusy(true);
    try {
      setUrl((await api.share({ paths, password, days })).url);
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

const FORMATS: Record<string, string> = { jpg: "JPEG", webp: "WebP", mp4: "MP4 (H.264)", pdf: "PDF", cutout: "No background", "cutout-white": "White background" };
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
  // Asks how to convert these files, all of one kind.
  open: (paths: string[]) => void;
  // Asks what to put behind photos once their background is removed.
  cutout: (paths: string[]) => void;
  // The conversions under way and done, at the bottom right.
  panel: ReactNode;
}

// useConvert keeps the conversion queue: the dialog that adds to it, and the
// panel that follows it. `onFinished` runs when a conversion lands.
function useConvert(onFinished: () => void): Converter {
  const [state, setState] = useState<ConvertState | null>(null);
  const [asking, setAsking] = useState<{ paths: string[]; kind: ConvertKind } | null>(null);
  const [cutting, setCutting] = useState<string[] | null>(null);
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

  const open = (paths: string[]) => {
    const kinds = new Set(paths.map(convertKind));
    const [kind] = [...kinds];
    if (kinds.size !== 1 || !kind) return notify("Pick photos, videos or PDFs of one kind to convert", "bad");
    setAsking({ paths, kind });
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

  const started = async (n: number) => {
    setAsking(null);
    setCutting(null);
    setHidden(false);
    notify(`Converting ${plural(n, "file")}`);
    await load();
  };
  const cutout = (paths: string[]) => {
    if (!paths.every((p) => convertKind(p) === "photo")) return notify("Pick photos to remove their background", "bad");
    setCutting(paths);
  };
  const dialog = (
    <>
      {asking && state && <ConvertDialog {...asking} kinds={state.kinds} onClose={() => setAsking(null)} onStarted={started} />}
      {cutting && <CutoutDialog paths={cutting} onClose={() => setCutting(null)} onStarted={started} />}
    </>
  );
  return { open, cutout, panel: <>{panel}{dialog}</> };
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
        <a className="icon-btn small" href={fileUrl(job.output, true)} target="_blank" rel="noopener" aria-label={`Open ${name}`}><Icon name="open_in_new" size={16} /></a>
      ) : <span />}
    </li>
  );
}

const BACKGROUNDS: Option<string>[] = [
  { value: "cutout", label: "Transparent (PNG)" },
  { value: "cutout-white", label: "White (JPEG)" },
];

// CutoutDialog asks what goes behind a photo's subject once its background is
// removed. Each result is saved beside its photo.
function CutoutDialog({ paths, onClose, onStarted }: { paths: string[]; onClose: () => void; onStarted: (n: number) => void }) {
  const [to, setTo] = useState("cutout");
  const [busy, setBusy] = useState(false);
  const notify = useNotify();
  const submit = async () => {
    setBusy(true);
    try {
      onStarted((await api.startConvert({ paths, to, size: 0, quality: "high" })).queued);
    } catch (e) {
      notify(message(e), "bad");
      setBusy(false);
    }
  };
  return (
    <Dialog title={paths.length === 1 ? `Remove the background of ${baseName(paths[0])}` : `Remove the background of ${plural(paths.length, "photo")}`} onClose={onClose}>
      <div className="cv-picker">
        <div className="cv-bar-row">
          <div className="ex-pick"><Dropdown label="Background" value={to} options={BACKGROUNDS} onChange={setTo} /></div>
        </div>
        <p className="muted">The subject is cut out on this server and saved beside the original, which is never changed.</p>
        <div className="edit-actions">
          <button type="button" className="btn text" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" autoFocus disabled={busy} onClick={submit}>
            {busy && <span className="spinner small on-accent" />}Remove background
          </button>
        </div>
      </div>
    </Dialog>
  );
}

// ConvertDialog asks what to make of the picked files: a format, a size and a
// quality. Each copy is saved beside its original.
function ConvertDialog({ paths, kind, kinds, onClose, onStarted }: {
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
      const { queued } = await api.startConvert({ paths, to, size, quality });
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
