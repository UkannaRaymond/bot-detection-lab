import { RULES } from "./predictions.js";
import { loadBatch, openDb } from "./store.js";

export async function matrixMarkdown(batch?: string): Promise<string> {
  const db = await openDb();
  const rows = await loadBatch(db, "rule_matrix", batch);
  await db.close();
  if (!rows.length) return "no results";
  const cols = [...RULES, "all"];
  const clients = [...new Set(rows.map((r) => r.client as string))];
  const cell = new Map(rows.map((r) => [`${r.client}|${r.rule}`, r]));
  const out = [`Batch \`${rows[0]!.batch}\`. Cell = observed outcome (blocked/runs). \`*\` = prediction was wrong. ERROR = client failed to run.`, "",
    `| client | ${cols.join(" | ")} |`, `|---|${cols.map(() => "---|").join("")}`];
  for (const c of clients) {
    const cells = cols.map((rule) => {
      const r = cell.get(`${c}|${rule}`);
      if (!r) return "-";
      const blocked = Number(r.blocked), runs = Number(r.runs);
      if (r.conclusion === "error") return `ERROR (${runs} runs failed)`;
      return `${blocked / Math.max(runs, 1) >= 0.5 ? "BLOCK" : "pass"} (${blocked}/${runs})${r.conclusion === "rejected" ? " *" : ""}`;
    });
    out.push(`| ${c} | ${cells.join(" | ")} |`);
  }
  out.push("", "Ground truth: which rules actually fired with ALL rules enabled", "");
  for (const c of clients) { const r = cell.get(`${c}|all`); if (r) out.push(`- **${c}**: ${r.observed_triggers}`); }
  const broken = [...new Set(rows.filter((r) => r.conclusion === "error").map((r) => r.client as string))];
  if (broken.length) out.push("", `Clients that could not run (excluded from conclusions): ${broken.join(", ")}`);
  const wrong = rows.filter((r) => r.conclusion === "rejected");
  out.push("", `Rejected hypotheses: ${wrong.length}`, "");
  for (const r of wrong) out.push(`- ${r.client} / ${r.rule}: ${r.hypothesis} -> blocked ${r.blocked}/${r.runs}, fired: ${r.observed_triggers}`);
  return out.join("\n");
}
