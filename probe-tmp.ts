import { makeClient } from "./src/lab/clients.js";
for (const n of ["fetch_spoofed", "puppeteer", "playwright"]) {
  const c = makeClient(n);
  const r = await c.fetch("http://localhost:8000/echo");
  let body = r.body;
  try { const d = JSON.parse(body); console.log(n, d.headers.map((h: string[]) => h[0] + (["sec-fetch-mode","accept-language","user-agent"].includes(h[0]!) ? "=" + String(h[1]).slice(0, 28) : "")).join(" | ")); } catch { console.log(n, "unparsed", body.slice(0, 120), r.error); }
  await c.close();
}
