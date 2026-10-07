/**
 * Target server with toggleable bot-detection rules.
 *
 * GET /protected?rules=a,b   (or rules=all) evaluates the named rules for that request only,
 * so experiments are stateless and can run in parallel. Ground truth comes back in the
 * `X-Lab-Triggered` response header; a scraper under test only gets to see the status code.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Redis } from "ioredis";

export const STATIC_RULES = [
  "ua_blocklist",
  "header_consistency",
  "header_order",
  "cookie_challenge",
  "webdriver_check",
  "headless_signals",
] as const;
export const ALL_RULES = [...STATIC_RULES, "rate_limit", "tls_fingerprint"] as const;
export type RuleName = (typeof ALL_RULES)[number];

export interface TargetOptions {
  secret?: string;
  rateLimit?: number; // requests per window per IP
  rateWindowS?: number;
  trustXff?: boolean; // let clients simulate many exit IPs with X-Forwarded-For
  /** Chrome only sends client hints / fetch metadata to secure origins (https or localhost). */
  requireClientHints?: boolean;
  ja3Allowlist?: string[];
  redisUrl?: string;
  defaultRules?: string;
}

export interface Ctx {
  /** [lowercased name, value] in the order they arrived on the wire */
  headers: [string, string][];
  h: Map<string, string>;
  names: string[];
  ip: string;
  cookies: Map<string, string>;
}

type Verdict = string | null;

const BOT_UA_TOKENS = [
  "python-requests", "python-httpx", "httpx", "curl/", "aiohttp", "go-http-client", "scrapy",
  "headlesschrome", "puppeteer", "playwright", "axios/", "node-fetch", "undici", "got (", "okhttp",
];
const CHROME_ORDER = ["sec-ch-ua", "user-agent", "accept", "accept-encoding", "accept-language"];
const FIREFOX_ORDER = ["user-agent", "accept", "accept-language", "accept-encoding"];
const COOKIE_NAME = "__lab_clr";
const SIGNALS_COOKIE = "__lab_sig";
const JS_RULES = ["cookie_challenge", "webdriver_check", "headless_signals"];

/** What the challenge page reports about the JS environment. */
export interface Signals {
  p: number; // navigator.plugins.length
  c: number; // 1 when window.chrome exists
  l: string[]; // navigator.languages
  pl: string; // navigator.platform
  w: number; // screen.width  (recorded only; screen size is too easy to overfit on)
  h: number; // screen.height
  tz: string; // timezone       (recorded only)
}

function inOrder(names: string[], expected: string[]): boolean {
  const idx = expected.filter((n) => names.includes(n)).map((n) => names.indexOf(n));
  return idx.every((v, i) => i === 0 || (idx[i - 1] as number) <= v);
}

