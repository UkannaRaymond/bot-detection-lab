/**
 * Written BEFORE running anything: which rules do I expect each client to trip, and why?
 * The interesting output of the lab is every cell where reality disagrees with this file.
 *
 * Note: the playwright entry reuses what I learned in an earlier Python version of this lab
 * (headless Chromium sends no Accept-Language). Everything else is a fresh guess.
 */
export const RULES = ["ua_blocklist", "header_consistency", "header_order", "cookie_challenge", "webdriver_check"] as const;
const NO_JS = ["cookie_challenge", "webdriver_check"];

export const PREDICTIONS: Record<string, { blocked: string[]; why: string }> = {
  fetch: { blocked: ["ua_blocklist", ...NO_JS], why: "bare 'node' user-agent, and no JS engine to earn the clearance cookie" },
  axios: { blocked: ["ua_blocklist", ...NO_JS], why: "axios/x.y UA is on the blocklist; no JS engine" },
  fetch_spoofed: { blocked: NO_JS, why: "a complete, correctly ordered Chrome header set should satisfy every static rule; still no JS" },
  impit: { blocked: NO_JS, why: "impersonates Chrome's headers and order; still no JS engine" },
  playwright: { blocked: ["ua_blocklist", "header_consistency", "webdriver_check"], why: "HeadlessChrome UA, no Accept-Language, navigator.webdriver is true" },
  puppeteer: { blocked: ["ua_blocklist", "webdriver_check"], why: "HeadlessChrome UA and webdriver flag; I expect it to send Accept-Language" },
  camoufox: { blocked: [], why: "patched Firefox: real UA, webdriver false, Firefox header order" },
};

export const predictedBlocked = (client: string, rule: string): boolean => {
  const p = PREDICTIONS[client];
  if (!p) throw new Error(`no prediction for client '${client}'`);
  return rule === "all" ? p.blocked.length > 0 : p.blocked.includes(rule);
};
