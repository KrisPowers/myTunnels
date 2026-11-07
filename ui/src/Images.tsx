import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ago, api, bytes, message, type Image, type ImageDetail } from "./api";
import { Icon } from "./Icon";
import { useCan } from "./me";
import { go } from "./route";
import { Callout, Copy, MoreMenu, useNotify } from "./ui";

export const imageId = (id: string) => id.replace(/^sha256:/, "");
const shortId = (id: string) => imageId(id).slice(0, 12);
const nameOf = (i: { tags: string[]; id: string }) => i.tags[0] ?? `Untagged ${shortId(i.id)}`;

// The repository part of an image name, without its tag: `web` for `web:12`,
// `host:5000/app` for `host:5000/app:1`.
export function repoOf(name: string) {
  const at = name.lastIndexOf(":");
  return at > name.lastIndexOf("/") ? name.slice(0, at) : name;
}

// The images of one container: the one it runs and the others of the same
// repository, such as earlier builds and versions, newest first.
export function imagesOf(c: { id: string; image: string }, all: Image[]) {
  const current = all.find((i) => i.containers.some((u) => u.id === c.id));
  const repo = repoOf(current?.tags[0] ?? c.image);
  return {
    current,
    list: all
      .filter((i) => i === current || i.tags.some((t) => repoOf(t) === repo))
      .sort((a, b) => b.created - a.created),
  };
}

// Deletes images, says how it went, then reloads.
export function useImageRemoval(reload: () => Promise<void>) {
  const notify = useNotify();
  const [busy, setBusy] = useState(false);
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
    await reload();
  };
  return { busy, remove };
}

// ContainerImages is a row per image of one container: its tag, size and age,
// the one it runs marked. One nothing uses can be deleted; each opens for its
// details.
export function ContainerImages({ c, base }: { c: { id: string; image: string }; base: string }) {
  const [all, setAll] = useState<Image[] | null>(null);
  const [problem, setProblem] = useState("");
  const can = useCan();

  const load = useCallback(async () => {
    try {
      setAll(await api.images());
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
  const { busy, remove } = useImageRemoval(load);

  if (problem) return <Callout tone="bad" icon="error">Docker is not reachable: {problem}</Callout>;
  if (!all) return <div className="repo-loading"><span className="spinner" /></div>;
  const { current, list } = imagesOf(c, all);
  if (!list.length) {
    return <div className="card welcome"><Icon name="layers" size={40} /><h2>No images</h2><p className="muted">Its image is no longer kept here.</p></div>;
  }
  return (
    <div className="card">
      <div className="table-wrap">
        <table className="table img-table">
          <thead>
            <tr><th className="grow">Image</th><th>Size</th><th>Created</th><th aria-label="Actions" /></tr>
          </thead>
          <tbody>
            {list.map((i) => {
              const open = `${base}/${imageId(i.id)}`;
              return (
                <tr key={i.id} className={i.containers.length ? "" : "stopped"}>
                  <td>
                    <a className="ct-name" href={open}>
                      <Icon name="layers" size={20} />
                      <span className="ct-name-text">
                        <b>{nameOf(i)}{i === current && <span className="chip ok small-chip">Running</span>}</b>
                        <small className="mono">{shortId(i.id)}</small>
                      </span>
                    </a>
                  </td>
                  <td className="num">{bytes(i.size)}</td>
                  <td className="muted">{ago(i.created)}</td>
                  <td className="ct-menu">
                    {busy ? <span className="spinner small" /> : (
                      <MoreMenu label={`Actions for ${nameOf(i)}`} actions={[
                        { label: "Details", icon: "info", onClick: () => go(open) },
                        ...(can("containers.remove") && !i.containers.length ? [{ label: "Delete", icon: "delete" as const, danger: true, onClick: () => remove([i]), confirm: "Delete for good" }] : []),
                      ]} />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div className="kv"><span className="kv-label">{label}</span><span className="kv-value">{children}</span></div>;
}

const when = (iso: string) => {
  const t = Date.parse(iso);
  return t > 0 ? new Date(t).toLocaleString() : "Unknown";
};

// ImageView is one image: what it runs, its environment and labels, and the
// layers it was built from, newest first.
export function ImageView({ id, back }: { id: string; back: string }) {
  const [i, setI] = useState<ImageDetail | null>(null);
  const [problem, setProblem] = useState("");
  const notify = useNotify();
  const can = useCan();

  useEffect(() => {
    api.image(id).then(setI, (e) => setProblem(message(e)));
  }, [id]);

  if (!i) return problem ? <Callout tone="bad" icon="error">{problem}</Callout> : <div className="repo-loading"><span className="spinner" /></div>;
  const env = i.env.map((e) => e.split("=")).map(([k, ...v]) => [k, v.join("=")]);
  const labels = Object.entries(i.labels ?? {});
  const remove = async () => {
    try {
      await api.removeImage(i.id);
      notify(`Deleted ${nameOf(i)}`);
      go(back);
    } catch (e) {
      notify(message(e), "bad");
    }
  };

  return (
    <>
      <div className="img-head">
        <a className="icon-btn" href={back} aria-label="Images" title="Images"><Icon name="arrow_back" /></a>
        <h2>{nameOf(i)}</h2>
        <span className="ct-id"><span className="mono">{shortId(i.id)}</span><Copy text="" copyText={i.id} plain /></span>
        <span className="muted">{bytes(i.size)}, {i.platform}, made {when(i.created)}</span>
        <span className="ex-grow" />
        {can("containers.remove") && !i.containers.length && (
          <MoreMenu label={`Actions for ${nameOf(i)}`} actions={[{ label: "Delete", icon: "delete", danger: true, onClick: remove, confirm: "Delete for good" }]} />
        )}
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
