import { useCallback, useEffect, useRef, useState, type DragEvent, type MouseEvent as PointerEvent } from "react";
import { bytes, fileUrl, filesIn, message, type FileEntry, type Listing } from "./api";
import { Dropdown, type Option } from "./Dropdown";
import { ContextMenu, dropped, extOf, NameDialog, ownMenu, useUploads, type Menu, type MenuItem, type Picked } from "./Files";
import { Icon, type IconName } from "./Icon";
import { useCan } from "./me";
import { Callout, Dialog, useNotify } from "./ui";

const drive = filesIn("drive");

type Kind = "doc" | "sheet" | "slides" | "pdf" | "text";

const KINDS: Record<Kind, { label: string; icon: IconName; exts: string[] }> = {
  doc: { label: "Documents", icon: "article", exts: ["doc", "docx", "docm", "dot", "dotx", "odt", "rtf", "pages"] },
  sheet: { label: "Spreadsheets", icon: "table", exts: ["xls", "xlsx", "xlsm", "xlt", "xltx", "ods", "csv", "tsv", "numbers"] },
  slides: { label: "Presentations", icon: "slideshow", exts: ["ppt", "pptx", "pptm", "pps", "ppsx", "odp", "key"] },
  pdf: { label: "PDFs", icon: "picture_as_pdf", exts: ["pdf"] },
  text: { label: "Text", icon: "description", exts: ["txt", "md", "epub"] },
};
const ORDER = Object.keys(KINDS) as Kind[];

const kindOf = (name: string) => ORDER.find((k) => KINDS[k].exts.includes(extOf(name)));
// The browser opens these in a tab; the rest download.
const opens = (name: string) => ["pdf", "txt", "md", "csv"].includes(extOf(name));
const ACCEPT = ORDER.flatMap((k) => KINDS[k].exts.map((e) => "." + e)).join(",");

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const when = (at: number) => new Date(at * 1000).toLocaleDateString([], { dateStyle: "medium" });

type Sort = "name" | "modified";
const SORTS: Option<Sort>[] = [{ value: "modified", label: "Last modified" }, { value: "name", label: "Name" }];

