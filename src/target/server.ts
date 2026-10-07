import { createTarget } from "./app.js";

const env = process.env;
const server = createTarget({
  secret: env.LAB_SECRET,
  rateLimit: env.RATE_LIMIT ? Number(env.RATE_LIMIT) : undefined,
  rateWindowS: env.RATE_WINDOW ? Number(env.RATE_WINDOW) : undefined,
  trustXff: env.TRUST_XFF === "1",
  requireClientHints: env.LAB_REQUIRE_CLIENT_HINTS !== "0",
  ja3Allowlist: (env.JA3_ALLOWLIST ?? "").split(",").filter(Boolean),
  redisUrl: env.REDIS_URL,
  defaultRules: env.DEFAULT_RULES,
});
const port = Number(env.PORT ?? 8000);
server.listen(port, "0.0.0.0", () => console.log(`bot-lab target listening on :${port}`));
