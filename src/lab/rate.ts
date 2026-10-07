/**
 * Does rotating exits buy more requests per rate-limit window?
 * Hypothesis: with limit L per window, k healthy exits sustain about k*L successful requests in
 * one window, and a cooldown-aware pool stops sending to an exit once it is limited.
 */
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { ExitPool, isSim } from "./proxies.js";
import { openDb, saveExperiment, type Observation } from "./store.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runRate(opts: { target: string; limit: number; windowS: number; exitSets: Record<number, string[]>; mode: "sim" | "real"; log?: (s: string) => void }) {
  const log = opts.log ?? console.log;
  const db = await openDb();
  const batch = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14) + "-rate";
  const attempts = 4 * opts.limit;
  const out: Record<number, number> = {};
  for (const [kStr, exits] of Object.entries(opts.exitSets)) {
    const k = Number(kStr);
    const pool = new ExitPool(exits, opts.windowS * 2);
    await pool.init();
    // Start at the beginning of a fresh fixed window so the count is not split across two buckets.
    await sleep(opts.windowS * 1000 - (Date.now() % (opts.windowS * 1000)) + 50);
    const obs: Observation[] = [];
    let ok = 0;
    for (let i = 0; i < attempts; i++) {
      const e = await pool.next();
      if (e === null) { obs.push({ status: 0, triggered: ["no_exit_available"], latencyMs: 0 }); continue; }
      const t0 = performance.now();
      let status = 0;
      try {
        const url = `${opts.target}/protected?rules=rate_limit`;
        const r = isSim(e)
          ? await undiciFetch(url, { headers: { "x-forwarded-for": e.slice(6) } })
          : await undiciFetch(url, { dispatcher: new ProxyAgent(e) });
        status = r.status;
        await r.text();
      } catch { status = 0; }
      await pool.report(e, status === 200);
      if (status === 200) ok++;
      obs.push({ status, triggered: status === 200 ? [] : ["rate_limit"], latencyMs: performance.now() - t0 });
    }
    const expected = Math.min(k * opts.limit, attempts);
    const hyp = `${k} exit(s) at ${opts.limit}/${opts.windowS}s should give about ${expected} successes of ${attempts} attempts in one window`;
    await saveExperiment(db, batch, "rate_limit", `fetch x${k}`, "rate_limit", hyp, null, obs, `mode=${opts.mode} successes=${ok} expected~${expected}`);
    out[k] = ok;
    log(`exits=${k}: ${ok} successes of ${attempts} (expected ~${expected})`);
    await pool.close();
  }
  await db.close();
  return out;
}
