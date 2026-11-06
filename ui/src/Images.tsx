import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ago, api, bytes, message, type Image, type ImageDetail, type ImageUser } from "./api";
import { Icon } from "./Icon";
import { useCan } from "./me";
import { go } from "./route";
import { ArmedButton, Callout, Copy, MoreMenu, useNotify } from "./ui";

const shortId = (id: string) => id.replace(/^sha256:/, "").slice(0, 12);
const nameOf = (i: { tags: string[]; id: string }) => i.tags[0] ?? `Untagged ${shortId(i.id)}`;

type Show = "all" | "used" | "unused";

export function ImagesPage({ id }: { id: string }) {
  return id ? <ImagePage id={id} /> : <ImageList />;
}

// UsedBy links to each container built from an image.
function UsedBy({ list }: { list: ImageUser[] }) {
  if (!list.length) return <span className="muted">Unused</span>;
  return (
    <span className="port-links">
      {list.map((c) => (
        <a key={c.id} href={`#/containers/${c.id}`} title={c.state}>
          <span className={"dot " + (c.state === "running" ? "ok" : "")} />{c.name}
        </a>
      ))}
    </span>
  );
}

// ImageList is a row per image the engine keeps: its tags, the containers
// using it, its size and age. One nothing uses can be deleted.
function ImageList() {
  const [list, setList] = useState<Image[] | null>(null);
  const [problem, setProblem] = useState("");
  const [q, setQ] = useState("");
  const [show, setShow] = useState<Show>("all");
  const [busy, setBusy] = useState(false);
  const notify = useNotify();
  const can = useCan();

  const load = useCallback(async () => {
    try {
      setList(await api.images());
      setProblem("");
    } catch (e) {
      setProblem(message(e));
    }
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);

  const remove = async (targets: Image[]) => {
    setBusy(true);
    const failed: string[] = [];
    for (const i of targets) {
      try {
        await api.removeImage(i.id);
      } catch (e) {
        failed.push(`${nameOf(i)}: ${message(e)}`);
      }
    }
    setBusy(false);
    if (failed.length) notify(failed.join("; "), "bad");
    else notify(targets.length === 1 ? `Deleted ${nameOf(targets[0])}` : `Deleted ${targets.length} images`);
    await load();
  };

  const needle = q.trim().toLowerCase();
  const unused = (list ?? []).filter((i) => !i.containers.length);
  const shown = (list ?? [])
    .filter((i) => show === "all" || (show === "used") === i.containers.length > 0)
    .filter((i) => !needle || [i.id, ...i.tags, ...i.containers.map((c) => c.name)].some((v) => v.toLowerCase().includes(needle)))
    .sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  const total = (list ?? []).reduce((n, i) => n + i.size, 0);
  const spare = unused.reduce((n, i) => n + i.size, 0);
  const deletes = can("containers.remove");

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>Images</h1>
          {list && (
            <div className="page-sub">
              <span><b>{list.length}</b> image{list.length === 1 ? "" : "s"}, {bytes(total)}</span>
              <span><b>{unused.length}</b> unused, {bytes(spare)}</span>
            </div>
          )}
        </div>
        <div className="page-actions">
          <label className="ct-search">
            <Icon name="search" size={18} />
            <input type="search" placeholder="Search" aria-label="Search images" value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} />
          </label>
          <div className="seg-tabs" role="tablist" aria-label="Show">
            {(["all", "used", "unused"] as Show[]).map((k) => (
              <button key={k} type="button" role="tab" aria-selected={show === k} className={show === k ? "on" : ""} onClick={() => setShow(k)}>
                {k === "all" ? "All" : k === "used" ? "In use" : "Unused"}
              </button>
            ))}
          </div>
          <button type="button" className="icon-btn" aria-label="Refresh" title="Refresh" onClick={load}><Icon name="refresh" /></button>
          {busy && <span className="spinner small" />}
          {deletes && unused.length > 0 && !busy && (
            <ArmedButton icon="delete" label="Delete unused" armedLabel={`Delete ${unused.length} for good`} onConfirm={() => remove(unused)} />
          )}
        </div>
      </div>
      {problem && <Callout tone="bad" icon="error">Docker is not reachable: {problem}</Callout>}

      {list && (list.length === 0 ? (
        <div className="card welcome">
          <Icon name="layers" size={40} />
          <h2>No images</h2>
          <p className="muted">Images built or pulled on this host show here.</p>
        </div>
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table className="table ct-table">
              <thead>
                <tr><th className="grow">Image</th><th>Used by</th><th>Size</th><th>Created</th><th aria-label="Actions" /></tr>
              </thead>
              <tbody>
                {shown.map((i) => (
                  <tr key={i.id} className={i.containers.length ? "" : "stopped"}>
                    <td>
                      <a className="ct-name" href={`#/images/${i.id.replace(/^sha256:/, "")}`}>
                        <Icon name="layers" size={20} />
                        <span className="ct-name-text">
                          <b>{nameOf(i)}</b>
                          <small className="mono">{i.tags.length > 1 ? `${shortId(i.id)}, also ${i.tags.slice(1).join(", ")}` : shortId(i.id)}</small>
                        </span>
                      </a>
                    </td>
                    <td><UsedBy list={i.containers} /></td>
                    <td className="num">{bytes(i.size)}</td>
                    <td className="muted">{ago(i.created)}</td>
                    <td className="ct-menu">
                      <MoreMenu label={`Actions for ${nameOf(i)}`} actions={[
                        { label: "Details", icon: "info", onClick: () => go(`#/images/${i.id.replace(/^sha256:/, "")}`) },
                        ...(deletes && !i.containers.length ? [{ label: "Delete", icon: "delete" as const, danger: true, onClick: () => remove([i]), confirm: "Delete for good" }] : []),
                      ]} />
                    </td>
                  </tr>
                ))}
                {shown.length === 0 && <tr><td colSpan={5} className="empty-note ct-none">No images match.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div className="kv"><span className="kv-label">{label}</span><span className="kv-value">{children}</span></div>;
}

const when = (iso: string) => {
  const t = Date.parse(iso);
  return t > 0 ? new Date(t).toLocaleString() : "Unknown";
};

// ImagePage is one image: what it runs, the containers using it, and the
// layers it was built from, newest first.
function ImagePage({ id }: { id: string }) {
  const [i, setI] = useState<ImageDetail | null>(null);
  const [problem, setProblem] = useState("");
  const notify = useNotify();
  const can = useCan();

  useEffect(() => {
    api.image(id).then(setI, (e) => setProblem(message(e)));
  }, [id]);

  const remove = async () => {
    if (!i) return;
    try {
      await api.removeImage(i.id);
      notify(`Deleted ${nameOf(i)}`);
      go("#/images");
    } catch (e) {
      notify(message(e), "bad");
    }
  };

  const crumbs = (
    <h1 className="d-crumbs">
      <span className="ex-crumb-wrap"><a className="d-crumb" href="#/images">Images</a></span>
      {i && <span className="ex-crumb-wrap"><Icon name="chevron_right" size={24} className="ex-crumb-sep" /><span className="d-crumb on">{nameOf(i)}</span></span>}
    </h1>
  );
  if (!i) {
    return (
      <>
        <div className="page-head"><div className="page-head-main">{crumbs}</div></div>
        {problem ? <Callout tone="bad" icon="error">{problem}</Callout> : <div className="repo-loading"><span className="spinner" /></div>}
      </>
    );
  }
  const env = i.env.map((e) => e.split("=")).map(([k, ...v]) => [k, v.join("=")]);
  const labels = Object.entries(i.labels ?? {});

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          {crumbs}
          <div className="page-sub">
            <span className="ct-id"><span className="mono">{shortId(i.id)}</span><Copy text="" copyText={i.id} plain /></span>
            <span>{bytes(i.size)}</span>
            <span>{i.platform}</span>
            <span>Created {when(i.created)}</span>
          </div>
        </div>
        <div className="page-actions">
          {can("containers.remove") && !i.containers.length && (
            <ArmedButton icon="delete" label="Delete" armedLabel="Delete for good" onConfirm={remove} />
          )}
        </div>
      </div>
      <div className="ct-inspect">
        <section className="card ct-panel">
          <h2>Overview</h2>
          <Fact label="Tags">{i.tags.length ? <span className="mono">{i.tags.join(", ")}</span> : "None"}</Fact>
          {i.digests.length > 0 && <Fact label="Digest"><span className="mono">{i.digests[0]}</span></Fact>}
          <Fact label="Entrypoint"><span className="mono">{i.entrypoint.join(" ") || "None"}</span></Fact>
          <Fact label="Command"><span className="mono">{i.command.join(" ") || "None"}</span></Fact>
          <Fact label="Working folder"><span className="mono">{i.workdir || "/"}</span></Fact>
          <Fact label="User"><span className="mono">{i.user || "root"}</span></Fact>
          <Fact label="Ports"><span className="mono">{i.ports.join(", ") || "None"}</span></Fact>
        </section>
        <section className="card ct-panel">
          <h2>Used by</h2>
          {i.containers.length ? <UsedBy list={i.containers} /> : <p className="empty-note">No container uses this image.</p>}
        </section>
        <section className="card ct-panel">
          <h2>Environment</h2>
          {env.length ? (
            <table className="table">
              <thead><tr><th>Name</th><th className="grow">Value</th></tr></thead>
              <tbody>{env.map(([k, v]) => <tr key={k}><td className="mono">{k}</td><td className="mono">{v}</td></tr>)}</tbody>
            </table>
          ) : <p className="empty-note">None set.</p>}
        </section>
        <section className="card ct-panel">
          <h2>Labels</h2>
          {labels.length ? (
            <table className="table">
              <thead><tr><th>Label</th><th className="grow">Value</th></tr></thead>
              <tbody>{labels.map(([k, v]) => <tr key={k}><td className="mono">{k}</td><td className="mono">{v}</td></tr>)}</tbody>
            </table>
          ) : <p className="empty-note">None set.</p>}
        </section>
      </div>
      <section className="card ct-panel">
        <h2>Layers</h2>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th className="grow">Step</th><th>Size</th><th>Created</th></tr></thead>
            <tbody>
              {i.layers.map((l, n) => (
                <tr key={n}>
                  <td className="mono img-step">{l.command || <span className="muted">None</span>}</td>
                  <td className="num">{l.size ? bytes(l.size) : "0 B"}</td>
                  <td className="muted">{ago(l.created)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
