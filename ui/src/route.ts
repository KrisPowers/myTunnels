// Where the page is, kept in the URL hash: `#/` the tunnels, `#/new` publishing
// one, `#/tunnels/<id>` one tunnel; `#/devices` and `#/users`, with `/<id>` for
// one; `#/settings/<section>` and `#/docs/<section>`.

export type View = "tunnels" | "new" | "devices" | "users" | "settings" | "docs";

export interface Place {
  view: View;
  id: string;
}

export function readHash(): Place {
  const [first = "", second = ""] = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  if (first === "new") return { view: "new", id: "" };
  if (first === "devices" || first === "users" || first === "settings" || first === "docs") return { view: first, id: second };
  return { view: "tunnels", id: first === "tunnels" ? second : "" };
}

export function go(hash: string) {
  location.hash = hash.replace(/^#/, "");
}
