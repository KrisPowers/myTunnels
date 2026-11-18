// Serves the install script at a short address, krispowers.dev/mytunnels:
// PowerShell gets install.ps1, anything else (curl, wget) install.sh.
// scripts/worker.ps1 deploys it, writing both scripts in where PS1 and SH
// stand, so the address always serves what was deployed last.
const PS1 = "__PS1__";
const SH = "__SH__";

export default {
  fetch(request) {
    const windows = /PowerShell/i.test(request.headers.get("user-agent") ?? "");
    return new Response(windows ? PS1 : SH, {
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  },
};
