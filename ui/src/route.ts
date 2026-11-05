// Where the page is, kept in the URL hash: `#/` the tunnels, `#/new` publishing
// one, `#/tunnels/<id>/<page>` one tunnel; `#/devices` and `#/users`, with
// `/<id>/<page>` for one; `#/security/<tab>`; `#/settings/<section>` and
// `#/docs/<section>`; `#/dashboard`, the host and its containers;
// `#/git`, the repositories, `#/git/tokens`, and `#/git/r/<name>/<tab>/...`
// for one;
// `#/media` and `#/drive`; `#/convert`, with `/<space>/<path>` to start
// with that file picked; `#/containers`, with `/<id>/<page>` for one.

export type View = "tunnels" | "dashboard" | "containers" | "git" | "media" | "drive" | "convert" | "new" | "devices" | "users" | "security" | "settings" | "docs";

export interface Place {
  view: View;
  id: string;
  // A page within one tunnel, device or account.
  page: string;
  // Anything further down, such as a repository's tab and what is open in it.
  more: string[];
}

export function readHash(): Place {
  const [found = "", second = "", third = "", ...more] = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  // Git was called Code; Two-Factor Auth and Third-Party OAuth are tabs of
  // Advanced.
  if (found === "twofactor" || found === "oauth") return { view: "security", id: found, page: "", more: [] };
  const first = found === "code" ? "git" : found;
  if (first === "new" || first === "dashboard" || first === "media" || first === "drive") return { view: first, id: "", page: "", more: [] };
  if (first === "convert") return { view: first, id: second, page: third, more: [] };
  if (first === "devices" || first === "users" || first === "settings" || first === "docs" || first === "git" || first === "containers" || first === "security") return { view: first, id: second, page: third, more };
  return { view: "tunnels", id: first === "tunnels" ? second : "", page: third, more: [] };
}

export function go(hash: string) {
  location.hash = hash.replace(/^#/, "");
}