export function createTarget(opts: TargetOptions = {}): Server & { close(): Server } {
  const secret = opts.secret ?? "lab-secret";
  const rateLimit = opts.rateLimit ?? 10;
  const rateWindowS = opts.rateWindowS ?? 10;
  const requireHints = opts.requireClientHints ?? true;
  const ja3 = new Set(opts.ja3Allowlist ?? []);
  const redis = opts.redisUrl ? new Redis(opts.redisUrl) : null;
  const mem = new Map<string, number>();

  const makeToken = (ip: string, ua: string) =>
    createHmac("sha256", secret).update(`${ip}|${ua}`).digest("hex").slice(0, 24);

  async function hit(key: string): Promise<number> {
    const bucket = Math.floor(Date.now() / 1000 / rateWindowS);
    const k = `rl:${key}:${bucket}`;
    if (redis) {
      const res = await redis.multi().incr(k).expire(k, rateWindowS * 2).exec();
      return Number(res?.[0]?.[1] ?? 0);
    }
    const n = (mem.get(k) ?? 0) + 1;
    mem.set(k, n);
    if (mem.size > 10_000) for (const kk of mem.keys()) if (!kk.endsWith(`:${bucket}`)) mem.delete(kk);
    return n;
  }

  // ---- rules ---------------------------------------------------------------
  const uaBlocklist = (c: Ctx): Verdict => {
    const ua = (c.h.get("user-agent") ?? "").toLowerCase();
    if (!ua) return "missing user-agent";
    if (ua === "node") return "user-agent is the bare Node.js default";
    const t = BOT_UA_TOKENS.find((tok) => ua.includes(tok));
    return t ? `user-agent contains '${t}'` : null;
  };

  const headerConsistency = (c: Ctx): Verdict => {
    const ua = c.h.get("user-agent") ?? "";
    let required: string[];
    if (ua.includes("Firefox/")) {
      if (c.h.has("sec-ch-ua")) return "Firefox UA but sec-ch-ua present (Firefox sends no client hints)";
      required = ["accept", "accept-language", "accept-encoding"];
    } else if (ua.includes("Chrome/")) {
      required = ["accept", "accept-language", "accept-encoding"];
      // Chrome navigations always carry client hints and fetch metadata (secure origins only).
      if (requireHints) required.push("sec-ch-ua", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest");
      const platform = (c.h.get("sec-ch-ua-platform") ?? "").replaceAll('"', "");
      for (const [needle, expected] of [["Windows", "Windows"], ["Macintosh", "macOS"], ["Linux", "Linux"]] as const) {
        if (ua.includes(needle) && platform && platform !== expected) return `UA says ${needle} but sec-ch-ua-platform is ${platform}`;
      }
      // A navigation says `sec-fetch-mode: navigate`; `cors` means a script-initiated fetch.
      const mode = c.h.get("sec-fetch-mode");
      if (mode && mode !== "navigate") return `sec-fetch-mode is '${mode}', a top-level navigation sends 'navigate'`;
    } else return null; // not claiming to be a browser; other rules handle it
    const missing = required.filter((n) => !c.h.has(n));
    return missing.length ? `browser UA but missing headers: ${missing.join(", ")}` : null;
  };

  const headerOrder = (c: Ctx): Verdict => {
    const ua = c.h.get("user-agent") ?? "";
    const expected = ua.includes("Firefox/") ? FIREFOX_ORDER : ua.includes("Chrome/") ? CHROME_ORDER : null;
    if (!expected) return null;
    if (inOrder(c.names, expected)) return null;
    return `header order [${c.names.filter((n) => expected.includes(n))}] does not match browser order [${expected.filter((n) => c.names.includes(n))}]`;
  };

  const tlsFingerprint = (c: Ctx): Verdict => {
    // Needs a TLS-terminating proxy that injects the JA3 hash; without one the rule cannot be evaluated.
    const h = c.h.get("x-ja3-hash");
    if (h === undefined) return null;
    return ja3.size && !ja3.has(h) ? `JA3 ${h} not in allowlist` : null;
  };

  function parseSignals(c: Ctx): Signals | null {
    const raw = c.cookies.get(SIGNALS_COOKIE);
    if (!raw) return null;
    try {
      const d = JSON.parse(decodeURIComponent(raw)) as Partial<Signals>;
      if (typeof d.p !== "number" || !Array.isArray(d.l) || typeof d.pl !== "string") return null;
      return { p: d.p, c: Number(d.c) || 0, l: d.l.map(String), pl: d.pl, w: Number(d.w) || 0, h: Number(d.h) || 0, tz: String(d.tz ?? "") };
    } catch { return null; }
  }

  /** Cross-checks JS-visible browser state against the UA and the request headers. */
  const headlessSignals = (c: Ctx, sig: Signals | null): Verdict => {
    if (!sig) return "signals cookie missing or malformed";
    const ua = c.h.get("user-agent") ?? "";
    const problems: string[] = [];
    if (ua.includes("Chrome/")) {
      if (sig.p === 0) problems.push("Chrome UA but navigator.plugins is empty (real Chrome lists its PDF viewers)");
      if (!sig.c) problems.push("Chrome UA but window.chrome is missing");
    }
    if (!sig.l.length) problems.push("navigator.languages is empty");
    const header = c.h.get("accept-language");
    if (!header && sig.l.length) {
      problems.push(`navigator.languages is [${sig.l}] but no Accept-Language header was sent`);
    } else if (header && sig.l[0]) {
      const first = (header.split(",")[0] ?? "").split(";")[0]!.trim().toLowerCase();
      if (first !== sig.l[0].toLowerCase()) problems.push(`Accept-Language starts with '${first}' but navigator.languages[0] is '${sig.l[0]}'`);
    }
    const platformFor = ua.includes("Windows") ? "Win" : ua.includes("Macintosh") ? "Mac" : ua.includes("Linux") || ua.includes("X11") ? "Linux" : null;
    if (platformFor && !sig.pl.includes(platformFor)) problems.push(`UA says ${platformFor} but navigator.platform is '${sig.pl}'`);
    return problems.length ? problems.join("; ") : null;
  };

  const simple: Record<string, (c: Ctx) => Verdict> = {
    ua_blocklist: uaBlocklist,
    header_consistency: headerConsistency,
    header_order: headerOrder,
    tls_fingerprint: tlsFingerprint,
  };

  function parseClearance(c: Ctx): { valid: boolean; webdriver: boolean } | null {
    const raw = c.cookies.get(COOKIE_NAME);
    if (!raw) return null;
    const dot = raw.indexOf(".");
    const token = dot === -1 ? raw : raw.slice(0, dot);
    const wd = dot === -1 ? "" : raw.slice(dot + 1);
    const want = Buffer.from(makeToken(c.ip, c.h.get("user-agent") ?? ""));
    const got = Buffer.from(token);
    return { valid: got.length === want.length && timingSafeEqual(got, want), webdriver: wd === "1" };
  }

  const challengeHtml = (token: string) =>
    `<!doctype html><title>Checking your browser</title><script>` +
    `var wd=navigator.webdriver?"1":"0";` +
    `var s={p:navigator.plugins.length,c:typeof window.chrome!=="undefined"?1:0,l:Array.from(navigator.languages||[]),` +
    `pl:navigator.platform,w:screen.width,h:screen.height,tz:Intl.DateTimeFormat().resolvedOptions().timeZone};` +
    `document.cookie="${COOKIE_NAME}=${token}."+wd+"; path=/";` +
    `document.cookie="${SIGNALS_COOKIE}="+encodeURIComponent(JSON.stringify(s))+"; path=/";` +
    `location.reload();</script>`;

  function resolveRules(spec: string | null): string[] {
    const s = spec ?? opts.defaultRules ?? "";
    if (s === "all") return [...STATIC_RULES];
    return s.split(",").map((x) => x.trim()).filter((x) => (ALL_RULES as readonly string[]).includes(x));
  }

  function buildCtx(req: IncomingMessage): Ctx {
    const raw = req.rawHeaders; // [name, value, name, value, ...] in wire order and original case
    const headers: [string, string][] = [];
    for (let i = 0; i < raw.length; i += 2) headers.push([(raw[i] as string).toLowerCase(), raw[i + 1] as string]);
    const h = new Map<string, string>();
    for (const [k, v] of headers) if (!h.has(k)) h.set(k, v);
    const cookies = new Map<string, string>();
    for (const part of (h.get("cookie") ?? "").split(";")) {
      const eq = part.indexOf("=");
      if (eq > 0) cookies.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
    }
    const xff = opts.trustXff ? h.get("x-forwarded-for")?.split(",")[0]?.trim() : undefined;
    return { headers, h, names: headers.map(([k]) => k), ip: xff || req.socket.remoteAddress || "unknown", cookies };
  }

  function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
    const isHtml = typeof body === "string";
    res.writeHead(status, { "content-type": isHtml ? "text/html" : "application/json", ...extra });
    res.end(isHtml ? body : JSON.stringify(body));
  }

  async function protectedRoute(req: IncomingMessage, res: ServerResponse, url: URL) {
    const active = resolveRules(url.searchParams.get("rules"));
    const ctx = buildCtx(req);
    const triggered: [string, string][] = [];

    for (const [name, fn] of Object.entries(simple)) {
      if (!active.includes(name)) continue;
      const reason = fn(ctx);
      if (reason) triggered.push([name, reason]);
    }

    let needChallenge = false;
    const jsActive = JS_RULES.filter((n) => active.includes(n));
    if (jsActive.length) {
      const cl = parseClearance(ctx);
      if (!cl || !cl.valid) {
        needChallenge = true;
        for (const n of jsActive) triggered.push([n, "no valid clearance cookie (JavaScript not executed)"]);
      } else {
        if (cl.webdriver && active.includes("webdriver_check")) triggered.push(["webdriver_check", "navigator.webdriver was true"]);
        if (active.includes("headless_signals")) {
          const reason = headlessSignals(ctx, parseSignals(ctx));
          if (reason) triggered.push(["headless_signals", reason]);
        }
      }
    }

    if (active.includes("rate_limit")) {
      const n = await hit(ctx.ip);
      if (n > rateLimit) triggered.push(["rate_limit", `${n} requests in ${rateWindowS}s from ${ctx.ip} (limit ${rateLimit})`]);
    }

    const names = triggered.map(([n]) => n);
    const headers = { "x-lab-triggered": names.join(",") };
    if (!triggered.length) return send(res, 200, { allowed: true, ip: ctx.ip, rules: active }, headers);

    // The JS challenge is only served when no static fingerprint rule already condemned the request.
    const onlyJsRules = names.every((n) => JS_RULES.includes(n));
    if (needChallenge && onlyJsRules) {
      return send(res, 403, challengeHtml(makeToken(ctx.ip, ctx.h.get("user-agent") ?? "")), headers);
    }
    const status = names.length === 1 && names[0] === "rate_limit" ? 429 : 403;
    return send(res, status, { allowed: false, triggered: triggered.map(([rule, reason]) => ({ rule, reason })) }, headers);
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://lab");
    if (url.pathname === "/health") return send(res, 200, { ok: true, rules: ALL_RULES });
    if (url.pathname === "/echo") return send(res, 200, { ip: buildCtx(req).ip, headers: buildCtx(req).headers });
    if (url.pathname === "/protected") {
      protectedRoute(req, res, url).catch((e) => send(res, 500, { error: String(e) }));
      return;
    }
    send(res, 404, { error: "not found" });
  });
  server.on("close", () => redis?.disconnect());
  return server as Server & { close(): Server };
}

// Used by tests to craft valid clearance cookies.
export const _tokenFor = (secret: string, ip: string, ua: string) =>
  createHmac("sha256", secret).update(`${ip}|${ua}`).digest("hex").slice(0, 24);
