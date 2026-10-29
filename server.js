const http = require("http");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.COC_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const SNAPSHOT_KEY = process.env.SNAPSHOT_KEY;
const BASE = "https://cocproxy.royaleapi.dev/v1";
const PORT = process.env.PORT || 3000;
const MAX_TRACKED = 100;
const TAG_RE = "[0-9A-Za-z]{3,15}";
const cache = new Map();

// ---- Database (optional: the site still works without it) ----
let pool = null;
if (DATABASE_URL) {
  const { Pool } = require("pg");
  pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 });
  pool.query(`
    CREATE TABLE IF NOT EXISTS tracked (
      tag TEXT PRIMARY KEY,
      added TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS snapshots (
      id SERIAL PRIMARY KEY,
      tag TEXT NOT NULL,
      taken TIMESTAMPTZ DEFAULT now(),
      trophies INT, best_trophies INT, town_hall INT,
      war_stars INT, donations INT, donations_received INT
    );
    CREATE INDEX IF NOT EXISTS snapshots_tag_taken ON snapshots (tag, taken);
  `).then(() => console.log("DB ready")).catch((e) => { console.error("DB init failed:", e.message); pool = null; });
}

const saveSnap = (d) => pool.query(
  "INSERT INTO snapshots (tag, trophies, best_trophies, town_hall, war_stars, donations, donations_received) VALUES ($1,$2,$3,$4,$5,$6,$7)",
  [d.tag, d.trophies, d.bestTrophies, d.townHallLevel, d.warStars, d.donations, d.donationsReceived]
);

// ---- CoC API via proxy ----
async function apiGet(p, fresh = false) {
  const hit = cache.get(p);
  if (!fresh && hit && Date.now() - hit.t < 30000) return { status: 200, body: hit.body };
  const r = await fetch(BASE + p, {
    headers: { Authorization: "Bearer " + TOKEN },
    signal: AbortSignal.timeout(10000),
  });
  const body = await r.text();
  if (r.status === 200) cache.set(p, { t: Date.now(), body });
  return { status: r.status, body };
}

const routes = {
  player: (t) => `/players/%23${t}`,
  clan: (t) => `/clans/%23${t}`,
  war: (t) => `/clans/%23${t}/currentwar`,
};

const send = (res, code, body, type = "application/json") => {
  res.writeHead(code, { "Content-Type": type });
  res.end(body);
};
const json = (res, code, obj) => send(res, code, JSON.stringify(obj));

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;
    let m;

    if (p === "/" || p === "/index.html") {
      return send(res, 200, fs.readFileSync(path.join(__dirname, "index.html")), "text/html; charset=utf-8");
    }

    // Player / clan / war lookups
    if ((m = p.match(new RegExp(`^/api/(player|clan|war)/(${TAG_RE})$`)))) {
      if (!TOKEN) return json(res, 500, { reason: "noToken" });
      const [, kind, raw] = m;
      const tag = raw.toUpperCase();
      const r = await apiGet(routes[kind](tag));
      // If this player is tracked, save a snapshot at most every 6 hours
      if (pool && kind === "player" && r.status === 200) {
        pool.query(
          "SELECT 1 FROM tracked t WHERE t.tag = $1 AND NOT EXISTS (SELECT 1 FROM snapshots s WHERE s.tag = t.tag AND s.taken > now() - interval '6 hours')",
          ["#" + tag]
        ).then((q) => q.rowCount ? saveSnap(JSON.parse(r.body)) : null).catch(() => {});
      }
      return send(res, r.status, r.body);
    }

    // History
    if ((m = p.match(new RegExp(`^/api/history/(${TAG_RE})$`)))) {
      if (!pool) return json(res, 503, { reason: "noDb" });
      const tag = "#" + m[1].toUpperCase();
      const t = await pool.query("SELECT 1 FROM tracked WHERE tag = $1", [tag]);
      const q = await pool.query(
        `SELECT * FROM (
           SELECT DISTINCT ON (taken::date) to_char(taken::date, 'YYYY-MM-DD') AS day, taken,
                  trophies, best_trophies, town_hall, war_stars, donations, donations_received
           FROM snapshots WHERE tag = $1 ORDER BY taken::date DESC, taken DESC LIMIT 90
         ) x ORDER BY taken ASC`, [tag]);
      return json(res, 200, { tracked: t.rowCount > 0, points: q.rows });
    }

    // Start tracking a player
    if (req.method === "POST" && (m = p.match(new RegExp(`^/api/track/(${TAG_RE})$`)))) {
      if (!pool) return json(res, 503, { reason: "noDb" });
      if (!TOKEN) return json(res, 500, { reason: "noToken" });
      const tag = m[1].toUpperCase();
      const c = await pool.query("SELECT count(*)::int AS n FROM tracked");
      if (c.rows[0].n >= MAX_TRACKED) return json(res, 429, { reason: "full" });
      const r = await apiGet(routes.player(tag), true);
      if (r.status !== 200) return send(res, r.status, r.body);
      await pool.query("INSERT INTO tracked (tag) VALUES ($1) ON CONFLICT DO NOTHING", ["#" + tag]);
      await saveSnap(JSON.parse(r.body));
      return json(res, 200, { ok: true });
    }

    // Daily snapshot of all tracked players (call from a free cron service)
    if (p === "/api/snapshot") {
      if (!SNAPSHOT_KEY || url.searchParams.get("key") !== SNAPSHOT_KEY) return json(res, 403, { reason: "forbidden" });
      if (!pool || !TOKEN) return json(res, 503, { reason: "notReady" });
      const list = await pool.query("SELECT tag FROM tracked");
      let ok = 0, failed = 0;
      for (const row of list.rows) {
        try {
          const r = await apiGet(routes.player(row.tag.replace("#", "")), true);
          if (r.status === 200) { await saveSnap(JSON.parse(r.body)); ok++; } else failed++;
        } catch (e) { failed++; }
        await new Promise((s) => setTimeout(s, 150));
      }
      return json(res, 200, { ok, failed });
    }

    return send(res, 404, "Not found", "text/plain");
  } catch (e) {
    console.error(e.message);
    return json(res, 502, { reason: "upstream" });
  }
}).listen(PORT, () => console.log("Running on " + PORT));
