# bot-lab: a hypothesis-driven bot-detection lab (TypeScript)

A small, legal, self-contained environment for posing anti-bot questions and getting repeatable answers.
A **target** server has toggleable detection rules; several **clients** (plain HTTP, TLS-impersonating, real
browsers) hit it; an **experiment runner** states a prediction first, runs N trials, stores everything in
Postgres (SQLite locally), and reports where reality disagreed.

It only attacks a server I wrote. Nothing here targets real sites.

## Layout

| path | what |
|---|---|
| `src/target/app.ts` | `node:http` target. `/protected?rules=a,b` evaluates rules per request; ground truth is returned in `X-Lab-Triggered`. Reads `req.rawHeaders` to see true wire order |
| `src/lab/clients.ts` | Node `fetch`, `fetch_spoofed`, axios, impit (browser TLS/HTTP2 impersonation), Playwright, Puppeteer, Camoufox |
| `src/lab/predictions.ts` | predictions written **before** running: which client should trip which rule, and why |
| `src/lab/experiments.ts` | client x rule matrix; each cell is one experiment row (hypothesis, predicted, runs, blocked, conclusion) |
| `src/lab/rate.ts`, `proxies.ts` | exit rotation vs rate limiting; Redis-backed exit cooldowns |
| `src/lab/store.ts` | Postgres via `DATABASE_URL`, otherwise SQLite (`node:sqlite`) |
| `docker-compose.yml`, `k8s/lab.yaml` | compose stack; kind manifests (Deployments, StatefulSet, runner as a Job) |

Rules: `ua_blocklist`, `header_consistency`, `header_order`, `cookie_challenge` (JS must set a signed cookie),
`webdriver_check` (JS reports `navigator.webdriver`), `headless_signals` (JS reports plugins, `window.chrome`,
languages and platform, cross-checked against the UA and `Accept-Language`), `rate_limit` (per IP, Redis), `tls_fingerprint` (needs a
fronting proxy that injects a JA3 header; not exercised yet).

## Run it

```bash
npm install
TRUST_XFF=1 RATE_LIMIT=10 RATE_WINDOW=3 npm run target &
npm run lab -- matrix --clients fetch,axios,fetch_spoofed,impit,playwright,puppeteer
npm run lab -- rate --limit 10 --window 3     # simulated exit IPs via X-Forwarded-For
npm run lab -- report
npm test && npm run typecheck
```

Playwright needs its browser (`npx playwright install chromium`); Puppeteer uses `CHROME_PATH` or falls back to
Playwright's Chromium; Camoufox needs `npx camoufox-js fetch`.
Docker: `docker compose up -d --build target postgres redis proxy1 proxy2 proxy3`, then
`docker compose run --rm runner matrix`. Kubernetes: commands are at the top of `k8s/lab.yaml`.

## What has and hasn't been verified

Verified by running it (Node 22, Chromium via Playwright 1.56): the target, 17 unit tests, `tsc --noEmit`, the matrix
for fetch, axios, fetch_spoofed, impit, Playwright and Puppeteer, the rate-limit rotation experiment, SQLite storage.
Camoufox ran on the author's machine (all rules passed) but not in the sandbox this README's matrix was generated in;
run the full matrix yourself and replace `results/matrix.md` with your own batch.

**Written but not run:** Postgres, Redis
(target rate limiter and exit cooldowns), real proxies via tinyproxy, the `probe` command (tls.peet.ws), the Docker
images, and the kind deployment. Run these and fix what breaks before listing them on a CV.

## Results (`results/matrix.md`)

