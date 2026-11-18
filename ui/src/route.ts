// Where the page is, kept in the URL hash: `#/console`, this computer at a
// glance in one still frame, which the desktop app opens; `#/` Services, every container
// and every route to a port on this computer, with `#/routes/new` adding a
// route (`#/routes/new/<port>` to that port; `#/routes`, `#/new`, `#/forward`
// and `#/remote` now go to Services), `#/tunnels/<id>/<page>` one tunnel; `#/security/<tab>`, Security,
// whose Users and Devices tabs are also `#/users` and `#/devices`, with
// `/<id>/<page>` for one of them; `#/apps`, the apps catalog;
// `#/settings/<section>`, Preferences among them; and
// `#/docs/<section>`; `#/dashboard`, the host and its containers, where `#/hardware` now goes;
// `#/storage`, documents, photos and videos together; `#/mail/<tab>`, every
// domain's addresses, mail's activity and its settings; `#/domains/<name>/<tab>`,
// the domains, each with its services, DNS and redirects; `#/containers`,
// with `/<name>/<page>/...` for one, its tunnel and images among its pages.

export type View = "console" | "tunnels" | "dashboard" | "apps" | "containers" | "storage" | "mail" | "domains" | "devices" | "users" | "security" | "settings" | "docs";

export interface Place {
  view: View;
  id: string;
  // A page within one tunnel, device or account.
  page: string;
  // Anything further down, such as a container's page and what is open in it.
  more: string[];
}

export function readHash(): Place {
  const [found = "", second = "", third = "", ...more] = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  // Two-Factor Auth and Third-Party OAuth are tabs of Security.
  if (found === "twofactor" || found === "oauth") return { view: "security", id: found, page: "", more: [] };
  const first = found;
  // Users and Devices are tabs of Security.
  if ((first === "users" || first === "devices") && !second) return { view: "security", id: first, page: "", more: [] };
  // Appearance, then a Preferences page of its own, are Settings' Preferences now.
  if ((first === "settings" && second === "appearance") || first === "preferences") return { view: "settings", id: "preferences", page: "", more: [] };
  if (first === "dashboard" || first === "apps" || first === "console") return { view: first, id: "", page: "", more: [] };
  // Hardware became part of the Dashboard.
  if (first === "hardware") return { view: "dashboard", id: "", page: "", more: [] };
  // Adding a tunnel became adding a route, on Services.
  if (first === "new") return { view: "containers", id: "", page: "new", more: [second] };
  // Forward, then Remote Access, then Routes became part of Services.
  if (first === "routes" || first === "remote" || first === "forward") {
    return { view: "containers", id: "", page: second === "new" ? "new" : "", more: [third] };
  }
  // Media, Drive and Convert became Storage, one page, and its Convert action.
  if (first === "media" || first === "drive" || first === "convert" || first === "storage") return { view: "storage", id: "", page: "", more: [] };
  // Images became each container's Images page.
  if (first === "images") return { view: "containers", id: "", page: "", more: [] };
  // Mail is its own page again, with every domain's addresses.
  if (first === "mail") return { view: "mail", id: second, page: "", more: [] };
  if (first === "domains") return { view: "domains", id: second, page: third, more: [] };
  if (first === "devices" || first === "users" || first === "settings" || first === "docs" || first === "containers" || first === "security") return { view: first, id: second, page: third, more };
  // One tunnel has a page of its own; the list of them is Containers'.
  if (first === "tunnels" && second) return { view: "tunnels", id: second, page: third, more: [] };
  return { view: "containers", id: "", page: "", more: [] };
}

export function go(hash: string) {
  location.hash = hash.replace(/^#/, "");
}
