// Read-only mirror of the Tor Project CollecTor exit lists (CC0) for hosts whose ISP blocks
// torproject.org. Serves only /recent/exit-lists/ with the upstream paths unchanged, so the
// directory listing and the tordnsel files reach foxtrust byte for byte.
const UPSTREAM = "https://collector.torproject.org";
const PREFIX = "/recent/exit-lists/";

export default {
  async fetch(request) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed\n", { status: 405, headers: { allow: "GET, HEAD" } });
    }
    const { pathname, search } = new URL(request.url);
    if (!pathname.startsWith(PREFIX) || search !== "") {
      return new Response("not found\n", { status: 404 });
    }
    const upstream = await fetch(UPSTREAM + pathname, { method: request.method });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "text/plain; charset=utf-8" },
    });
  },
};
