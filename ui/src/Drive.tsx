import { useCallback, useEffect, useRef, useState, type DragEvent, type MouseEvent as PointerEvent } from "react";
import { bytes, fileUrl, files, message, saveThumb, type FileEntry, type Listing } from "./api";
import { Dropdown, MultiDropdown, type Option } from "./Dropdown";
import { ContextMenu, convertKind, dropped, extOf, NameDialog, ownMenu, useUploads, type Menu, type MenuItem, type Picked } from "./Files";
import { Icon, type IconName } from "./Icon";
import { isPhoto, isVideo, makeThumb, Thumb, Viewer } from "./Media";
import { useCan } from "./me";
import type { StorageProps } from "./Storage";
import { Callout, Dialog, useNotify } from "./ui";

type Kind = "photo" | "video" | "doc" | "sheet" | "slides" | "pdf" | "text" | "archive";

const KINDS: Record<Kind, { label: string; icon: IconName; exts: string[] }> = {
  photo: { label: "Photos", icon: "image", exts: ["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif", "heic", "heif", "tif", "tiff"] },
  video: { label: "Videos", icon: "movie", exts: ["mp4", "mov", "m4v", "webm", "mkv", "avi", "3gp", "mts", "m2ts", "wmv"] },
  doc: { label: "Documents", icon: "article", exts: ["doc", "docx", "docm", "dot", "dotx", "odt", "rtf", "pages"] },
  sheet: { label: "Spreadsheets", icon: "table", exts: ["xls", "xlsx", "xlsm", "xlt", "xltx", "ods", "csv", "tsv", "numbers"] },
  slides: { label: "Presentations", icon: "slideshow", exts: ["ppt", "pptx", "pptm", "pps", "ppsx", "odp", "key"] },
  pdf: { label: "PDFs", icon: "picture_as_pdf", exts: ["pdf"] },
  text: { label: "Text", icon: "description", exts: ["txt", "md", "epub"] },
  archive: { label: "Archives", icon: "folder_zip", exts: ["zip", "7z", "rar"] },
};
const ORDER = Object.keys(KINDS) as Kind[];
const SHOW: Option<Kind>[] = ORDER.map((k) => ({ value: k, label: KINDS[k].label, icon: KINDS[k].icon }));

const kindOf = (name: string) => ORDER.find((k) => KINDS[k].exts.includes(extOf(name)));
const isMedia = (name: string) => isPhoto(name) || isVideo(name);
// The browser opens these in a tab; the rest download.
const opens = (name: string) => ["pdf", "txt", "md", "csv"].includes(extOf(name));
const ACCEPT = ORDER.flatMap((k) => KINDS[k].exts.map((e) => "." + e)).join(",");

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const when = (at: number) => new Date(at * 1000).toLocaleDateString([], { dateStyle: "medium" });
const dayOf = (at: number) => new Date(at * 1000).toLocaleDateString([], { dateStyle: "long" });
const monthOf = (at: number) => new Date(at * 1000).toLocaleDateString([], { month: "long", year: "numeric" });
// Months in order, the newest first.
const monthKey = (at: number) => {
  const d = new Date(at * 1000);
  return d.getFullYear() * 12 + d.getMonth();
};

// Items dragged within the page carry their paths under this type.
const MOVING = "application/x-moving";
const carries = (e: DragEvent, type: string) => Array.from(e.dataTransfer.types).includes(type);

// How many files are drawn at first, and added as the end of them comes near.
const CLUSTER = 120;

type Sort = "name" | "modified";
const SORTS: Option<Sort>[] = [{ value: "modified", label: "Last modified" }, { value: "name", label: "Name" }];

