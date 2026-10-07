Batch `20261007094821-062b`. Cell = observed outcome (blocked/runs). `*` = prediction was wrong. ERROR = client failed to run.

| client | ua_blocklist | header_consistency | header_order | cookie_challenge | webdriver_check | headless_signals | all |
|---|---|---|---|---|---|---|---|
| fetch | BLOCK (5/5) | pass (0/5) | pass (0/5) | BLOCK (5/5) | BLOCK (5/5) | BLOCK (5/5) | BLOCK (5/5) |
| axios | BLOCK (5/5) | pass (0/5) | pass (0/5) | BLOCK (5/5) | BLOCK (5/5) | BLOCK (5/5) | BLOCK (5/5) |
| fetch_spoofed | pass (0/5) | BLOCK (5/5) * | pass (0/5) | BLOCK (5/5) | BLOCK (5/5) | BLOCK (5/5) | BLOCK (5/5) |
| impit | pass (0/5) | pass (0/5) | pass (0/5) | BLOCK (5/5) | BLOCK (5/5) | BLOCK (5/5) | BLOCK (5/5) |
| playwright | BLOCK (3/3) | BLOCK (3/3) | pass (0/3) | pass (0/3) | BLOCK (3/3) | BLOCK (3/3) | BLOCK (3/3) |
| puppeteer | BLOCK (3/3) | pass (0/3) | BLOCK (3/3) * | pass (0/3) | BLOCK (3/3) | pass (0/3) | BLOCK (3/3) |
| camoufox | pass (0/3) | pass (0/3) | pass (0/3) | pass (0/3) | pass (0/3) | pass (0/3) | pass (0/3) |

Ground truth: which rules actually fired with ALL rules enabled

- **fetch**: ["cookie_challenge","headless_signals","ua_blocklist","webdriver_check"]
- **axios**: ["cookie_challenge","headless_signals","ua_blocklist","webdriver_check"]
- **fetch_spoofed**: ["cookie_challenge","header_consistency","headless_signals","webdriver_check"]
- **impit**: ["cookie_challenge","headless_signals","webdriver_check"]
- **playwright**: ["cookie_challenge","header_consistency","headless_signals","ua_blocklist","webdriver_check"]
- **puppeteer**: ["cookie_challenge","header_order","headless_signals","ua_blocklist","webdriver_check"]
- **camoufox**: []

Rejected hypotheses: 2

- fetch_spoofed / header_consistency: fetch_spoofed is allowed with only 'header_consistency' enabled (a complete, correctly ordered Chrome header set should satisfy every static rule; still no JS) -> blocked 5/5, fired: ["header_consistency"]
- puppeteer / header_order: puppeteer is allowed with only 'header_order' enabled (HeadlessChrome UA and webdriver flag; I expect it to send Accept-Language) -> blocked 3/3, fired: ["header_order"]
