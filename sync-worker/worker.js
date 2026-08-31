/* Daily Deck sync: one KV blob, bearer-token gated, CORS-scoped to the app.
   This is the app's entire "backend". */

const ALLOWED_ORIGINS = ["https://adityasingh.io", "http://localhost:4173", "http://localhost:5173"];

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") ?? "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "GET,PUT,OPTIONS",
      "Access-Control-Allow-Headers": "Authorization,Content-Type",
    };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });

    const auth = req.headers.get("Authorization") ?? "";
    if (!env.SYNC_TOKEN || auth !== `Bearer ${env.SYNC_TOKEN}`) {
      return new Response("unauthorized", { status: 401, headers: cors });
    }

    if (req.method === "GET") {
      const data = await env.SYNC.get("state");
      return new Response(data ?? "{}", { headers: { ...cors, "Content-Type": "application/json" } });
    }
    if (req.method === "PUT") {
      const body = await req.text();
      if (body.length > 800_000) return new Response("too large", { status: 413, headers: cors });
      try {
        JSON.parse(body);
      } catch {
        return new Response("not json", { status: 400, headers: cors });
      }
      await env.SYNC.put("state", body);
      return new Response('{"ok":true}', { headers: { ...cors, "Content-Type": "application/json" } });
    }
    return new Response("method not allowed", { status: 405, headers: cors });
  },
};
