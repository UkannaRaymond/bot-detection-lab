import type { AddressInfo } from "node:net";
import { request, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _tokenFor, ALL_RULES, createTarget } from "../src/target/app.js";
import { assertTargetReady, missingRules } from "../src/lab/preflight.js";

const CHROME_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const SECRET = "test-secret";
let server: Server;
let port: number;

beforeAll(async () => {
  server = createTarget({ secret: SECRET, rateLimit: 3, rateWindowS: 60 });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** Raw http.request keeps header insertion order, so we control the wire order exactly. */
function get(path: string, headers: Record<string, string>) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

const fullChrome = (): Record<string, string> => ({
  "sec-ch-ua": '"Chromium";v="124"', "user-agent": CHROME_UA, accept: "text/html",
  "sec-fetch-site": "none", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document",
  "accept-encoding": "gzip", "accept-language": "en-US",
});

describe("target rules", () => {
  it("allows everything when no rules are enabled", async () => {
    expect((await get("/protected?rules=", { "user-agent": "curl/8" })).status).toBe(200);
  });

  it("ua_blocklist blocks bot user agents, including bare Node", async () => {
    const r = await get("/protected?rules=ua_blocklist", { "user-agent": "python-httpx/0.28" });
    expect(r.status).toBe(403);
    expect(r.headers["x-lab-triggered"]).toBe("ua_blocklist");
    expect((await get("/protected?rules=ua_blocklist", { "user-agent": "node" })).status).toBe(403);
  });

  it("header_consistency accepts complete Chrome headers and flags a missing Accept-Language", async () => {
    expect((await get("/protected?rules=header_consistency", fullChrome())).status).toBe(200);
    const h = fullChrome();
    delete h["accept-language"];
    expect((await get("/protected?rules=header_consistency", h)).status).toBe(403);
  });

  it("header_consistency flags script-initiated fetch metadata (sec-fetch-mode: cors)", async () => {
    const r = await get("/protected?rules=header_consistency", { ...fullChrome(), "sec-fetch-mode": "cors" });
    expect(r.status).toBe(403);
  });

  it("header_order detects the wrong order", async () => {
    const h = fullChrome();
    const swapped = { "user-agent": h["user-agent"]!, "sec-ch-ua": h["sec-ch-ua"]!, accept: h.accept!, "accept-encoding": "gzip", "accept-language": "en" };
    expect((await get("/protected?rules=header_order", swapped)).status).toBe(403);
    expect((await get("/protected?rules=header_order", h)).status).toBe(200);
  });

  it("cookie_challenge serves JS, then accepts a valid clearance cookie", async () => {
    const r = await get("/protected?rules=cookie_challenge", fullChrome());
    expect(r.status).toBe(403);
    expect(r.body).toContain("document.cookie");
    const token = _tokenFor(SECRET, "127.0.0.1", CHROME_UA);
    const ok = await get("/protected?rules=cookie_challenge", { ...fullChrome(), cookie: `__lab_clr=${token}.0` });
    expect(ok.status).toBe(200);
  });

  it("webdriver_check blocks when the page reported navigator.webdriver", async () => {
    const token = _tokenFor(SECRET, "127.0.0.1", CHROME_UA);
    const r = await get("/protected?rules=webdriver_check", { ...fullChrome(), cookie: `__lab_clr=${token}.1` });
    expect(r.status).toBe(403);
    expect(r.headers["x-lab-triggered"]).toBe("webdriver_check");
  });

  it("rate_limit returns 429 after the limit", async () => {
    const h = { "user-agent": "x", "x-forwarded-for": "1.2.3.4" };
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await get("/protected?rules=rate_limit", h)).status);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
  });

  describe("headless_signals", () => {
    const REAL = { p: 5, c: 1, l: ["en-US", "en"], pl: "Linux x86_64", w: 1920, h: 1080, tz: "UTC" };
    const cookies = (sig: object, webdriver = "0") => {
      const token = _tokenFor(SECRET, "127.0.0.1", CHROME_UA);
      return `__lab_clr=${token}.${webdriver}; __lab_sig=${encodeURIComponent(JSON.stringify(sig))}`;
    };
    const run = (sig: object, extra: Record<string, string> = {}) =>
      get("/protected?rules=headless_signals", { ...fullChrome(), "accept-language": "en-US,en;q=0.9", ...extra, cookie: cookies(sig) });

    it("serves the JS challenge when nothing has been reported yet", async () => {
      const r = await get("/protected?rules=headless_signals", fullChrome());
      expect(r.status).toBe(403);
      expect(r.body).toContain("navigator.plugins");
    });

    it("passes a realistic Chrome signal set", async () => {
      expect((await run(REAL)).status).toBe(200);
    });

    it("flags empty plugins and a missing window.chrome on a Chrome UA", async () => {
      const r = await run({ ...REAL, p: 0, c: 0 });
      expect(r.status).toBe(403);
      expect(r.body).toContain("navigator.plugins is empty");
      expect(r.body).toContain("window.chrome is missing");
    });

    it("flags navigator.languages with no Accept-Language header", async () => {
      const h = { ...fullChrome(), cookie: cookies(REAL) };
      delete (h as Record<string, string>)["accept-language"];
      const r = await get("/protected?rules=headless_signals", h);
      expect(r.status).toBe(403);
      expect(r.body).toContain("no Accept-Language header");
    });

    it("flags an Accept-Language that disagrees with navigator.languages", async () => {
      const r = await run({ ...REAL, l: ["fr-FR"] });
      expect(r.status).toBe(403);
      expect(r.body).toContain("navigator.languages[0]");
    });

    it("flags a UA/platform mismatch", async () => {
      const r = await run({ ...REAL, pl: "Win32" });
      expect(r.status).toBe(403);
      expect(r.body).toContain("navigator.platform");
    });

    it("blocks a valid clearance cookie that arrives without any signals", async () => {
      const token = _tokenFor(SECRET, "127.0.0.1", CHROME_UA);
      const r = await get("/protected?rules=headless_signals", { ...fullChrome(), cookie: `__lab_clr=${token}.0` });
      expect(r.status).toBe(403);
      expect(r.body).toContain("signals cookie missing");
    });
  });

  describe("preflight", () => {
    it("lists the rules it supports on /health", async () => {
      const r = await get("/health", {});
      expect(JSON.parse(r.body).rules).toEqual([...ALL_RULES]);
    });

    it("detects an old target that does not report its rules", () => {
      expect(missingRules({ ok: true }, ["ua_blocklist", "headless_signals"])).toEqual(["ua_blocklist", "headless_signals"]);
      expect(missingRules({ ok: true, rules: ["ua_blocklist"] }, ["ua_blocklist", "headless_signals"])).toEqual(["headless_signals"]);
    });

    it("accepts the current target and rejects an unreachable one", async () => {
      await expect(assertTargetReady(`http://127.0.0.1:${port}`, ALL_RULES)).resolves.toBeUndefined();
      await expect(assertTargetReady("http://127.0.0.1:1", ["ua_blocklist"])).rejects.toThrow(/Cannot reach/);
    });
  });
});
