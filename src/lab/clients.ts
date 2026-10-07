/**
 * Clients under test. Each exposes fetch(url) -> Result.
 * "Observed" behaviour is the HTTP status, which is all a real scraper sees. Ground truth
 * is read from the X-Lab-Triggered header that the lab target adds.
 */
import axios from "axios";
import { existsSync } from "node:fs";

export interface Result {
  status: number;
  triggered: string[];
  latencyMs: number;
  error?: string;
  body: string;
}

export interface Client {
  readonly name: string;
  readonly slow: boolean; // browsers: fewer runs by default
  fetch(url: string): Promise<Result>;
  close(): Promise<void>;
}

const triggers = (v: string | null | undefined) => (v ?? "").split(",").filter(Boolean);
const fail = (t0: number, e: unknown): Result => ({ status: 0, triggered: [], latencyMs: performance.now() - t0, error: String(e).slice(0, 300), body: "" });

/** A full Chrome navigation header set, in the order Chrome sends it over HTTP/1.1. */
export const CHROME_HEADERS: Record<string, string> = {
  "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Linux"',
  "upgrade-insecure-requests": "1",
  "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "sec-fetch-site": "none",
  "sec-fetch-mode": "navigate",
  "sec-fetch-user": "?1",
  "sec-fetch-dest": "document",
  "accept-encoding": "gzip, deflate",
  "accept-language": "en-US,en;q=0.9",
};

// ------------------------------------------------------------------ HTTP clients
class NodeFetchClient implements Client {
  readonly slow = false;
  constructor(readonly name = "fetch", private headers: Record<string, string> = {}) {}
  async fetch(url: string): Promise<Result> {
    const t0 = performance.now();
    try {
      const r = await globalThis.fetch(url, { headers: this.headers, redirect: "manual" });
      return { status: r.status, triggered: triggers(r.headers.get("x-lab-triggered")), latencyMs: performance.now() - t0, body: await r.text() };
    } catch (e) { return fail(t0, e); }
  }
  async close() {}
}

/** Node's built-in fetch with a complete, correctly ordered Chrome header set. */
class NodeFetchSpoofedClient extends NodeFetchClient {
  constructor() { super("fetch_spoofed", CHROME_HEADERS); }
}

class AxiosClient implements Client {
  readonly name = "axios";
  readonly slow = false;
  async fetch(url: string): Promise<Result> {
    const t0 = performance.now();
    try {
      const r = await axios.get<string>(url, { validateStatus: () => true, responseType: "text", maxRedirects: 0 });
      return { status: r.status, triggered: triggers(r.headers["x-lab-triggered"] as string), latencyMs: performance.now() - t0, body: String(r.data) };
    } catch (e) { return fail(t0, e); }
  }
  async close() {}
}

/** impit: Rust HTTP client that impersonates a browser's TLS/HTTP2 fingerprint and header set. */
class ImpitClient implements Client {
  readonly name = "impit";
  readonly slow = false;
  private impit: import("impit").Impit | null = null;
  async fetch(url: string): Promise<Result> {
    const t0 = performance.now();
    try {
      if (!this.impit) {
        const { Impit } = await import("impit");
        this.impit = new Impit({ browser: "chrome" });
      }
      const r = await this.impit.fetch(url);
      return { status: r.status, triggered: triggers(r.headers.get("x-lab-triggered")), latencyMs: performance.now() - t0, body: await r.text() };
    } catch (e) { return fail(t0, e); }
  }
  async close() {}
}

// ------------------------------------------------------------- browser clients
interface RespLike { status(): number; headers(): Record<string, string>; request(): { isNavigationRequest(): boolean } }
interface PageLike {
  goto(url: string, opts: { waitUntil: "load"; timeout: number }): Promise<unknown>;
  evaluate<T>(fn: () => T): Promise<T>;
  on(event: "response", cb: (r: RespLike) => void): unknown;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Navigate, let the JS challenge set its cookie and reload, then read the final verdict. */
async function navigate(page: PageLike, url: string): Promise<Result> {
  const t0 = performance.now();
  let status = 0;
  let trig = "";
  page.on("response", (r) => {
    if (r.request().isNavigationRequest()) { status = r.status(); trig = r.headers()["x-lab-triggered"] ?? ""; }
  });
  try {
    await page.goto(url, { waitUntil: "load", timeout: 20_000 });
    for (let i = 0; i < 20; i++) {
      const txt = await page.evaluate(() => document.body?.innerText?.trim() ?? "").catch(() => "");
      if (txt.startsWith("{")) break; // JSON verdict means the challenge round-trip finished
      await sleep(250);
    }
    const body = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    return { status, triggered: triggers(trig), latencyMs: performance.now() - t0, body };
  } catch (e) { return fail(t0, e); }
}

class PlaywrightClient implements Client {
  readonly name = "playwright";
  readonly slow = true;
  private browser: import("playwright").Browser | null = null;
  async fetch(url: string): Promise<Result> {
    const { chromium } = await import("playwright");
    this.browser ??= await chromium.launch({ headless: true });
    const ctx = await this.browser.newContext();
    try { return await navigate((await ctx.newPage()) as unknown as PageLike, url); } finally { await ctx.close(); }
  }
  async close() { await this.browser?.close(); }
}

class PuppeteerClient implements Client {
  readonly name = "puppeteer";
  readonly slow = true;
  private browser: import("puppeteer-core").Browser | null = null;
  private async executablePath(): Promise<string> {
    const env = process.env.CHROME_PATH;
    if (env) return env;
    for (const p of ["/opt/google/chrome/chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"]) if (existsSync(p)) return p;
    const { chromium } = await import("playwright"); // fall back to Playwright's Chromium download
    return chromium.executablePath();
  }
  async fetch(url: string): Promise<Result> {
    const puppeteer = (await import("puppeteer-core")).default;
    this.browser ??= await puppeteer.launch({ headless: true, executablePath: await this.executablePath(), args: ["--no-sandbox"] });
    const ctx = await this.browser.createBrowserContext();
    try { return await navigate((await ctx.newPage()) as unknown as PageLike, url); } finally { await ctx.close(); }
  }
  async close() { await this.browser?.close(); }
}

/** Camoufox (patched Firefox). Needs its browser binary: `npx camoufox-js fetch`. */
class CamoufoxClient implements Client {
  readonly name = "camoufox";
  readonly slow = true;
  private browser: import("playwright").Browser | null = null;
  async fetch(url: string): Promise<Result> {
    const t0 = performance.now();
    try {
      const { Camoufox } = await import("camoufox-js");
      this.browser ??= (await Camoufox({ headless: true })) as unknown as import("playwright").Browser;
      const ctx = await this.browser.newContext();
      try { return await navigate((await ctx.newPage()) as unknown as PageLike, url); } finally { await ctx.close(); }
    } catch (e) { return fail(t0, e); }
  }
  async close() { await this.browser?.close(); }
}

export const REGISTRY: Record<string, () => Client> = {
  fetch: () => new NodeFetchClient(),
  axios: () => new AxiosClient(),
  fetch_spoofed: () => new NodeFetchSpoofedClient(),
  impit: () => new ImpitClient(),
  playwright: () => new PlaywrightClient(),
  puppeteer: () => new PuppeteerClient(),
  camoufox: () => new CamoufoxClient(),
};
export const makeClient = (name: string): Client => {
  const f = REGISTRY[name];
  if (!f) throw new Error(`unknown client '${name}' (have: ${Object.keys(REGISTRY).join(", ")})`);
  return f();
};
