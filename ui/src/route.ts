// Where the page is, kept in the URL hash: `#/` the tunnels, `#/new` publishing
// one, `#/tunnels/<id>/<page>` one tunnel; `#/devices` and `#/users`, with
// `/<id>/<page>` for one; `#/oauth`, `#/twofactor`; `#/settings/<section>` and
// `#/docs/<section>`; `#/dashboard`, the host and its containers.

export type View = "tunnels" | "dashboard" | "new" | "devices" | "users" | "oauth" | "twofactor" | "settings" | "docs";

export interface Place {
  view: View;
  id: string;
  // A page within one tunnel, device or account.
  page: string;
}

export function readHash(): Place {
  const [first = "", second = "", third = ""] = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  if (first === "new" || first === "dashboard" || first === "oauth" || first === "twofactor") return { view: first, id: "", page: "" };
  if (first === "devices" || first === "users" || first === "settings" || first === "docs") return { view: first, id: second, page: third };
  return { view: "tunnels", id: first === "tunnels" ? second : "", page: third };
}

export function go(hash: string) {
  location.hash = hash.replace(/^#/, "");
}
