// Dev mode: the whole app on http://localhost:7070, live as you save.
//
//   node scripts/dev.mjs
//
// Server: a change under server/ is rebuilt incrementally and the new build
// swapped in while the old one keeps serving, then every open page reloads.
// UI: served with hot reload, so a change shows without a reload at all.
// Tunnel: cloudflared runs under the server as it does in the container.
// Data lives in server/data, apart from the container's volume.

import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverDir = join(root, "server");
const uiDir = join(root, "ui");
const work = join(tmpdir(), "mytunnels");
const target = join(work, "target");
const reloadFile = join(work, "reload");
const windows = process.platform === "win32";
const exe = windows ? ".exe" : "";

mkdirSync(work, { recursive: true });
writeFileSync(reloadFile, String(Date.now()));

const log = (text) => console.log(`\x1b[36m[dev]\x1b[0m ${text}`);

function which(name) {
  const found = spawnSync(windows ? "where" : "which", [name], { encoding: "utf8" });
  return found.status === 0 ? found.stdout.split(/\r?\n/)[0].trim() : null;
}

async function cloudflared() {
  const installed = which("cloudflared");
  if (installed) return installed;
  const file = join(work, "cloudflared" + exe);
  if (existsSync(file)) return file;
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const asset = windows ? `cloudflared-windows-${arch}.exe` : process.platform === "linux" ? `cloudflared-linux-${arch}` : null;
  if (!asset) {
    log("install cloudflared to run the tunnel (brew install cloudflared)");
    return "cloudflared";
  }
  log(`fetching ${asset}`);
  const res = await fetch(`https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`);
  if (!res.ok) throw new Error(`cloudflared download failed: ${res.status}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()), { mode: 0o755 });
  return file;
}

const env = {
  ...process.env,
  CARGO_TARGET_DIR: target,
  DATA_DIR: join(serverDir, "data"),
  ADMIN_ADDR: "127.0.0.1:7071",
  GATE_ADDR: "127.0.0.1:7080",
  UPSTREAM_HOST: "127.0.0.1",
  CLOUDFLARED_BIN: await cloudflared(),
};

// ---- the server: build, swap in, reload pages ----

// rmSync with force ignores files that are gone, but not ones still locked.
const tidy = (fn) => (...args) => {
  try {
    fn(...args);
  } catch {
    // Still in use; the next sweep gets it.
  }
};

let running = null;
let slot = 0;
let building = false;
let queued = false;

function stop(child) {
  if (!child || child.exitCode !== null) return;
  // The whole tree, so cloudflared goes with it.
  if (windows) spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
  else process.kill(-child.pid, "SIGTERM");
}

function start() {
  // Runs a copy under a new name each time, so the next build can replace the
  // binary while this one serves, and no copy ever lands on a file Windows
  // still holds open.
  const copy = join(work, `server-${Date.now()}-${++slot}${exe}`);
  try {
    copyFileSync(join(target, "debug", "server" + exe), copy);
  } catch (err) {
    log(`could not stage the new server (${err.code ?? err.message}), keeping the last one`);
    return false;
  }
  const previous = running;
  stop(previous);
  running = spawn(copy, [], { cwd: serverDir, env, stdio: "inherit", detached: !windows });
  if (previous) setTimeout(() => sweep(copy), 2000);
  return true;
}

// sweep removes copies of earlier builds once they are no longer running.
function sweep(keep) {
  for (const name of readdirSync(work)) {
    const file = join(work, name);
    if (name.startsWith("server-") && file !== keep) tidy(rmSync)(file, { force: true });
  }
}

function build(reason) {
  if (building) {
    queued = true;
    return;
  }
  building = true;
  const began = Date.now();
  if (reason) log(`${reason}, rebuilding the server`);
  const cargo = spawn("cargo", ["build", "--quiet"], { cwd: serverDir, env, stdio: "inherit" });
  cargo.on("exit", (code) => {
    building = false;
    if (code === 0) {
      if (start()) {
        setTimeout(() => writeFileSync(reloadFile, String(Date.now())), 300);
        log(`server live in ${((Date.now() - began) / 1000).toFixed(1)} s`);
      }
    } else {
      log("build failed, the last good server keeps running");
    }
    if (queued) {
      queued = false;
      build("more changes");
    }
  });
}

let pending = null;
const onChange = (_event, file) => {
  if (!file || /(^|[\\/])(target|data)([\\/]|$)/.test(file)) return;
  clearTimeout(pending);
  pending = setTimeout(() => build(`${file} changed`), 120);
};
watch(join(serverDir, "src"), { recursive: true }, onChange);
watch(serverDir, (event, file) => file === "Cargo.toml" && onChange(event, file));

// ---- the UI: hot reload, with /api passed to the server ----

if (!existsSync(join(uiDir, "node_modules"))) {
  log("installing UI packages");
  spawnSync(windows ? "npm.cmd" : "npm", ["install", "--no-audit", "--no-fund"], { cwd: uiDir, stdio: "inherit", shell: windows });
}
const ui = spawn(process.execPath, [join(uiDir, "node_modules", "vite", "bin", "vite.js"), "--port", "7070", "--strictPort"], {
  cwd: uiDir,
  env: { ...process.env, API_TARGET: "http://127.0.0.1:7071", DEV_RELOAD_FILE: reloadFile },
  stdio: "inherit",
});

const quit = () => {
  stop(running);
  ui.kill();
  process.exit(0);
};
process.on("SIGINT", quit);
process.on("SIGTERM", quit);

log("first build of the server, later ones only rebuild what changed");
build();