| client | ua_blocklist | header_consistency | header_order | cookie_challenge | webdriver_check | headless_signals |
|---|---|---|---|---|---|---|
| fetch, axios | BLOCK | pass | pass | BLOCK | BLOCK | BLOCK |
| fetch_spoofed | pass | **BLOCK** (predicted pass) | pass | BLOCK | BLOCK | BLOCK |
| impit | pass | pass | pass | BLOCK | BLOCK | BLOCK |
| playwright | BLOCK | BLOCK | pass | pass | BLOCK | BLOCK |
| puppeteer | BLOCK | pass | **BLOCK** (predicted pass) | pass | BLOCK | pass |
| camoufox | pass | pass | pass | pass | pass | pass (measured on the author's machine) |

Rate limiting (10 per 3 s): 1 exit gave 10 successes of 40 attempts, 3 exits gave 30 of 40, as predicted.

## Dead ends and what I learned

1. **A broken client looked like a detection result.** Camoufox failed to start, and the first matrix counted those
   errors as blocks: 8 "rejected" hypotheses that meant nothing. Errored runs are now excluded, the cell shows
   `ERROR`, and `tests/store.test.ts` pins that behaviour.
2. **Node's `fetch` cannot pose as a navigation.** `fetch_spoofed` sends a full, correctly ordered Chrome header
   set, but undici overwrites `sec-fetch-mode: navigate` with `cors`, so `header_consistency` catches it. Header
   copying is not enough when the runtime owns some headers. I looked at the wire headers to find this instead of
   guessing.
3. **Puppeteer sends `Accept-Language` early in the header list**, where real Chrome sends it last, so it fails
   `header_order`. Playwright instead omits `Accept-Language` entirely. Two headless tools, two different tells.
4. **impit passes every static rule** (headers, order, fetch metadata) and is stopped only by the JS rules, which is
   the interesting boundary: past this point you need a JS engine, not better headers.
5. **Chrome omits client hints on non-localhost http origins**, so the same rule would falsely block real Chrome
   inside docker/k8s. `LAB_REQUIRE_CLIENT_HINTS=0` is set there.

## Experiment: `headless_signals`

**Check 1 (what the browsers actually report), measured on the author's machine:**

| | Playwright (Chromium) | Camoufox (Firefox) |
|---|---|---|
| `navigator.webdriver` | true | false |
| `navigator.plugins.length` | 0 | 5 |
| `window.chrome` | missing | missing (Firefox; expected) |
| `navigator.languages` | `['en-GB']`, but **no `Accept-Language` header sent** | `['en-US','en']`, matches its header |
| header order | Chrome-style, no `accept-language` | Firefox-style, `accept-language` third |
| screen | 1280x720 | 2176x1224 |

**Prediction, written before the rule existed** (`predictions.ts`): HTTP clients BLOCK (no JS), Playwright BLOCK,
Camoufox PASS, Puppeteer PASS (stated as my least confident call).

**Result:** every prediction held, so this experiment produced no wrong prediction and I am not claiming a surprise.
What it did give is verified reasons. Playwright was blocked for three independent signals: empty plugins, no
`window.chrome`, and `navigator.languages` set with no `Accept-Language` header. Puppeteer reported 5 plugins and
`window.chrome` present, so it passed.

**Confound I have not resolved:** in my sandbox Playwright launched its bundled headless shell, while Puppeteer
launched a full Chrome binary. The difference may be the binary (old vs new headless), not the library. A fair test
points both libraries at the same executable.

Screen size and timezone are recorded by the challenge page but not used to block: 1280x720 is just Playwright's
default viewport, and a rule on it would overfit to this one tool.

Caveat: the rules were tuned after an earlier Python prototype of this lab, and I added the `sec-fetch-mode` check
before running this version. The matrix shows the harness catches weak assumptions, not that the rules are realistic.

## Limits and next steps

The target is simple on purpose. The cookie challenge hands the token to anything that parses the page; real systems
obfuscate and bind it to browser state. The signals cookie is not
bound to anything, so a client that can set cookies can forge it; real systems sign or encrypt the payload. Next:
run Playwright and Puppeteer against the same Chromium binary to resolve the confound above, serve over HTTPS and
log JA3/JA4, and add a client that solves the challenge without a browser.
