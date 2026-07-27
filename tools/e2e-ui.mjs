import { chromium } from "playwright-core";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const [portArgument, action = "snapshot", ...arguments_] = process.argv.slice(2);
const port = Number(portArgument);
if (!Number.isInteger(port)) {
  throw new Error("First argument must be the Electron debugging port");
}

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const pages = browser.contexts().flatMap((context) => context.pages());
const page = pages.find((candidate) => candidate.url().includes("index.html")) ?? pages[0];
if (!page) {
  throw new Error("No Electron renderer page found");
}

try {
  if (action === "snapshot") {
    const screenshotPath = arguments_[0] ? resolve(arguments_[0]) : null;
    if (screenshotPath) {
      await mkdir(dirname(screenshotPath), { recursive: true });
      await page.screenshot({ path: screenshotPath, fullPage: true });
    }
    const interactive = await page
      .locator("button, input, select, textarea, [role=button], [contenteditable=true]")
      .evaluateAll((elements) =>
        elements.map((element, index) => ({
          index,
          tag: element.tagName,
          text: element.textContent?.trim().slice(0, 200) ?? "",
          ariaLabel: element.getAttribute("aria-label"),
          placeholder: element.getAttribute("placeholder"),
          title: element.getAttribute("title"),
          type: element.getAttribute("type"),
          classes: element.getAttribute("class"),
        })),
      );
    console.log(
      JSON.stringify(
        {
          url: page.url(),
          title: await page.title(),
          bodyText: (await page.locator("body").innerText()).slice(0, 30_000),
          interactive,
          screenshotPath,
        },
        null,
        2,
      ),
    );
  } else if (action === "click-text") {
    const text = required(arguments_[0], "click text");
    await page.getByText(text, { exact: true }).last().click();
    console.log(JSON.stringify({ clicked: text, url: page.url() }));
  } else if (action === "click-selector") {
    const selector = required(arguments_[0], "selector");
    const index = Number(arguments_[1] ?? "0");
    await page.locator(selector).nth(index).click();
    console.log(JSON.stringify({ clicked: selector, index, url: page.url() }));
  } else if (action === "fill-selector") {
    const selector = required(arguments_[0], "selector");
    const value = required(arguments_[1], "value");
    const index = Number(arguments_[2] ?? "0");
    await page.locator(selector).nth(index).fill(value);
    console.log(JSON.stringify({ filled: selector, index, url: page.url() }));
  } else if (action === "press") {
    const key = required(arguments_[0], "key");
    await page.keyboard.press(key);
    console.log(JSON.stringify({ pressed: key, url: page.url() }));
  } else if (action === "login") {
    const credentialsPath = resolve(required(arguments_[0], "credentials path"));
    const credentials = JSON.parse(await readFile(credentialsPath, "utf8"));
    await page.locator('input[placeholder="Your email..."]').fill(credentials.email);
    await page.locator('input[placeholder="Your password..."]').fill(credentials.password);
    await page.getByText("Login", { exact: true }).last().click();
    console.log(JSON.stringify({ loginSubmitted: true, url: page.url() }));
  } else if (action === "create-vault") {
    const credentialsPath = resolve(required(arguments_[0], "credentials path"));
    const credentials = JSON.parse(await readFile(credentialsPath, "utf8"));
    await page.locator('input[placeholder="My awesome vault"]').fill("E2E Vault");
    const region = page.locator("select").filter({ hasText: "Blackglass Server" });
    await region.selectOption({ label: "Blackglass Server" });
    await page.locator('input[placeholder="Your password"]').fill(credentials.e2ePassword);
    await page.getByText("Create", { exact: true }).last().click();
    console.log(JSON.stringify({ vaultCreateSubmitted: true, url: page.url() }));
  } else if (action === "unlock-vault") {
    const credentialsPath = resolve(required(arguments_[0], "credentials path"));
    const credentials = JSON.parse(await readFile(credentialsPath, "utf8"));
    await page.locator('input[placeholder="Your password"]').last().fill(credentials.e2ePassword);
    await page.getByText("Unlock vault", { exact: true }).last().click();
    console.log(JSON.stringify({ vaultUnlockSubmitted: true, url: page.url() }));
  } else {
    throw new Error(`Unknown action: ${action}`);
  }
} finally {
  await browser.close();
}

function required(value, label) {
  if (!value) {
    throw new Error(`Missing ${label}`);
  }
  return value;
}