function remembered(): "grid" | "list" {
  try {
    return localStorage.getItem("drive.view") === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

// DrivePage keeps documents, spreadsheets, presentations and PDFs on this
// host, in folders, each kind in its own colour.
export function DrivePage() {
  const can = useCan();
  const [path, setPath] = useState("");
  const [listing, setListing] = useState<Listing | null>(null);
  const [problem, setProblem] = useState("");
  const [kind, setKind] = useState<Kind | null>(null);
  const [sort, setSort] = useState<Sort>("modified");
  const [view, setView] = useState(remembered);
  const [menu, setMenu] = useState<(Menu & { entry: FileEntry | null }) | null>(null);
  const [asking, setAsking] = useState<null | "folder" | { rename: FileEntry } | { remove: FileEntry }>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const notify = useNotify();

  const load = useCallback(async () => {
    try {
      setListing(await drive.list(path));
      setProblem("");
    } catch (e) {
      setProblem(message(e));
    }
  }, [path]);
  useEffect(() => {
    setListing(null);
    load();
  }, [load]);
  const { send, panel } = useUploads("drive", load);

  const entries = listing?.entries ?? [];
  const folders = entries.filter((e) => e.dir).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const docs = entries
    .filter((e) => !e.dir && kindOf(e.name) && (!kind || kindOf(e.name) === kind))
    .sort((a, b) => (sort === "name" ? a.name.localeCompare(b.name, undefined, { numeric: true }) : b.modified - a.modified));

  const start = (picked: Picked[]) => {
    const fit = picked.filter((p) => kindOf(p.file.name));
    if (fit.length < picked.length) {
      const n = picked.length - fit.length;
      notify(`Skipped ${n} file${n === 1 ? "" : "s"}: Drive keeps documents, spreadsheets, presentations and PDFs`, "bad");
    }
    const here = new Set(entries.map((e) => e.name));
    const clash = fit.find((p) => here.has(p.rel));
    if (clash) notify(`${clash.rel} is already here, so it was skipped`, "bad");
    send(fit.filter((p) => !here.has(p.rel)).map((p) => ({ item: p, path: join(path, p.rel) })));
  };

  const open = (e: FileEntry) => {
    if (e.dir) return setPath(join(path, e.name));
    if (opens(e.name)) window.open(fileUrl(join(path, e.name), true, "drive"), "_blank", "noopener");
    else download(e);
  };
  const download = (e: FileEntry) => {
    const a = document.createElement("a");
    a.href = fileUrl(join(path, e.name), false, "drive");
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

  const contextMenu = (ev: PointerEvent, entry: FileEntry | null) => {
    if (!ownMenu(ev)) return;
    ev.preventDefault();
    ev.stopPropagation();
    setMenu({ x: ev.clientX, y: ev.clientY, on: !!entry, entry });
  };
  const items = (entry: FileEntry | null): MenuItem[] => entry ? [
    { label: "Open", icon: entry.dir ? "folder" : opens(entry.name) ? "open_in_new" : "download", run: () => open(entry) },
    { label: "Download", icon: "download", hidden: entry.dir, run: () => download(entry) },
    { label: "Rename", icon: "edit", hidden: !can("drive.edit"), run: () => setAsking({ rename: entry }) },
    { label: "Delete", icon: "delete", danger: true, hidden: !can("drive.delete"), run: () => setAsking({ remove: entry }) },
  ] : [
    { label: "New folder", icon: "create_new_folder", hidden: !can("drive.edit"), run: () => setAsking("folder") },
    { label: "Upload files", icon: "upload_file", hidden: !can("drive.edit"), run: () => input.current?.click() },
  ];

  const crumbs = path ? path.split("/") : [];
  const onDragOver = (e: DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    setDragging(true);
  };

  return (
    <div className="drive" onContextMenu={(e) => contextMenu(e, null)} onDragOver={onDragOver}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDragging(false)}
      onDrop={async (e) => {
        e.preventDefault();
        setDragging(false);
        start(await dropped(e.dataTransfer.items));
      }}>
      <div className="page-head">
        <div className="page-head-main">
          <h1 className="d-crumbs">
            {["Drive", ...crumbs].map((name, i) => (
              <span key={i} className="ex-crumb-wrap">
                {i > 0 && <Icon name="chevron_right" size={24} className="ex-crumb-sep" />}
                {i === crumbs.length ? <span className="d-crumb on">{name}</span> : (
                  <button type="button" className="d-crumb" onClick={() => setPath(crumbs.slice(0, i).join("/"))}>{name}</button>
                )}
              </span>
            ))}
          </h1>
          {listing && (
            <div className="page-sub">
              <span><b>{docs.length}</b> file{docs.length === 1 ? "" : "s"} here</span>
              {listing.space && <span>{bytes(listing.space.free)} free</span>}
            </div>
          )}
        </div>
        <div className="page-actions">
          <div className="ex-pick"><Dropdown label="Sort by" value={sort} options={SORTS} onChange={setSort} /></div>
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
        </div>
      </div>
      <div className="d-chips" role="group" aria-label="Type">
        {ORDER.map((k) => (
          <button key={k} type="button" className={"d-chip " + k + (kind === k ? " on" : "")} aria-pressed={kind === k} onClick={() => setKind(kind === k ? null : k)}>
            <Icon name={kind === k ? "check" : KINDS[k].icon} size={18} />{KINDS[k].label}
          </button>
        ))}
      </div>

      {problem && <Callout tone="bad" icon="error">{problem}</Callout>}
      {listing && (
        <div className="page-body">
          {folders.length === 0 && docs.length === 0 ? (
            <div className="card welcome">
              <Icon name="cloud" size={40} />
              <h2>{kind ? `No ${KINDS[kind].label.toLowerCase()} here` : path ? "This folder is empty" : "Your documents"}</h2>
              <p className="muted">Word documents, spreadsheets, presentations and PDFs, kept on this host. Upload them, or drag them onto this page.</p>
              {can("drive.edit") && <button type="button" className="btn primary" onClick={() => input.current?.click()}><Icon name="upload_file" size={18} />Upload files</button>}
            </div>
          ) : view === "grid" ? (
            <>
              {folders.length > 0 && !kind && (
                <section className="d-section">
                  <h2>Folders</h2>
                  <ul className="d-folders">
                    {folders.map((f) => (
                      <li key={f.name}>
                        <button type="button" className="d-folder" onClick={() => open(f)} onContextMenu={(ev) => contextMenu(ev, f)}>
                          <Icon name="folder" className="kind folder" /><span>{f.name}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {docs.length > 0 && (
                <section className="d-section">
                  <h2>Files</h2>
                  <ul className="d-files">
                    {docs.map((d) => {
                      const k = kindOf(d.name)!;
                      return (
                        <li key={d.name}>
                          <button type="button" className={"d-file " + k} onClick={() => open(d)} onContextMenu={(ev) => contextMenu(ev, d)} title={`${d.name}\n${bytes(d.size)}`}>
                            <span className="d-cover"><Icon name={KINDS[k].icon} size={56} /><span className="d-ext">{extOf(d.name)}</span></span>
                            <span className="d-name"><Icon name={KINDS[k].icon} size={18} /><span>{d.name}</span></span>
                            <small>{when(d.modified)}</small>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}
            </>
          ) : (
            <div className="card">
              <div className="table-wrap">
                <table className="table d-table">
                  <thead><tr><th className="grow">Name</th><th>Last modified</th><th>Size</th><th aria-label="Actions" /></tr></thead>
                  <tbody>
                    {[...(kind ? [] : folders), ...docs].map((e) => {
                      const k = kindOf(e.name);
                      return (
                        <tr key={e.name} onDoubleClick={() => open(e)} onContextMenu={(ev) => contextMenu(ev, e)}>
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
        </div>
      )}

      {dragging && <div className="m-drop"><Icon name="cloud_upload" size={40} /><span>Drop files to upload to {crumbs[crumbs.length - 1] ?? "My Drive"}</span></div>}
      <input ref={input} type="file" multiple hidden accept={ACCEPT} onChange={(e) => {
        if (e.target.files) start(Array.from(e.target.files, (file) => ({ file, rel: file.name })));
        e.target.value = "";
      }} />
      {menu && <ContextMenu at={menu} items={items(menu.entry)} onClose={() => setMenu(null)} />}
      {asking === "folder" && (
        <NameDialog title="New folder" label="Folder name" initial="Untitled folder" action="Create" onClose={() => setAsking(null)}
          onSave={async (name) => {
            await drive.folder(join(path, name));
            setAsking(null);
            await load();
          }} />
      )}
      {asking && typeof asking === "object" && "rename" in asking && (
        <NameDialog title="Rename" label="Name" initial={asking.rename.name} action="Rename" onClose={() => setAsking(null)}
          onSave={async (name) => {
            await drive.rename(join(path, asking.rename.name), name);
            setAsking(null);
            await load();
          }} />
      )}
      {asking && typeof asking === "object" && "remove" in asking && (
        <Dialog title={`Delete ${asking.remove.name}?`} onClose={() => setAsking(null)}>
          <p className="muted">{asking.remove.dir ? "The folder and everything in it are" : "It is"} removed from this host for good.</p>
          <div className="edit-actions">
            <button type="button" className="btn text" onClick={() => setAsking(null)}>Cancel</button>
            <button type="button" className="btn primary danger-fill" autoFocus onClick={() => {
              const target = asking.remove;
              setAsking(null);
              run(() => drive.remove([join(path, target.name)]), `Deleted ${target.name}`);
            }}>Delete</button>
          </div>
        </Dialog>
      )}
      {panel}
    </div>
  );
}
