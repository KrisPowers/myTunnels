// Where the page is, kept in the URL hash: `#/` the containers and tunnels,
// `#/new` publishing a tunnel (`#/new/<port>` to that port),
// `#/tunnels/<id>/<page>` one tunnel; `#/security/<tab>`, Security & Roles,
// whose Users and Devices tabs are also `#/users` and `#/devices`, with
// `/<id>/<page>` for one of them; `#/apps`, the add-on catalog; `#/controller`, Device Controller;
// `#/settings/<section>`; `#/preferences`, how the dashboard looks; and
// `#/docs/<section>`; `#/dashboard`, the host and its containers;
// `#/git`, the repositories, `#/git/tokens`, and `#/git/r/<name>/<tab>/...`
// for one;
// `#/storage`, photos and videos, and `#/storage/files`; `#/containers`,
// with `/<name>/<page>/...` for one, its tunnel and images among its pages.

export type View = "tunnels" | "dashboard" | "apps" | "controller" | "containers" | "git" | "storage" | "new" | "devices" | "users" | "security" | "settings" | "preferences" | "docs";

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
  // Users and Devices are tabs of Security & Roles.
  if ((first === "users" || first === "devices") && !second) return { view: "security", id: first, page: "", more: [] };
  // Appearance was a section of Settings; it is Preferences now.
  if (first === "settings" && second === "appearance") return { view: "preferences", id: "", page: "", more: [] };
  if (first === "dashboard" || first === "apps" || first === "controller" || first === "preferences") return { view: first, id: "", page: "", more: [] };
  // `#/new/<port>` starts a tunnel to that port.
  if (first === "new") return { view: first, id: second, page: "", more: [] };
  // Media, Drive and Convert became Storage's tabs and its Convert action.
  if (first === "media" || first === "convert") return { view: "storage", id: "", page: "", more: [] };
  if (first === "drive") return { view: "storage", id: "files", page: "", more: [] };
  if (first === "storage") return { view: first, id: second, page: "", more: [] };
  // Images became each container's Images page.
  if (first === "images") return { view: "containers", id: "", page: "", more: [] };
  if (first === "devices" || first === "users" || first === "settings" || first === "docs" || first === "git" || first === "containers" || first === "security") return { view: first, id: second, page: third, more };
  // One tunnel has a page of its own; the list of them is Containers'.
  if (first === "tunnels" && second) return { view: "tunnels", id: second, page: third, more: [] };
  return { view: "containers", id: "", page: "", more: [] };
}

export function go(hash: string) {
  location.hash = hash.replace(/^#/, "");
}
