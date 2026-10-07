/** npm run lab -- matrix|rate|report|probe */
import { parseArgs } from "node:util";
import { makeClient } from "./clients.js";
import { runMatrix } from "./experiments.js";
import { runRate } from "./rate.js";
import { matrixMarkdown } from "./report.js";
import { openDb, saveExperiment } from "./store.js";

const [cmd = "report", ...rest] = process.argv.slice(2);
const { values: v } = parseArgs({
  args: rest,
  options: {
    target: { type: "string", default: process.env.TARGET_URL ?? "http://localhost:8000" },
    clients: { type: "string", default: "fetch,axios,fetch_spoofed,impit" },
    runs: { type: "string", default: "10" },
    "browser-runs": { type: "string", default: "3" },
    limit: { type: "string", default: "10" },
    window: { type: "string", default: "10" },
    proxies: { type: "string", default: "" },
  },
});

if (cmd === "matrix") {
  const batch = await runMatrix({ target: v.target!, clients: v.clients!.split(","), runs: Number(v.runs), browserRuns: Number(v["browser-runs"]) });
  console.log("\n" + (await matrixMarkdown(batch)));
} else if (cmd === "rate") {
  const real = v.proxies!.split(",").filter(Boolean);
  const pool = real.length ? real : [1, 2, 3].map((i) => `sim://10.0.0.${i}`);
  await runRate({ target: v.target!, limit: Number(v.limit), windowS: Number(v.window), mode: real.length ? "real" : "sim", exitSets: { 1: pool.slice(0, 1), [pool.length]: pool } });
} else if (cmd === "probe") {
  // Records each client's TLS/HTTP2 fingerprint as seen by tls.peet.ws (needs internet access).
  const db = await openDb();
  const batch = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14) + "-probe";
  for (const name of v.clients!.split(",")) {
    const c = makeClient(name);
    const r = await c.fetch("https://tls.peet.ws/api/all");
    let note: string;
    try {
      const d = JSON.parse(r.body);
      note = JSON.stringify({ ja3_hash: d.tls?.ja3_hash, akamai_h2: d.http2?.akamai_fingerprint_hash, http_version: d.http_version, user_agent: d.user_agent });
    } catch { note = `unparsed: ${r.body.slice(0, 200)} err=${r.error}`; }
    await saveExperiment(db, batch, "fingerprint", name, "tls_probe", `fingerprint of ${name}`, null, [{ status: r.status, triggered: [], latencyMs: r.latencyMs, error: r.error }], note);
    console.log(name, note);
    await c.close();
  }
  await db.close();
} else {
  console.log(await matrixMarkdown());
}
