// Weekly numbers from Analytics Engine: node scripts/weekly.mjs [days=7]
// Needs CF_ACCOUNT_ID and CF_API_TOKEN (a token with Account Analytics: Read, plus
// Workers Scripts: Read for the all-time canvas total).
// Each headline compares the last <days> days with the <days> before them.

const { CF_ACCOUNT_ID: account, CF_API_TOKEN: token } = process.env;
if (!account || !token) {
  console.error("Set CF_ACCOUNT_ID and CF_API_TOKEN (Account Analytics: Read, Workers Scripts: Read).");
  process.exit(1);
}
const days = Number(process.argv[2] || 7);
const DATASET = "divs_and_spans_events";
const WORKER = "divs-and-spans";

async function cfApi(path) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.success) throw new Error(`${res.status} ${JSON.stringify(body.errors ?? body)}`);
  return body;
}

/**
 * Every canvas is one DesignFile Durable Object, so the all-time total is the number of
 * objects with stored data. Analytics Engine can't answer this: it only has events since
 * analytics shipped, for ~3 months. Before that change, opening a link to a missing file
 * also left an empty object behind, so the total runs slightly high for older canvases.
 */
async function canvasesAllTime() {
  const { result: namespaces } = await cfApi("/workers/durable_objects/namespaces");
  const ns = namespaces.find((n) => n.script === WORKER && n.class === "DesignFile");
  if (!ns) throw new Error(`no DesignFile namespace for ${WORKER}`);
  let total = 0;
  let cursor = "";
  do {
    const page = await cfApi(`/workers/durable_objects/namespaces/${ns.id}/objects?limit=10000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    total += page.result.filter((o) => o.hasStoredData).length;
    cursor = page.result_info?.cursor ?? "";
  } while (cursor);
  return total;
}

async function sql(query) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: `${query} FORMAT JSON`,
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${body}\n${query}`);
  return JSON.parse(body).data;
}

// window 0 is the current period, 1 the one before it
const span = (w) =>
  `timestamp > NOW() - INTERVAL '${days * (w + 1)}' DAY` + (w ? ` AND timestamp <= NOW() - INTERVAL '${days * w}' DAY` : "");

const one = async (select, where, w) => {
  const [row] = await sql(`SELECT ${select} AS v FROM ${DATASET} WHERE ${span(w)} AND ${where}`);
  return Number(row?.v ?? 0);
};

const HEADLINES = [
  ["Unique canvas viewers", "count(DISTINCT blob4)", "blob1 = 'session'"],
  ["Engaged hours on canvas", "SUM(_sample_interval * double2) / 3600000", "blob1 = 'session'"],
  ["Hours canvas open", "SUM(_sample_interval * double1) / 3600000", "blob1 = 'session'"],
  ["Canvases viewed", "count(DISTINCT index1)", "blob1 = 'session'"],
  ["Canvases written to", "count(DISTINCT index1)", "blob1 = 'tool' AND blob2 = 'write_frame' AND blob5 IN ('new', 'edit')"],
  ["Canvases created", "SUM(_sample_interval)", "(blob1 = 'create' OR (blob1 = 'tool' AND blob2 = 'create_file' AND blob5 = 'ok'))"],
  ["  from the web", "SUM(_sample_interval)", "blob1 = 'create' AND blob2 = 'web'"],
  ["  over MCP", "SUM(_sample_interval)", "blob1 = 'tool' AND blob2 = 'create_file' AND blob5 = 'ok'"],
  ["Frames written", "SUM(_sample_interval)", "blob1 = 'tool' AND blob2 = 'write_frame' AND blob5 IN ('new', 'edit')"],
  ["New frames", "SUM(_sample_interval)", "blob1 = 'tool' AND blob2 = 'write_frame' AND blob5 = 'new'"],
  ["Element links followed", "SUM(_sample_interval)", "blob1 = 'tool' AND blob2 = 'get_frame' AND blob5 = 'element'"],
  ["Canvases with an element link", "count(DISTINCT index1)", "blob1 = 'tool' AND blob2 = 'get_frame' AND blob5 = 'element'"],
  ["Exports", "SUM(_sample_interval)", "blob1 = 'export'"],
  ["PNGs", "SUM(_sample_interval)", "blob1 = 'png'"],
  ["  rendered (not cached)", "SUM(_sample_interval)", "blob1 = 'png' AND blob5 != 'cached'"],
  ["MCP connects", "SUM(_sample_interval)", "blob1 = 'connect'"],
];

const fmt = (n) => (Number.isInteger(n) ? n.toLocaleString() : n.toFixed(1));
const delta = (now, before) => (before ? `${now >= before ? "+" : ""}${Math.round(((now - before) / before) * 100)}%` : now ? "new" : "");

const rows = await Promise.all(
  HEADLINES.map(async ([label, select, where]) => [label, await one(select, where, 0), await one(select, where, 1)]),
);
console.log(`\nDivs & Spans · last ${days} days vs the ${days} before\n`);
try {
  console.log(`  Canvases all time: ${(await canvasesAllTime()).toLocaleString()}\n`);
} catch (e) {
  console.log(`  Canvases all time: unavailable (${e.message}). The token needs Workers Scripts: Read.\n`);
}
const w = Math.max(...rows.map(([l]) => l.length));
for (const [label, now, before] of rows) {
  console.log(`  ${label.padEnd(w)}  ${fmt(now).padStart(9)}  ${fmt(before).padStart(9)}  ${delta(now, before)}`);
}

const table = async (title, query, cols) => {
  const data = await sql(query);
  console.log(`\n${title}`);
  if (!data.length) return console.log("  (none)");
  for (const r of data) console.log("  " + cols.map(([k, pad]) => String(r[k] ?? "").padEnd(pad)).join("  "));
};

await table(
  "Tool calls",
  `SELECT blob2 AS tool, SUM(_sample_interval) AS calls,
     sumIf(_sample_interval, blob5 IN ('conflict', 'bad_link', 'not_found', 'error')) AS errors,
     SUM(_sample_interval * double1) / SUM(_sample_interval) AS avg_ms
   FROM ${DATASET} WHERE ${span(0)} AND blob1 = 'tool' GROUP BY tool ORDER BY calls DESC`,
  [["tool", 14], ["calls", 8], ["errors", 7], ["avg_ms", 8]],
);
await table(
  "Tool errors by kind",
  `SELECT blob2 AS tool, blob5 AS kind, SUM(_sample_interval) AS n FROM ${DATASET}
   WHERE ${span(0)} AND blob1 = 'tool' AND blob5 IN ('conflict', 'bad_link', 'not_found', 'error')
   GROUP BY tool, kind ORDER BY n DESC LIMIT 15`,
  [["tool", 14], ["kind", 10], ["n", 6]],
);
await table(
  "Lint warnings per frame written",
  `SELECT SUM(_sample_interval * double3) / SUM(_sample_interval) AS avg_warnings,
     SUM(_sample_interval * double2) / SUM(_sample_interval) AS avg_html_bytes
   FROM ${DATASET} WHERE ${span(0)} AND blob1 = 'tool' AND blob2 = 'write_frame' AND blob5 IN ('new', 'edit')`,
  [["avg_warnings", 14], ["avg_html_bytes", 14]],
);
await table(
  "MCP clients (from initialize)",
  `SELECT blob2 AS client, blob4 AS user_agent, SUM(_sample_interval) AS connects FROM ${DATASET}
   WHERE ${span(0)} AND blob1 = 'connect' GROUP BY client, user_agent ORDER BY connects DESC LIMIT 10`,
  [["client", 24], ["user_agent", 18], ["connects", 8]],
);
await table(
  "Viewers by device",
  `SELECT blob5 AS device, count(DISTINCT blob4) AS viewers FROM ${DATASET}
   WHERE ${span(0)} AND blob1 = 'session' GROUP BY device ORDER BY viewers DESC`,
  [["device", 10], ["viewers", 8]],
);
await table(
  "Viewers by country",
  `SELECT blob6 AS country, count(DISTINCT blob4) AS viewers FROM ${DATASET}
   WHERE ${span(0)} AND blob1 = 'session' GROUP BY country ORDER BY viewers DESC LIMIT 10`,
  [["country", 8], ["viewers", 8]],
);
{
  // bucketed here rather than with a subquery, to stay inside Analytics Engine's SQL subset
  const perFile = await sql(
    `SELECT index1, count(DISTINCT blob4) AS viewers FROM ${DATASET} WHERE ${span(0)} AND blob1 = 'session' GROUP BY index1`,
  );
  const buckets = new Map();
  for (const { viewers } of perFile) buckets.set(Number(viewers), (buckets.get(Number(viewers)) ?? 0) + 1);
  console.log("\nViewers per canvas (canvases seen by 2+ people are being shared)");
  if (!buckets.size) console.log("  (none)");
  for (const [viewers, files] of [...buckets].sort((a, b) => a[0] - b[0])) console.log(`  ${String(viewers).padEnd(8)}  ${files} canvases`);
}
console.log("");
