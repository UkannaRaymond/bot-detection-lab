/**
 * Exit pool with health tracking.
 * An exit is a real proxy URL (http://proxy1:8888) or `sim://<ip>`, which makes the runner send
 * X-Forwarded-For so one local target can pretend to see many IPs (target needs TRUST_XFF=1).
 * Cooldowns live in Redis when REDIS_URL is set (shared between runner pods), else in memory.
 */
import { Redis } from "ioredis";

export class ExitPool {
  private i = 0;
  private mem = new Map<string, number>();
  private redis: Redis | null = null;

  constructor(readonly exits: string[], private cooldownS = 30, redisUrl = process.env.REDIS_URL) {
    if (redisUrl) this.redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
  }

  async init(): Promise<void> {
    if (!this.redis) return;
    try { await this.redis.connect(); await this.redis.ping(); } catch { this.redis.disconnect(); this.redis = null; }
  }

  private async cooling(e: string): Promise<boolean> {
    if (this.redis) return (await this.redis.exists(`exit:cooldown:${e}`)) === 1;
    return (this.mem.get(e) ?? 0) > Date.now();
  }

  /** Round-robin over healthy exits; null when every exit is cooling down. */
  async next(): Promise<string | null> {
    for (let n = 0; n < this.exits.length; n++) {
      const e = this.exits[this.i++ % this.exits.length] as string;
      if (!(await this.cooling(e))) return e;
    }
    return null;
  }

  async report(e: string, ok: boolean): Promise<void> {
    if (ok) return;
    if (this.redis) await this.redis.setex(`exit:cooldown:${e}`, this.cooldownS, "1");
    else this.mem.set(e, Date.now() + this.cooldownS * 1000);
  }

  async close(): Promise<void> { this.redis?.disconnect(); }
}

export const isSim = (e: string | null): e is string => !!e && e.startsWith("sim://");
