/** Refuse to run experiments against a target that does not know the rules being tested. */

export function missingRules(health: unknown, required: readonly string[]): string[] {
  const rules = (health as { rules?: unknown } | null)?.rules;
  const have = Array.isArray(rules) ? rules.map(String) : [];
  return required.filter((r) => !have.includes(r));
}

export async function assertTargetReady(target: string, required: readonly string[]): Promise<void> {
  let health: unknown;
  try {
    health = await (await fetch(`${target}/health`)).json();
  } catch (e) {
    throw new Error(`Cannot reach the target at ${target}/health (${e}). Start it first: pnpm run target`);
  }
  const missing = missingRules(health, required);
  if (missing.length) {
    throw new Error(
      `The target at ${target} does not know these rules: ${missing.join(", ")}. ` +
        `It is probably still running old code. Stop it (Ctrl+C), start it again, then re-run.`,
    );
  }
}
