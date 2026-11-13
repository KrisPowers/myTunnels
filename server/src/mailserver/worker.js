// The Email Worker myTunnels deploys. Email Routing hands every message for
// the domain to it, and it posts the message through the Cloudflare Tunnel
// to the mail server at home. Nothing is kept here.
//
// Bindings, set when it is deployed:
//   INBOUND_URL     https://<inbound host>/inbound
//   INBOUND_SECRET  proves the request came from this Worker

export default {
  async email(message, env, ctx) {
    const raw = await new Response(message.raw).arrayBuffer();

    let lastError = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 2000 * attempt));
      let resp;
      try {
        resp = await fetch(env.INBOUND_URL, {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + env.INBOUND_SECRET,
            "X-Mail-From": message.from,
            "X-Rcpt-To": message.to,
            "Content-Type": "message/rfc822",
          },
          body: raw,
        });
      } catch (e) {
        lastError = String(e);
        continue;
      }
      if (resp.ok) return;
      if (resp.status === 550 || resp.status === 552) {
        message.setReject(await resp.text());
        return;
      }
      lastError = "HTTP " + resp.status;
    }
    // The server at home is unreachable: fail, so Cloudflare tells the
    // sender rather than dropping the message.
    throw new Error("mail server unreachable: " + lastError);
  },
};
