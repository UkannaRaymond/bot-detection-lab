/** Rule-matrix experiments: each client x each rule alone, plus all rules together. */
import { makeClient } from "./clients.js";
import { predictedBlocked, PREDICTIONS, RULES } from "./predictions.js";
import { openDb, saveExperiment, type Observation } from "./store.js";

export async function runMatrix(opts: { target: string; clients: string[]; runs: number; browserRuns: number; log?: (s: string) => void }): Promise<string> {
  const log = opts.log ?? console.log;
  const db = await openDb();
  const batch = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14) + "-" + Math.random().toString(16).slice(2, 6);
  for (const name of opts.clients) {
    const client = makeClient(name);
    const n = client.slow ? opts.browserRuns : opts.runs;
    try {
      for (const rule of [...RULES, "all"]) {
        const pred = predictedBlocked(name, rule);
        const what = rule === "all" ? "all rules enabled" : `only '${rule}' enabled`;
        const hyp = `${name} is ${pred ? "blocked" : "allowed"} with ${what} (${PREDICTIONS[name]!.why})`;
        const obs: Observation[] = [];
        for (let i = 0; i < n; i++) {
          const r = await client.fetch(`${opts.target}/protected?rules=${rule}`);
          obs.push({ status: r.status, triggered: r.triggered, latencyMs: r.latencyMs, error: r.error });
        }
        const row = await saveExperiment(db, batch, "rule_matrix", name, rule, hyp, pred, obs);
        const err = obs.find((o) => o.error)?.error;
        log(`${name.padEnd(14)} ${rule.padEnd(19)} blocked ${row.blocked}/${row.runs}  predicted=${pred ? "block" : "pass "}  ${row.conclusion.padEnd(9)} truth=[${row.triggers}]${err ? "  ERROR " + err : ""}`);
      }
    } finally {
      await client.close();
    }
  }
  await db.close();
  return batch;
}
