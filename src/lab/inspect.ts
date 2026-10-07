import { chromium } from "playwright";
import { Camoufox } from "camoufox-js";

const SIGNALS = `({
  webdriver: navigator.webdriver,
  ua: navigator.userAgent,
  plugins: navigator.plugins.length,
  languages: navigator.languages,
  hasChromeObj: typeof window.chrome !== "undefined",
  tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  screen: [screen.width, screen.height]
})`;

async function inspect(name: string, browser: any) {
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto("http://localhost:8000/echo");

    const body = await page.innerText("body");
    const data = JSON.parse(body);

    const headers = data.headers.map((h: string[]) => h[0]);

    console.log(name, {
      headerOrder: headers.join(" > "),
      ...(await page.evaluate(SIGNALS)),
    });
  } finally {
    await browser.close();
  }
}

await inspect("playwright", await chromium.launch());
await inspect("camoufox", await Camoufox({ headless: true }));
