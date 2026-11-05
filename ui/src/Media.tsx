import { useCallback, useEffect, useRef, useState, type DragEvent, type MouseEvent as PointerEvent } from "react";
import { createPortal } from "react-dom";
import { bytes, fileUrl, filesIn, message, saveThumb, thumbUrl, type FileEntry, type Listing } from "./api";
import { MultiDropdown, type Option } from "./Dropdown";
import { ContextMenu, dropped, extOf, freeName, ownMenu, useUploads, type Menu, type MenuItem, type Picked } from "./Files";
import { Icon } from "./Icon";
import { Callout, Dialog, useNotify } from "./ui";

const media = filesIn("media");

const PHOTOS = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif", "heic", "heif", "tif", "tiff"];
const VIDEOS = ["mp4", "mov", "m4v", "webm", "mkv", "avi", "3gp", "mts", "m2ts", "wmv"];
// What browsers can show by themselves; the rest are kept and downloaded.
const SHOWN = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif", "mp4", "m4v", "webm", "mov"];

const isVideo = (name: string) => VIDEOS.includes(extOf(name));
const kept = (name: string) => PHOTOS.includes(extOf(name)) || isVideo(name);
const shows = (name: string) => SHOWN.includes(extOf(name));

type Kind = "photos" | "videos";
const KINDS: Option<Kind>[] = [
  { value: "photos", label: "Photos", icon: "image" },
  { value: "videos", label: "Videos", icon: "movie" },
];

// Waits for `event` on `el`, or gives up after a while.
function once(el: HTMLElement, event: string, ms = 10_000) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timed out")), ms);
    el.addEventListener(event, () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
    el.addEventListener("error", () => {
      clearTimeout(t);
      reject(new Error("unreadable"));
    }, { once: true });
  });
}

