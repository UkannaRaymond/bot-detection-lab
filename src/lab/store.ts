/** Persistence: Postgres when DATABASE_URL is set, otherwise a local SQLite file (node:sqlite). */
import pg from "pg";

type Row = Record<string, unknown>;
export interface Db {
  dialect: "pg" | "sqlite";
  run(sql: string, params?: unknown[]): Promise<void>;
  insert(sql: string, params: unknown[]): Promise<number>;
  all(sql: string, params?: unknown[]): Promise<Row[]>;
  close(): Promise<void>;
}

const toPg = (sql: string) => {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
};

async function openPg(url: string): Promise<Db> {
  const pool = new pg.Pool({ connectionString: url });
  return {
    dialect: "pg",
    run: async (sql, params = []) => void (await pool.query(toPg(sql), params as unknown[])),
    insert: async (sql, params) => Number((await pool.query(`${toPg(sql)} RETURNING id`, params)).rows[0].id),
    all: async (sql, params = []) => (await pool.query(toPg(sql), params as unknown[])).rows,
    close: () => pool.end(),
  };
}

async function openSqlite(file: string): Promise<Db> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file);
  return {
    dialect: "sqlite",
    run: async (sql, params = []) => void db.prepare(sql).run(...(params as never[])),
    insert: async (sql, params) => Number(db.prepare(sql).run(...(params as never[])).lastInsertRowid),
    all: async (sql, params = []) => db.prepare(sql).all(...(params as never[])) as Row[],
    close: async () => db.close(),
  };
}

export async function openDb(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  const db = url?.startsWith("postgres") ? await openPg(url) : await openSqlite(url?.replace(/^sqlite:\/\//, "") || "lab.db");
  const id = db.dialect === "pg" ? "SERIAL PRIMARY KEY" : "INTEGER PRIMARY KEY AUTOINCREMENT";
  await db.run(`CREATE TABLE IF NOT EXISTS experiments (
    id ${id}, batch TEXT, created_at TEXT, kind TEXT, client TEXT, rule TEXT, hypothesis TEXT,
    predicted_blocked INTEGER, runs INTEGER, blocked INTEGER, conclusion TEXT, observed_triggers TEXT, notes TEXT)`);
  await db.run(`CREATE TABLE IF NOT EXISTS observations (
    id ${id}, experiment_id INTEGER, run_idx INTEGER, status INTEGER, triggered TEXT, latency_ms REAL, error TEXT)`);
  return db;
}

export interface Observation { status: number; triggered: string[]; latencyMs: number; error?: string | null }
export interface SavedExperiment { id: number; client: string; rule: string; runs: number; blocked: number; conclusion: string; triggers: string[] }

export async function saveExperiment(
  db: Db, batch: string, kind: string, client: string, rule: string, hypothesis: string,
  predictedBlocked: boolean | null, obs: Observation[], notes = "",
): Promise<SavedExperiment> {
  // A run that errored (client crashed, binary missing, network) says nothing about detection:
  // it must never count as a block, or a broken client would "confirm" blocking predictions.
  const errors = obs.filter((o) => o.error).length;
  const valid = obs.filter((o) => !o.error);
  const blocked = valid.filter((o) => o.status !== 200).length;
  const runs = obs.length;
  const conclusion = errors === runs && runs > 0 ? "error"
    : predictedBlocked === null ? "n/a"
    : blocked / Math.max(valid.length, 1) >= 0.5 === predictedBlocked ? "confirmed" : "rejected";
  if (errors) notes = `${notes} errors=${errors}/${runs}: ${obs.find((o) => o.error)?.error?.slice(0, 160)}`.trim();
  const triggers = [...new Set(obs.flatMap((o) => o.triggered))].sort();
  const id = await db.insert(
    `INSERT INTO experiments (batch, created_at, kind, client, rule, hypothesis, predicted_blocked, runs, blocked, conclusion, observed_triggers, notes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [batch, new Date().toISOString(), kind, client, rule, hypothesis, predictedBlocked === null ? null : Number(predictedBlocked), runs, blocked, conclusion, JSON.stringify(triggers), notes],
  );
  for (const [i, o] of obs.entries()) {
    await db.run(`INSERT INTO observations (experiment_id, run_idx, status, triggered, latency_ms, error) VALUES (?,?,?,?,?,?)`,
      [id, i, o.status, o.triggered.join(","), o.latencyMs, o.error ?? null]);
  }
  return { id, client, rule, runs, blocked, conclusion, triggers };
}

export async function loadBatch(db: Db, kind: string, batch?: string): Promise<Row[]> {
  let b = batch;
  if (!b) {
    const latest = await db.all(`SELECT batch FROM experiments WHERE kind = ? ORDER BY id DESC LIMIT 1`, [kind]);
    b = latest[0]?.batch as string | undefined;
    if (!b) return [];
  }
  return db.all(`SELECT * FROM experiments WHERE batch = ? AND kind = ? ORDER BY id`, [b, kind]);
}