function remembered(): "grid" | "list" {
  try {
    return localStorage.getItem("drive.view") === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

// DrivePage is Storage: documents, photos and videos on this host, together in
// folders, the files grouped by month. Photos and videos are square tiles that
// open in a viewer and can be picked together; each other kind is a card in
// its own colour.
export function DrivePage({ convert, shares, tools, extra, onReload, title, onBack, plain }: StorageProps) {
  const can = useCan();
  const [path, setPath] = useState("");
  const [listing, setListing] = useState<Listing | null>(null);
  const [problem, setProblem] = useState("");
  // The kinds shown; none picked shows every kind.
  const [kinds, setKinds] = useState<Kind[]>([]);
  const [sort, setSort] = useState<Sort>("modified");
  const [view, setView] = useState(remembered);
  const [menu, setMenu] = useState<(Menu & { entry: FileEntry | null }) | null>(null);
  const [asking, setAsking] = useState<null | "folder" | { rename: FileEntry } | { remove: FileEntry[] }>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [viewing, setViewing] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  // The folder items are being dragged over.
  const [over, setOver] = useState<string | null>(null);
  const [drawn, setDrawn] = useState(CLUSTER);
  const input = useRef<HTMLInputElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const notify = useNotify();

  const load = useCallback(async () => {
    try {
      setListing(await files.list(path));
      setProblem("");
    } catch (e) {
      setProblem(message(e));
    }
  }, [path]);
  useEffect(() => {
    setListing(null);
    setDrawn(CLUSTER);
    setSelected(new Set());
    load();
    onReload(load);
  }, [load, onReload]);
  // A photo or video gets its preview once it is in.
  const { send, panel } = useUploads(load, async (item, at) => {
    if (!isMedia(item.file.name)) return;
    const jpeg = await makeThumb(item.file);
    if (jpeg) await saveThumb(at, jpeg).catch(() => {});
  });

  const entries = listing?.entries ?? [];
  const folders = entries.filter((e) => e.dir).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const docs = entries
    .filter((e) => !e.dir && kindOf(e.name) && (!kinds.length || kinds.includes(kindOf(e.name)!)))
    .sort((a, b) => monthKey(b.modified) - monthKey(a.modified)
      || (sort === "name" ? a.name.localeCompare(b.name, undefined, { numeric: true }) : b.modified - a.modified));
  const media = docs.filter((e) => isMedia(e.name));
  const months: [string, FileEntry[]][] = [];
  for (const e of docs.slice(0, drawn)) {
    const label = monthOf(e.modified);
    const last = months[months.length - 1];
    if (last && last[0] === label) last[1].push(e);
    else months.push([label, [e]]);
  }
  const toggle = (name: string) => {
    const next = new Set(selected);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setSelected(next);
  };
  const picked = [...selected].map((name) => join(path, name));
  const chosen = entries.filter((e) => selected.has(e.name));

  // An item drags the selection with it when it is in it, else only itself.
  const drag = (e: FileEntry) => ({
    draggable: can("drive.edit"),
    onDragStart: (ev: DragEvent) => {
      const names = selected.has(e.name) ? [...selected] : [e.name];
      ev.dataTransfer.setData(MOVING, JSON.stringify(names.map((n) => join(path, n))));
      ev.dataTransfer.effectAllowed = "move";
    },
    onDragEnd: () => setOver(null),
  });
  // A folder takes what is dropped on it.
  const target = (dir: string) => ({
    onDragOver: (ev: DragEvent) => {
      if (!carries(ev, MOVING)) return;
      ev.preventDefault();
      ev.stopPropagation();
      ev.dataTransfer.dropEffect = "move";
      setOver(dir);
    },
    onDragLeave: (ev: DragEvent) => !ev.currentTarget.contains(ev.relatedTarget as Node) && setOver(null),
    onDrop: (ev: DragEvent) => {
      if (!carries(ev, MOVING)) return;
      ev.preventDefault();
      ev.stopPropagation();
      setOver(null);
      const paths = (JSON.parse(ev.dataTransfer.getData(MOVING)) as string[]).filter((p) => p !== dir);
      if (!paths.length) return;
      const into = dir ? dir.split("/").pop() : "Storage";
      setSelected(new Set());
      run(() => files.move(paths, dir, false), paths.length === 1 ? `Moved ${paths[0].split("/").pop()} to ${into}` : `Moved ${paths.length} items to ${into}`);
    },
  });
  const rows = [...(kinds.length ? [] : folders), ...docs];

  // Files are drawn a cluster at a time, the next as the last comes into view.
  const more = drawn < (view === "grid" ? docs.length : rows.length);
  useEffect(() => {
    const el = end.current;
    if (!more || !el) return;
    const seen = new IntersectionObserver(([e]) => e.isIntersecting && setDrawn((n) => n + CLUSTER), { rootMargin: "800px" });
    seen.observe(el);
    return () => seen.disconnect();
  }, [more, drawn]);

  const start = (picked: Picked[]) => {
    const fit = picked.filter((p) => kindOf(p.file.name));
    if (fit.length < picked.length) {
      const n = picked.length - fit.length;
      notify(`Skipped ${n} file${n === 1 ? "" : "s"}: Storage keeps documents, spreadsheets, presentations, PDFs, archives, photos and videos`, "bad");
    }
    const here = new Set(entries.map((e) => e.name));
    const clash = fit.find((p) => here.has(p.rel));
    if (clash) notify(`${clash.rel} is already here, so it was skipped`, "bad");
    send(fit.filter((p) => !here.has(p.rel)).map((p) => ({ item: p, path: join(path, p.rel) })));
  };

  const open = (e: FileEntry) => {
    if (e.dir) return setPath(join(path, e.name));
    if (isMedia(e.name)) return setViewing(media.indexOf(e));
    if (opens(e.name)) window.open(fileUrl(join(path, e.name), true), "_blank", "noopener");
    else download(e);
  };
  const download = (e: FileEntry) => {
    const a = document.createElement("a");
    a.href = fileUrl(join(path, e.name), false);
    a.download = e.name;
    document.body.append(a);
    a.click();
    a.remove();
  };
  const run = async (work: () => Promise<unknown>, done: string) => {
    try {
      await work();
      notify(done);
    } catch (e) {
      notify(message(e), "bad");
    }
    await load();
  };

  const extract = async (e: FileEntry) => {
    notify(`Opening ${e.name}`);
    try {
      const { skipped } = await files.extract(join(path, e.name));
      notify(skipped ? `Opened ${e.name}; left out ${skipped} file${skipped === 1 ? "" : "s"} Storage does not keep` : `Opened ${e.name}`);
    } catch (err) {
      notify(message(err), "bad");
    }
    await load();
  };

  const contextMenu = (ev: PointerEvent, entry: FileEntry | null) => {
    if (!ownMenu(ev)) return;
    ev.preventDefault();
    ev.stopPropagation();
    // Shift and right-click adds the item to the selection, or takes it out.
    if (entry && ev.shiftKey) return toggle(entry.name);
    setMenu({ x: ev.clientX, y: ev.clientY, on: !!entry, entry });
  };
  const items = (entry: FileEntry | null): MenuItem[] => entry ? [
    { label: "Open", icon: entry.dir ? "folder" : isMedia(entry.name) ? "image" : opens(entry.name) ? "open_in_new" : "download", run: () => open(entry) },
    { label: "Download", icon: "download", hidden: entry.dir, run: () => download(entry) },
    { label: "Share link", icon: "link", hidden: plain, run: () => shares.open([join(path, entry.name)]) },
    { label: "Convert", icon: "swap_horiz", hidden: plain || entry.dir || !convertKind(entry.name) || !can("drive.edit"), run: () => convert.open([join(path, entry.name)]) },
    { label: "Remove background", icon: "content_cut", hidden: plain || entry.dir || !isPhoto(entry.name) || !can("drive.edit"), run: () => convert.cutout([join(path, entry.name)]) },
    { label: "Extract here", icon: "folder_zip", hidden: kindOf(entry.name) !== "archive" || !can("drive.edit"), run: () => extract(entry) },
    { label: "Compress to ZIP", icon: "folder_zip", hidden: !can("drive.edit"), run: () => run(() => files.compress([join(path, entry.name)]), `Packed ${entry.name}`) },
    { label: "Rename", icon: "edit", hidden: !can("drive.edit"), run: () => setAsking({ rename: entry }) },
    { label: selected.has(entry.name) ? "Unselect" : "Select", icon: "check_circle", run: () => toggle(entry.name) },
    { label: "Delete", icon: "delete", danger: true, hidden: !can("drive.delete"), run: () => setAsking({ remove: [entry] }) },
  ] : [
    { label: "New folder", icon: "create_new_folder", hidden: !can("drive.edit"), run: () => setAsking("folder") },
    { label: "Upload files", icon: "upload_file", hidden: !can("drive.edit"), run: () => input.current?.click() },
  ];

  const crumbs = path ? path.split("/") : [];
  const onDragOver = (e: DragEvent) => {
    if (!carries(e, "Files") || carries(e, MOVING)) return;
    e.preventDefault();
    setDragging(true);
  };

  return (
    <div className="drive" onContextMenu={(e) => contextMenu(e, null)} onDragOver={onDragOver}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDragging(false)}
      onDrop={async (e) => {
        if (carries(e, MOVING)) return;
        e.preventDefault();
        setDragging(false);
        start(await dropped(e.dataTransfer.items));
      }}>
      <div className="page-head">
        {onBack && <button type="button" className="icon-btn" aria-label="Back to Storage" title="Storage" onClick={onBack}><Icon name="arrow_back" /></button>}
        <div className="page-head-main">
          <h1>{title ?? "Storage"}</h1>
          {listing && (
            <div className="page-sub">
              <span><b>{docs.length}</b> file{docs.length === 1 ? "" : "s"} here</span>
              {listing.space && <span>{bytes(listing.space.free)} free</span>}
            </div>
          )}
        </div>
        <div className="page-actions">
          {selected.size > 0 ? (
            <>
              <span className="m-picked">{selected.size} selected</span>
              {chosen.some((e) => !e.dir) && <button type="button" className="icon-btn" aria-label="Download" title="Download" onClick={() => chosen.filter((e) => !e.dir).forEach(download)}><Icon name="download" /></button>}
              {!plain && <button type="button" className="icon-btn" aria-label="Share link" title="Share link" onClick={() => shares.open(picked)}><Icon name="link" /></button>}
              {!plain && can("drive.edit") && picked.every(convertKind) && <button type="button" className="icon-btn" aria-label="Convert" title="Convert" onClick={() => convert.open(picked)}><Icon name="swap_horiz" /></button>}
              {can("drive.delete") && <button type="button" className="icon-btn danger" aria-label="Delete" title="Delete" onClick={() => setAsking({ remove: chosen })}><Icon name="delete" /></button>}
              <button type="button" className="icon-btn" aria-label="Clear selection" title="Clear selection" onClick={() => setSelected(new Set())}><Icon name="close" /></button>
            </>
          ) : (
            <>
          <div className="ex-pick"><MultiDropdown label="Show" values={kinds} options={SHOW} allLabel="Every kind" onChange={setKinds} /></div>
          <div className="ex-pick"><Dropdown label="Sort by" value={sort} options={SORTS} onChange={setSort} /></div>
          {tools}
          <button type="button" className="icon-btn" aria-label={view === "grid" ? "List" : "Grid"} title={view === "grid" ? "List" : "Grid"} onClick={() => {
            const next = view === "grid" ? "list" : "grid";
            setView(next);
            try {
              localStorage.setItem("drive.view", next);
            } catch {
              // Kept until the page closes.
            }
          }}><Icon name={view === "grid" ? "view_list" : "grid_view"} /></button>
          {can("drive.edit") && <button type="button" className="btn primary" onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ x: r.left, y: r.bottom + 4, on: false, entry: null });
          }}><Icon name="add" size={18} />New</button>}
            </>
          )}
        </div>
      </div>
      {crumbs.length > 0 && (
        <div className="st-crumbs">
          {["Storage", ...crumbs].map((name, i) => (
            <span key={i} className="ex-crumb-wrap">
              {i > 0 && <Icon name="chevron_right" size={20} className="ex-crumb-sep" />}
              {i === crumbs.length ? <span className="d-crumb on">{name}</span> : (
                <button type="button" className={"d-crumb" + (over === crumbs.slice(0, i).join("/") ? " drop" : "")}
                  onClick={() => setPath(crumbs.slice(0, i).join("/"))} {...target(crumbs.slice(0, i).join("/"))}>{name}</button>
              )}
            </span>
          ))}
        </div>
      )}

      {problem && <Callout tone="bad" icon="error">{problem}</Callout>}
      {listing && (
        <div className="page-body">
          {folders.length === 0 && docs.length === 0 ? (
            <div className="card welcome">
              <Icon name="cloud" size={40} />
              <h2>{kinds.length ? "Nothing of those kinds here" : path ? "This folder is empty" : "Your files"}</h2>
              <p className="muted">Documents, photos and videos, kept on this host. Upload them, or drag them onto this page.</p>
              {can("drive.edit") && <button type="button" className="btn primary" onClick={() => input.current?.click()}><Icon name="upload_file" size={18} />Upload files</button>}
            </div>
          ) : view === "grid" ? (
            <>
              {folders.length > 0 && !kinds.length && (
                <section className="d-section">
                  <h2>Folders</h2>
                  <ul className="d-folders">
                    {folders.map((f) => (
                      <li key={f.name}>
                        <button type="button" className={"d-folder" + (selected.has(f.name) ? " on" : "") + (over === join(path, f.name) ? " drop" : "")}
                          onClick={() => open(f)} onContextMenu={(ev) => contextMenu(ev, f)} {...drag(f)} {...target(join(path, f.name))}>
                          <Icon name="folder" className="kind folder" /><span>{f.name}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {months.map(([label, list]) => {
                const pictures = list.filter((e) => isMedia(e.name));
                const cards = list.filter((e) => !isMedia(e.name));
                return (
                  <section key={label} className="m-month">
                    <h2>{label}</h2>
                    {pictures.length > 0 && (
                      <ul className="m-grid">
                        {pictures.map((e) => {
                          const on = selected.has(e.name);
                          return (
                            <li key={e.name} className={"m-tile" + (on ? " on" : "") + (selected.size ? " picking" : "")} onContextMenu={(ev) => contextMenu(ev, e)} {...drag(e)}>
                              <button type="button" className="m-open" title={`${e.name}\n${dayOf(e.modified)}`}
                                onClick={() => (selected.size ? toggle(e.name) : open(e))}>
                                <Thumb path={join(path, e.name)} />
                                {isVideo(e.name) && <Icon name="play_circle" size={22} className="m-badge" />}
                              </button>
                              <button type="button" className="m-check" aria-label={on ? `Unselect ${e.name}` : `Select ${e.name}`} aria-pressed={on} onClick={() => toggle(e.name)}>
                                <Icon name="check" size={16} />
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    {cards.length > 0 && (
                      <ul className="d-files">
                        {cards.map((d) => {
                          const k = kindOf(d.name)!;
                          return (
                            <li key={d.name}>
                              <button type="button" className={"d-file " + k + (selected.has(d.name) ? " on" : "")} onClick={() => open(d)} onContextMenu={(ev) => contextMenu(ev, d)}
                                title={`${d.name}\n${bytes(d.size)}`} {...drag(d)}>
                                <span className="d-cover"><Icon name={KINDS[k].icon} size={56} /><span className="d-ext">{extOf(d.name)}</span></span>
                                <span className="d-name"><Icon name={KINDS[k].icon} size={18} /><span>{d.name}</span></span>
                                <small>{when(d.modified)}</small>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </section>
                );
              })}
            </>
          ) : (
            <div className="card">
              <div className="table-wrap">
                <table className="table d-table">
                  <thead><tr><th className="grow">Name</th><th>Last modified</th><th>Size</th><th aria-label="Actions" /></tr></thead>
                  <tbody>
                    {rows.slice(0, drawn).map((e) => {
                      const k = kindOf(e.name);
                      return (
                        <tr key={e.name} className={(selected.has(e.name) ? "on" : "") + (over === join(path, e.name) ? " drop" : "")}
                          onDoubleClick={() => open(e)} onContextMenu={(ev) => contextMenu(ev, e)} {...drag(e)} {...(e.dir ? target(join(path, e.name)) : {})}>
                          <td>
                            <button type="button" className={"d-row-name " + (e.dir ? "" : k)} onClick={() => open(e)}>
                              <Icon name={e.dir ? "folder" : KINDS[k!].icon} className={e.dir ? "kind folder" : undefined} />
                              <span>{e.name}</span>
                            </button>
                          </td>
                          <td className="num">{when(e.modified)}</td>
                          <td className="num">{e.dir ? "" : bytes(e.size)}</td>
                          <td>
                            <button type="button" className="icon-btn small" aria-label={`More for ${e.name}`} title="More"
                              onClick={(ev) => {
                                ev.stopPropagation();
                                const r = ev.currentTarget.getBoundingClientRect();
                                setMenu({ x: r.left - 180, y: r.bottom + 4, on: true, entry: e });
                              }}>
                              <Icon name="more_vert" size={20} />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {more && <div ref={end} />}
        </div>
      )}

      {dragging && <div className="m-drop"><Icon name="cloud_upload" size={40} /><span>Drop files to upload to {crumbs[crumbs.length - 1] ?? "Storage"}</span></div>}
      <input ref={input} type="file" multiple hidden accept={ACCEPT} onChange={(e) => {
        if (e.target.files) start(Array.from(e.target.files, (file) => ({ file, rel: file.name })));
        e.target.value = "";
      }} />
      {menu && <ContextMenu at={menu} items={items(menu.entry)} onClose={() => setMenu(null)} />}
      {viewing !== null && media[viewing] && (
        <Viewer dir={path} items={media} at={viewing} onMove={setViewing} onClose={() => setViewing(null)}
          onDownload={(name) => download(media.find((e) => e.name === name)!)}
          onDelete={(name) => setAsking({ remove: [media.find((e) => e.name === name)!] })} />
      )}
      {asking === "folder" && (
        <NameDialog title="New folder" label="Folder name" initial="Untitled folder" action="Create" onClose={() => setAsking(null)}
          onSave={async (name) => {
            await files.folder(join(path, name));
            setAsking(null);
            await load();
          }} />
      )}
      {asking && typeof asking === "object" && "rename" in asking && (
        <NameDialog title="Rename" label="Name" initial={asking.rename.name} action="Rename" onClose={() => setAsking(null)}
          onSave={async (name) => {
            await files.rename(join(path, asking.rename.name), name);
            setAsking(null);
            await load();
          }} />
      )}
      {asking && typeof asking === "object" && "remove" in asking && (
        <Dialog title={asking.remove.length === 1 ? `Delete ${asking.remove[0].name}?` : `Delete ${asking.remove.length} items?`} onClose={() => setAsking(null)}>
          <p className="muted">{asking.remove.some((e) => e.dir) ? "The folder and everything in it are" : asking.remove.length === 1 ? "It is" : "They are"} removed from this host for good.</p>
          <div className="edit-actions">
            <button type="button" className="btn text" onClick={() => setAsking(null)}>Cancel</button>
            <button type="button" className="btn primary danger-fill" autoFocus onClick={() => {
              const targets = asking.remove;
              setAsking(null);
              setViewing(null);
              setSelected(new Set());
              run(() => files.remove(targets.map((e) => join(path, e.name))), targets.length === 1 ? `Deleted ${targets[0].name}` : `Deleted ${targets.length} items`);
            }}>Delete</button>
          </div>
        </Dialog>
      )}
      <div className="ex-dock">{convert.panel}{panel}</div>
      {extra}
    </div>
  );
}