// makeThumb draws a small JPEG of a photo, or of a frame a second into a
// video, its short side 480 pixels; null when the browser cannot read it.
async function makeThumb(file: File): Promise<Blob | null> {
  const url = URL.createObjectURL(file);
  try {
    let source: CanvasImageSource;
    let w: number;
    let h: number;
    if (isVideo(file.name)) {
      const v = document.createElement("video");
      v.muted = true;
      v.preload = "auto";
      v.src = url;
      await once(v, "loadeddata");
      const seeked = once(v, "seeked");
      v.currentTime = Math.min(1, (v.duration || 0) / 2);
      await seeked;
      [source, w, h] = [v, v.videoWidth, v.videoHeight];
    } else {
      const bitmap = await createImageBitmap(file);
      [source, w, h] = [bitmap, bitmap.width, bitmap.height];
    }
    if (!w || !h) return null;
    const scale = Math.min(1, 480 / Math.min(w, h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    canvas.getContext("2d")?.drawImage(source, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.8));
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const monthOf = (at: number) => new Date(at * 1000).toLocaleDateString([], { month: "long", year: "numeric" });
const dayOf = (at: number) => new Date(at * 1000).toLocaleDateString([], { dateStyle: "long" });

// MediaPage is a home cloud for photos and videos: everything uploaded, newest
// first and grouped by month, opened one at a time in a viewer.
export function MediaPage() {
  const [listing, setListing] = useState<Listing | null>(null);
  const [problem, setProblem] = useState("");
  const [kinds, setKinds] = useState<Kind[]>(["photos", "videos"]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [viewing, setViewing] = useState<number | null>(null);
  const [removing, setRemoving] = useState<string[] | null>(null);
  const [dragging, setDragging] = useState(false);
  const [menu, setMenu] = useState<(Menu & { name: string | null }) | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const notify = useNotify();

  const load = useCallback(async () => {
    try {
      setListing(await media.list(""));
      setProblem("");
    } catch (e) {
      setProblem(message(e));
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const { send, panel } = useUploads("media", load, async (item, path) => {
    const jpeg = await makeThumb(item.file);
    if (jpeg) await saveThumb(path, jpeg).catch(() => {});
  });

  const all = (listing?.entries ?? []).filter((e) => !e.dir && kept(e.name)).sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name));
  const photos = all.filter((e) => !isVideo(e.name)).length;
  // Nothing picked shows everything, as both picked does.
  const items = all.filter((e) => !kinds.length || kinds.includes(isVideo(e.name) ? "videos" : "photos"));
  const months: [string, FileEntry[]][] = [];
  for (const e of items) {
    const label = monthOf(e.modified);
    const last = months[months.length - 1];
    if (last && last[0] === label) last[1].push(e);
    else months.push([label, [e]]);
  }

  const start = (picked: Picked[]) => {
    const fit = picked.filter((p) => kept(p.file.name));
    if (fit.length < picked.length) {
      const n = picked.length - fit.length;
      notify(`Skipped ${n} file${n === 1 ? "" : "s"}: Media keeps photos and videos`, "bad");
    }
    const taken = new Set((listing?.entries ?? []).map((e) => e.name));
    send(fit.map((p) => {
      const name = freeName(p.file.name, taken);
      taken.add(name);
      return { item: { file: p.file, rel: name }, path: name };
    }));
  };

  const toggle = (name: string) => {
    const next = new Set(selected);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setSelected(next);
  };

  const download = (names: string[]) => {
    for (const name of names) {
      const a = document.createElement("a");
      a.href = fileUrl(name, false, "media");
      a.download = name;
      document.body.append(a);
      a.click();
      a.remove();
    }
  };

  const remove = async (names: string[]) => {
    setRemoving(null);
    try {
      await media.remove(names);
      notify(`Deleted ${names.length} item${names.length === 1 ? "" : "s"}`);
      setSelected(new Set());
      setViewing(null);
    } catch (e) {
      notify(message(e), "bad");
    }
    await load();
  };

  // A right-click on a photo or video acts on the selection it is in, or on it
  // alone; on the page, it offers uploading and selecting.
  const contextMenu = (e: PointerEvent, name: string | null) => {
    if (!ownMenu(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, on: !!name, name });
  };
  const menuItems = (name: string | null): MenuItem[] => {
    if (!name) {
      return [
        { label: "Upload", icon: "cloud_upload", run: () => input.current?.click() },
        { label: "Select all", icon: "select_all", hidden: !items.length, run: () => setSelected(new Set(items.map((e) => e.name))) },
        { label: "Clear selection", icon: "close", hidden: !selected.size, run: () => setSelected(new Set()) },
      ];
    }
    const targets = selected.has(name) ? [...selected] : [name];
    const many = targets.length > 1 ? ` ${targets.length} items` : "";
    return [
      { label: "Open", icon: "open_in_new", hidden: targets.length > 1, run: () => setViewing(items.findIndex((e) => e.name === name)) },
      { label: selected.has(name) ? "Unselect" : "Select", icon: "check_circle", run: () => toggle(name) },
      { label: "Download" + many, icon: "download", run: () => download(targets) },
      { label: "Delete" + many, icon: "delete", danger: true, run: () => setRemoving(targets) },
    ];
  };

  const onDragOver = (e: DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    setDragging(true);
  };
  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    start(await dropped(e.dataTransfer.items));
  };

  return (
    <div className="media" onDragOver={onDragOver} onDrop={onDrop} onContextMenu={(e) => contextMenu(e, null)}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDragging(false)}>
      <div className="page-head">
        <div className="page-head-main">
          <h1>Media</h1>
          {listing && (
            <div className="page-sub">
              <span><b>{photos}</b> photo{photos === 1 ? "" : "s"}</span>
              <span><b>{all.length - photos}</b> video{all.length - photos === 1 ? "" : "s"}</span>
              {listing.space && <span>{bytes(listing.space.free)} free</span>}
            </div>
          )}
        </div>
        <div className="page-actions">
          {selected.size > 0 ? (
            <>
              <span className="m-picked">{selected.size} selected</span>
              <button type="button" className="icon-btn" aria-label="Download" title="Download" onClick={() => download([...selected])}><Icon name="download" /></button>
              <button type="button" className="icon-btn danger" aria-label="Delete" title="Delete" onClick={() => setRemoving([...selected])}><Icon name="delete" /></button>
              <button type="button" className="icon-btn" aria-label="Clear selection" title="Clear selection" onClick={() => setSelected(new Set())}><Icon name="close" /></button>
            </>
          ) : (
            <>
              <div className="ex-pick">
                <MultiDropdown label="Show" values={kinds} options={KINDS} allLabel="Photos and videos" onChange={setKinds} />
              </div>
              <button type="button" className="btn primary" onClick={() => input.current?.click()}><Icon name="cloud_upload" size={18} />Upload</button>
            </>
          )}
        </div>
      </div>

      {problem && <Callout tone="bad" icon="error">{problem}</Callout>}
      {listing && (
        <div className="page-body">
          {all.length === 0 ? (
            <div className="card welcome">
              <Icon name="photo_library" size={40} />
              <h2>Your photos and videos</h2>
              <p className="muted">Upload them here, or drag them onto this page, and they are kept on this host, by the date each was taken.</p>
              <button type="button" className="btn primary" onClick={() => input.current?.click()}><Icon name="cloud_upload" size={18} />Upload</button>
            </div>
          ) : items.length === 0 ? (
            <p className="muted">No {kinds[0]} yet.</p>
          ) : (
            months.map(([label, list]) => (
              <section key={label} className="m-month">
                <h2>{label}</h2>
                <ul className="m-grid">
                  {list.map((e) => {
                    const on = selected.has(e.name);
                    return (
                      <li key={e.name} className={"m-tile" + (on ? " on" : "") + (selected.size ? " picking" : "")} onContextMenu={(ev) => contextMenu(ev, e.name)}>
                        <button type="button" className="m-open" title={`${e.name}\n${dayOf(e.modified)}`}
                          onClick={() => (selected.size ? toggle(e.name) : setViewing(items.indexOf(e)))}>
                          <Thumb name={e.name} />
                          {isVideo(e.name) && <Icon name="play_circle" size={22} className="m-badge" />}
                        </button>
                        <button type="button" className="m-check" aria-label={on ? `Unselect ${e.name}` : `Select ${e.name}`} aria-pressed={on} onClick={() => toggle(e.name)}>
                          <Icon name="check" size={16} />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))
          )}
        </div>
      )}

      {dragging && <div className="m-drop"><Icon name="cloud_upload" size={40} /><span>Drop photos and videos to upload</span></div>}
      <input ref={input} type="file" multiple hidden accept="image/*,video/*" onChange={(e) => {
        if (e.target.files) start(Array.from(e.target.files, (file) => ({ file, rel: file.name })));
        e.target.value = "";
      }} />
      {viewing !== null && items[viewing] && (
        <Viewer items={items} at={viewing} onMove={setViewing} onClose={() => setViewing(null)}
          onDownload={(name) => download([name])} onDelete={(name) => setRemoving([name])} />
      )}
      {removing && (
        <Dialog title={removing.length === 1 ? `Delete ${removing[0]}?` : `Delete ${removing.length} items?`} onClose={() => setRemoving(null)}>
          <p className="muted">They are removed from this host for good.</p>
          <div className="edit-actions">
            <button type="button" className="btn text" onClick={() => setRemoving(null)}>Cancel</button>
            <button type="button" className="btn primary danger-fill" autoFocus onClick={() => remove(removing)}>Delete</button>
          </div>
        </Dialog>
      )}
      {menu && <ContextMenu at={menu} items={menuItems(menu.name)} onClose={() => setMenu(null)} />}
      {panel}
    </div>
  );
}

// Thumb is a tile's picture: its preview, else the photo itself where the
// browser can show it, else a plain mark.
function Thumb({ name }: { name: string }) {
  const [stage, setStage] = useState(0);
  if (stage === 2) return <span className="m-none"><Icon name={isVideo(name) ? "movie" : "image"} size={36} /></span>;
  return (
    <img src={stage === 0 ? thumbUrl(name) : fileUrl(name, true, "media")} alt="" loading="lazy" draggable={false}
      onError={() => setStage(stage === 0 && !isVideo(name) && shows(name) ? 1 : 2)} />
  );
}

// Viewer shows one photo or video over everything, with the ones either side
// a click or an arrow key away.
function Viewer({ items, at, onMove, onClose, onDownload, onDelete }: {
  items: FileEntry[];
  at: number;
  onMove: (at: number) => void;
  onClose: () => void;
  onDownload: (name: string) => void;
  onDelete: (name: string) => void;
}) {
  const e = items[at];
  useEffect(() => {
    const key = (ev: KeyboardEvent) => {
      if (document.querySelector(".dialog-scrim")) return;
      if (ev.key === "Escape") onClose();
      if (ev.key === "ArrowLeft" && at > 0) onMove(at - 1);
      if (ev.key === "ArrowRight" && at < items.length - 1) onMove(at + 1);
    };
    document.addEventListener("keydown", key);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", key);
      document.body.style.overflow = overflow;
    };
  }, [at, items.length, onClose, onMove]);

  return createPortal(
    <div className="m-viewer" role="dialog" aria-modal="true" aria-label={e.name}>
      <div className="m-viewer-bar">
        <button type="button" className="icon-btn" aria-label="Close" title="Close (Esc)" onClick={onClose}><Icon name="arrow_back" /></button>
        <div className="m-viewer-title">
          <b>{e.name}</b>
          <small>{dayOf(e.modified)} · {bytes(e.size)}</small>
        </div>
        <button type="button" className="icon-btn" aria-label="Download" title="Download" onClick={() => onDownload(e.name)}><Icon name="download" /></button>
        <button type="button" className="icon-btn" aria-label="Delete" title="Delete" onClick={() => onDelete(e.name)}><Icon name="delete" /></button>
      </div>
      <div className="m-stage" onClick={(ev) => ev.target === ev.currentTarget && onClose()}>
        {!shows(e.name) ? (
          <div className="m-none big"><Icon name={isVideo(e.name) ? "movie" : "image"} size={56} /><span>This browser cannot show {extOf(e.name).toUpperCase()} files. Download it to open it.</span></div>
        ) : isVideo(e.name) ? (
          <video key={e.name} src={fileUrl(e.name, true, "media")} controls autoPlay playsInline />
        ) : (
          <img key={e.name} src={fileUrl(e.name, true, "media")} alt={e.name} />
        )}
        {at > 0 && <button type="button" className="m-step prev" aria-label="Previous" onClick={() => onMove(at - 1)}><Icon name="chevron_left" size={32} /></button>}
        {at < items.length - 1 && <button type="button" className="m-step next" aria-label="Next" onClick={() => onMove(at + 1)}><Icon name="chevron_right" size={32} /></button>}
      </div>
    </div>,
    document.body,
  );
}
