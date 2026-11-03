// Where the page is, kept in the URL hash: `#/` the tunnels, `#/tunnels/<id>`
// one tunnel, `#/devices` and `#/devices/<id>`, `#/settings/<section>`.

export interface Place {
  view: "tunnels" | "devices" | "settings";
  id: string;
}

export function readHash(): Place {
  const [first = "", second = ""] = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  if (first === "devices" || first === "settings") return { view: first, id: second };
  return { view: "tunnels", id: first === "tunnels" ? second : "" };
}

export function go(hash: string) {
  location.hash = hash.replace(/^#/, "");
}
