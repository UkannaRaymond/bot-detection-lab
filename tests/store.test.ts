import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  openDb,
  saveExperiment,
  type Db,
  type Observation,
} from "../src/lab/store.js";

let db: Db | undefined;
let dir: string;
const previousUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  // os.tmpdir() works on Windows, macOS and Linux; a hardcoded /tmp does not exist on Windows.
  dir = mkdtempSync(join(tmpdir(), "bot-lab-test-"));
  process.env.DATABASE_URL = `sqlite://${join(dir, "test.db")}`;
  db = await openDb();
});

afterAll(async () => {
  await db?.close();
  rmSync(dir, { recursive: true, force: true });
  if (previousUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousUrl;
});

const ok = (n: number): Observation[] =>
  Array.from({ length: n }, () => ({
    status: 200,
    triggered: [],
    latencyMs: 1,
  }));
const blocked = (n: number): Observation[] =>
  Array.from({ length: n }, () => ({
    status: 403,
    triggered: ["ua_blocklist"],
    latencyMs: 1,
  }));
const broken = (n: number): Observation[] =>
  Array.from({ length: n }, () => ({
    status: 0,
    triggered: [],
    latencyMs: 1,
    error: "boom",
  }));

it("confirms a correct block prediction and rejects a wrong one", async () => {
  expect(
    (
      await saveExperiment(
        db!,
        "b",
        "rule_matrix",
        "c",
        "r",
        "h",
        true,
        blocked(4),
      )
    ).conclusion,
  ).toBe("confirmed");
  expect(
    (
      await saveExperiment(
        db!,
        "b",
        "rule_matrix",
        "c",
        "r",
        "h",
        false,
        blocked(4),
      )
    ).conclusion,
  ).toBe("rejected");
  expect(
    (await saveExperiment(db!, "b", "rule_matrix", "c", "r", "h", false, ok(4)))
      .conclusion,
  ).toBe("confirmed");
});

it("never counts errored runs as blocks", async () => {
  const all = await saveExperiment(
    db!,
    "b",
    "rule_matrix",
    "c",
    "r",
    "h",
    true,
    broken(3),
  );
  expect(all.conclusion).toBe("error");
  expect(all.blocked).toBe(0);
  const mixed = await saveExperiment(
    db!,
    "b",
    "rule_matrix",
    "c",
    "r",
    "h",
    false,
    [...ok(2), ...broken(3)],
  );
  expect(mixed.blocked).toBe(0);
  expect(mixed.conclusion).toBe("confirmed"); // judged on the 2 runs that actually happened
});
