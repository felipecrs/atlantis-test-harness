// Exposes Atlantis to the internet for as long as it's in scope. Only POST
// /events, which needs to be signed.
import { url as atlantisUrl, waitFor } from "./atlantis";

export async function openTunnel() {
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (request.method !== "POST" || pathname !== "/events") return new Response("harness", { status: 404 });
      return fetch(`${atlantisUrl}/events`, { method: "POST", headers: request.headers, body: await request.arrayBuffer() });
    },
  });
  const tunnel = Bun.spawn(["cloudflared", "tunnel", "--no-autoupdate", "--url", proxy.url.origin], { stdout: "ignore", stderr: "pipe" });
  const close = async () => {
    tunnel.kill();
    await tunnel.exited;
    await proxy.stop(true);
  };

  let log = "";
  (async () => {
    for await (const chunk of tunnel.stderr) log += new TextDecoder().decode(chunk);
  })();
  try {
    let url: string | undefined;
    await waitFor("the tunnel", async () => {
      if (tunnel.exitCode !== null) throw new Error(log);
      url = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
      return !!url && log.includes("Registered tunnel connection");
    });
    await waitFor("the tunnel to be reachable", () =>
      fetch(url!).then(async (r) => (await r.text()) === "harness", () => false));
    return { url: `${url}/events`, [Symbol.asyncDispose]: close };
  } catch (e) {
    await close();
    throw e;
  }
}
