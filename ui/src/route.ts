// Where the page is, kept in the URL hash: `#/` home, the Dashboard;
// `#/console`, the Dashboard alone on the whole screen; `#/containers`, with
// `/<name>/<page>/...` for one container; `#/routes`, every way in, with
// `#/routes/new` (`/<port>`) adding one, and `#/tunnels/<id>` one tunnel;
// `#/storage`; `#/mail`, every address; `#/security/<tab>`, whose Users and
// Devices tabs are also `#/users` and `#/devices` (`/<id>/<page>` for one);
// `#/apps`; `#/settings/<section>`; `#/docs/<section>`. Older addresses
// (`#/forward`, `#/remote`, `#/new`, `#/services`, `#/domains`, `#/hardware`,
// `#/images`, `#/media`, `#/drive`) go where their page went.

export type View = "console" | "tunnels" | "dashboard" | "apps" | "containers" | "routes" | "storage" | "mail" | "devices" | "users" | "security" | "settings" | "docs";

export interface Place {
  view: View;
  id: string;
  // A page within one tunnel, device or account.
  page: string;
  // Anything further down, such as a container's page and what is open in it.
  more: string[];
  // The address was empty, so the page is home, whichever that is.
  home?: boolean;
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
  // Cloudflare and its connector are Settings' Connections now.
  if (first === "settings" && (second === "cloudflare" || second === "connector")) return { view: "settings", id: "connections", page: "", more: [] };
  if (first === "dashboard" || first === "apps" || first === "console") return { view: first, id: "", page: "", more: [] };
  // Hardware became part of the Dashboard.
  if (first === "hardware") return { view: "dashboard", id: "", page: "", more: [] };
  // Adding a tunnel became adding a route.
  if (first === "new") return { view: "routes", id: "", page: "new", more: [second] };
  // Forward, then Remote Access, became Routes.
  if (first === "routes" || first === "remote" || first === "forward") {
    return { view: "routes", id: "", page: second === "new" ? "new" : "", more: [third] };
  }
  // Media, Drive and Convert became Storage, one page, and its Convert action.
  if (first === "media" || first === "drive" || first === "convert" || first === "storage") return { view: "storage", id: "", page: "", more: [] };
  // Images became each container's Images page.
  if (first === "images") return { view: "containers", id: "", page: "", more: [] };
  // Mail is its own page; Domains, once a page, went into it.
  if (first === "mail" || first === "domains") return { view: "mail", id: "", page: "", more: [] };
  // Services was Containers' name for a while.
  if (first === "services") return { view: "containers", id: "", page: "", more: [] };
  if (first === "devices" || first === "users" || first === "settings" || first === "docs" || first === "containers" || first === "security") return { view: first, id: second, page: third, more };
  // One tunnel has a page of its own; the list of them is Containers'.
  if (first === "tunnels" && second) return { view: "tunnels", id: second, page: third, more: [] };
  return { view: "containers", id: "", page: "", more: [], home: !first };
}

export function go(hash: string) {
  location.hash = hash.replace(/^#/, "");
}
