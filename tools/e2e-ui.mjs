import { chromium } from "#release-playwright-core";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { connectOverBunNativeCDP } from "./bun-native-cdp.ts";
import { verifyLiveClientLaunchBinding } from "./e2e-client.ts";
import { E2E_UI_EVIDENCE_SCHEMA_VERSION } from "./e2e-ui-evidence.ts";

const [portArgument, action = "snapshot", ...arguments_] = process.argv.slice(2);
const port = Number(portArgument);
if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
  throw new Error("First argument must be an Electron debugging port from 1024 to 65535");
}

const launch = await findBoundLaunchIdentity(port);
const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(async (response) => {
  if (!response.ok) throw new Error(`Electron target discovery failed: ${response.status}`);
  return response.json();
});
const rendererTargets = targets.filter(
  (target) => target.type === "page" && target.url?.includes("index.html"),
);
if (action !== "list-pages" && rendererTargets.length !== 1) {
  throw new Error(
    `Expected exactly one bound Electron renderer target, found ${rendererTargets.length}`,
  );
}
if (
  action !== "list-pages" &&
  (rendererTargets[0]?.id !== launch.identity.debugTargetId ||
    rendererTargets[0]?.url !== launch.identity.debugTargetUrl)
) {
  throw new Error("Live renderer target does not match the bound launch identity");
}
const browser = await connectOverBunNativeCDP(chromium, port);
const pages = browser.contexts().flatMap((context) => context.pages());
const rendererPages = pages.filter((candidate) => candidate.url().includes("index.html"));
const visibleRendererPages = [];
for (const candidate of rendererPages) {
  if ((await candidate.evaluate(() => document.visibilityState)) === "visible") {
    visibleRendererPages.push(candidate);
  }
}
const boundPage =
  visibleRendererPages.length === 1
    ? visibleRendererPages[0]
    : rendererPages.length === 1
      ? rendererPages[0]
      : undefined;
if (action !== "list-pages" && !boundPage) {
  throw new Error(
    `Expected exactly one Electron renderer for debugging port ${port}; ` +
      `found ${rendererPages.length} renderer pages (${visibleRendererPages.length} visible)`,
  );
}
if (boundPage) {
  await boundPage.waitForFunction(() => globalThis.app?.vault?.adapter?.basePath, null, {
    timeout: 15_000,
  });
  const rendererVault = await boundPage.evaluate(
    () => globalThis.app.vault.adapter.basePath,
  );
  if (resolve(rendererVault) !== launch.identity.vaultPath) {
    await browser.close();
    throw new Error(`Electron renderer vault does not match launch identity: ${rendererVault}`);
  }
}
const auxiliaryPages = [];
for (const candidate of pages) {
  if (
    candidate !== boundPage &&
    candidate.url() === "about:blank" &&
    /^Settings(?:\s|\s+-)/u.test(await candidate.title())
  ) {
    auxiliaryPages.push(candidate);
  }
}
if (auxiliaryPages.length > 1) {
  throw new Error(
    `Expected at most one Settings renderer for debugging port ${port}; found ${auxiliaryPages.length}`,
  );
}
const page = usesForegroundPage(action) && auxiliaryPages.length === 1
  ? auxiliaryPages[0]
  : boundPage;

try {
  if (action === "list-pages") {
    const pageStates = [];
    for (let index = 0; index < pages.length; index += 1) {
      const candidate = pages[index];
      pageStates.push({
        index,
        url: candidate.url(),
        title: await candidate.title(),
        visible: await candidate.evaluate(() => document.visibilityState),
        bodyText: (await candidate.locator("body").innerText()).slice(0, 3000),
        workers: candidate.workers().map((worker) => worker.url()),
      });
    }
    console.log(JSON.stringify({ pages: pageStates }, null, 2));
  } else if (action === "sync-structure") {
    const state = await page.evaluate(() => {
      const plugin = globalThis.app?.internalPlugins?.getPluginById?.("sync");
      const seen = new WeakSet();
      const describe = (value, depth = 0) => {
        if (value === null || value === undefined) return value;
        if (typeof value === "boolean" || typeof value === "number") return value;
        if (typeof value === "string") return `[string:${value.length}]`;
        if (typeof value === "function") return `[function:${value.name || "anonymous"}]`;
        if (typeof value !== "object") return `[${typeof value}]`;
        if (seen.has(value)) return "[circular]";
        seen.add(value);
        if (Array.isArray(value)) return { type: "array", length: value.length };
        const prototype = Object.getPrototypeOf(value);
        const prototypeMethods = prototype
          ? Object.getOwnPropertyNames(prototype).filter(
              (key) => key !== "constructor" && typeof prototype[key] === "function",
            )
          : [];
        if (depth >= 3) {
          return { type: value.constructor?.name ?? "object", keys: Object.keys(value).sort(), prototypeMethods };
        }
        const properties = {};
        for (const key of Object.keys(value).sort()) {
          const lower = key.toLowerCase();
          if (/token|password|secret|keyhash|salt|email|credential/u.test(lower)) {
            properties[key] = "[redacted]";
          } else {
            try {
              properties[key] = describe(value[key], depth + 1);
            } catch (error) {
              properties[key] = `[unreadable:${error instanceof Error ? error.name : "error"}]`;
            }
          }
        }
        return { type: value.constructor?.name ?? "object", prototypeMethods, properties };
      };
      return describe(plugin);
    });
    console.log(JSON.stringify({ state, url: page.url() }, null, 2));
  } else if (action === "sync-status") {
    const state = await page.evaluate(() => {
      const plugin = globalThis.app?.internalPlugins?.getPluginById?.("sync");
      const seen = new WeakSet();
      const matches = [];
      const skipped = new Set([
        "app",
        "plugin",
        "vault",
        "settingTab",
        "statusBarEl",
        "statusIconEl",
        "fileMap",
        "localFiles",
        "serverFiles",
        "skippedFiles",
      ]);
      const redact = (key, value) => {
        if (/token|password|secret|keyhash|salt|email|credential/u.test(key.toLowerCase())) {
          return "[redacted]";
        }
        if (typeof value === "string") {
          return /status|host|url|region|error|message|name/u.test(key.toLowerCase())
            ? value.slice(0, 1000)
            : `[string:${value.length}]`;
        }
        if (value === null || ["boolean", "number", "undefined"].includes(typeof value)) {
          return value;
        }
        if (Array.isArray(value)) return `[array:${value.length}]`;
        return `[${value?.constructor?.name ?? typeof value}]`;
      };
      const visit = (value, path, depth) => {
        if (!value || typeof value !== "object" || seen.has(value) || depth > 6) return;
        seen.add(value);
        const keys = Object.keys(value);
        if (keys.includes("syncStatus") || keys.includes("server") || keys.includes("ready")) {
          const fields = {};
          for (const key of keys) {
            if (
              /status|host|url|region|error|message|ready|server|syncing|pause|timer|version|userid|vaultname|vaultid/u.test(
                key.toLowerCase(),
              )
            ) {
              try {
                fields[key] = redact(key, value[key]);
              } catch {
                fields[key] = "[unreadable]";
              }
            }
          }
          const prototype = Object.getPrototypeOf(value);
          matches.push({
            path,
            type: value.constructor?.name ?? "object",
            fields,
            methods: prototype
              ? Object.getOwnPropertyNames(prototype).filter(
                  (key) => key !== "constructor" && typeof prototype[key] === "function",
                )
              : [],
          });
        }
        for (const key of keys) {
          if (skipped.has(key) || /token|password|secret|keyhash|salt|credential/u.test(key.toLowerCase())) {
            continue;
          }
          let child;
          try {
            child = value[key];
          } catch {
            continue;
          }
          visit(child, `${path}.${key}`, depth + 1);
        }
      };
      visit(plugin, "syncPlugin", 0);
      return { pluginKeys: Object.keys(plugin ?? {}).sort(), matches };
    });
    console.log(JSON.stringify({ state, url: page.url() }, null, 2));
  } else if (action === "sync-method") {
    const methodName = required(arguments_[0], "Sync method name");
    const source = await page.evaluate((name) => {
      const instance = globalThis.app?.internalPlugins?.getPluginById?.("sync")?.instance;
      const method = instance?.[name];
      if (typeof method !== "function") throw new Error(`Unknown Sync method: ${name}`);
      return Function.prototype.toString.call(method);
    }, methodName);
    console.log(JSON.stringify({ methodName, source }, null, 2));
  } else if (action === "sync-connect-diagnostic") {
    const diagnostic = await page.evaluate(async () => {
      const instance = globalThis.app?.internalPlugins?.getPluginById?.("sync")?.instance;
      if (!instance) throw new Error("Sync instance is unavailable");
      const errors = [];
      const original = console.error;
      console.error = (...values) => {
        for (const value of values) {
          if (value instanceof Error) {
            errors.push({ name: value.name, message: value.message, stack: value.stack?.slice(0, 4000) });
          } else {
            errors.push({ name: typeof value, message: String(value).slice(0, 1000) });
          }
        }
        original.apply(console, values);
      };
      try {
        instance.gettingServer = null;
        if (instance.server) {
          instance.server.disconnect();
          instance.server = null;
        }
        await instance.getServer();
      } finally {
        console.error = original;
      }
      return {
        host: instance.getHost(),
        ready: instance.ready,
        error: instance.error,
        syncStatus: instance.syncStatus,
        serverPresent: Boolean(instance.server),
        errors,
      };
    });
    console.log(JSON.stringify({ diagnostic, url: page.url() }, null, 2));
  } else if (action === "snapshot") {
    const screenshotPath = arguments_[0] ? resolve(arguments_[0]) : null;
    const statePath = arguments_[1] ? resolve(arguments_[1]) : null;
    const allowedEvidenceRoot = resolve(import.meta.dirname, "../.data/e2e");
    if (
      (screenshotPath && !screenshotPath.startsWith(`${allowedEvidenceRoot}/`)) ||
      (statePath && !statePath.startsWith(`${allowedEvidenceRoot}/`))
    ) {
      throw new Error(`E2E UI evidence must remain inside ${allowedEvidenceRoot}`);
    }
    if (
      statePath &&
      (!screenshotPath || statePath !== screenshotPath.replace(/\.png$/u, ".json"))
    ) {
      throw new Error("E2E UI state must be the .json peer of its .png screenshot");
    }
    if (screenshotPath) {
      if (await fileExists(screenshotPath)) {
        throw new Error(`Refusing to overwrite E2E screenshot: ${screenshotPath}`);
      }
      await mkdir(dirname(screenshotPath), { recursive: true });
      await page.screenshot({ path: screenshotPath, fullPage: true });
      await chmod(screenshotPath, 0o600);
    }
    const interactive = await page
      .locator("button, input, select, textarea, [role=button], [contenteditable=true]")
      .evaluateAll((elements) =>
        elements.map((element, index) => {
          const type = element.getAttribute("type");
          const placeholder = element.getAttribute("placeholder");
          const sensitive =
            type === "password" ||
            type === "email" ||
            /password|email/iu.test(placeholder ?? "");
          return {
            index,
            tag: element.tagName,
            text: element.textContent?.trim().slice(0, 200) ?? "",
            ariaLabel: element.getAttribute("aria-label"),
            placeholder,
            title: element.getAttribute("title"),
            type,
            checked: "checked" in element ? element.checked : null,
            value: "value" in element
              ? sensitive && String(element.value).length > 0
                ? "[redacted]"
                : String(element.value).slice(0, 200)
              : null,
            classes: element.getAttribute("class"),
          };
        }),
      );
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => {
      if (!response.ok) throw new Error(`DevTools target query failed: ${response.status}`);
      return response.json();
    });
    const screenshotBytes = screenshotPath ? await readFile(screenshotPath) : null;
    const accessibleText = await page.locator("[aria-label], [title]").evaluateAll((elements) =>
      [...new Set(elements.flatMap((element) => {
        if (element.getClientRects().length === 0) return [];
        return [element.getAttribute("aria-label"), element.getAttribute("title")]
          .filter((value) => typeof value === "string" && value.trim().length > 0)
          .map((value) => value.trim().slice(0, 1000));
      }))].slice(0, 1000),
    );
    const syncState = await boundPage.evaluate(() => {
      const plugin = globalThis.app?.internalPlugins?.getPluginById?.("sync");
      const instance = plugin?.instance;
      const server = instance?.server;
      return {
        pluginPresent: Boolean(plugin),
        instancePresent: Boolean(instance),
        ready: typeof instance?.ready === "boolean" ? instance.ready : null,
        syncStatus:
          typeof instance?.syncStatus === "string"
            ? instance.syncStatus.slice(0, 200)
            : null,
        serverPresent: Boolean(server),
        vaultIdPresent:
          typeof instance?.vaultId === "string" && instance.vaultId.length > 0,
        paused:
          typeof instance?.paused === "boolean"
            ? instance.paused
            : typeof instance?.isPaused === "boolean"
              ? instance.isPaused
              : null,
      };
    });
    const snapshot = {
      schemaVersion: E2E_UI_EVIDENCE_SCHEMA_VERSION,
      observedAt: new Date().toISOString(),
      launchIdentityPath: launch.path,
      launchIdentitySha256: launch.sha256,
      runManifestSha256: launch.identity.runManifestSha256,
      releaseManifestSha256: launch.identity.releaseManifestSha256,
      launchedPid: launch.identity.pid,
      debugPort: port,
      debugListenerPid: launch.identity.debugListenerPid,
      debugTargetId: launch.identity.debugTargetId,
      profilePath: launch.identity.profilePath,
      vaultPath: launch.identity.vaultPath,
      rendererPageCount: rendererPages.length,
      visibleRendererPageCount: visibleRendererPages.length,
      targets: targets.map((target) => ({
        id: target.id,
        type: target.type,
        title: target.title,
        url: target.url,
      })),
      url: page.url(),
      title: await page.title(),
      bodyText: (await page.locator("body").innerText()).slice(0, 30_000),
      accessibleText,
      interactive,
      syncState,
      screenshotPath,
      screenshotSha256: screenshotBytes
        ? createHash("sha256").update(screenshotBytes).digest("hex")
        : null,
    };
    if (statePath) {
      if (await fileExists(statePath)) {
        throw new Error(`Refusing to overwrite E2E UI state: ${statePath}`);
      }
      await mkdir(dirname(statePath), { recursive: true });
      await writeFile(statePath, `${JSON.stringify(snapshot, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
    }
    console.log(JSON.stringify(snapshot, null, 2));
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
  } else if (action === "select-option") {
    const selector = required(arguments_[0], "selector");
    const value = required(arguments_[1], "option value");
    const index = Number(arguments_[2] ?? "0");
    await page.locator(selector).nth(index).selectOption(value);
    console.log(JSON.stringify({ selected: selector, value, index, url: page.url() }));
  } else if (action === "select-option-label") {
    const selector = required(arguments_[0], "selector");
    const label = required(arguments_[1], "option label");
    const index = Number(arguments_[2] ?? "0");
    await page.locator(selector).nth(index).selectOption({ label });
    console.log(JSON.stringify({ selected: selector, label, index, url: page.url() }));
  } else if (action === "press") {
    const key = required(arguments_[0], "key");
    await page.keyboard.press(key);
    console.log(JSON.stringify({ pressed: key, url: page.url() }));
  } else if (action === "checkboxes") {
    const checkboxes = await page.locator('input[type="checkbox"]').evaluateAll((elements) =>
      elements.map((element, index) => {
        const container = element.closest(".checkbox-container");
        return {
          index,
          checked: container
            ? container.classList.contains("is-enabled")
            : element.checked,
          nativeChecked: element.checked,
          disabled: element.disabled,
          context:
            element.closest(".setting-item")?.innerText?.trim().slice(0, 500) ??
            element.parentElement?.innerText?.trim().slice(0, 500) ??
            "",
        };
      }),
    );
    console.log(JSON.stringify({ checkboxes, url: page.url() }, null, 2));
  } else if (action === "set-checkbox") {
    const index = Number(required(arguments_[0], "checkbox index"));
    const checked = required(arguments_[1], "checked state") === "true";
    const checkbox = page.locator('input[type="checkbox"]').nth(index);
    await setObsidianCheckbox(checkbox, checked);
    console.log(JSON.stringify({ checkbox: index, checked, url: page.url() }));
  } else if (action === "set-checkbox-label") {
    const label = required(arguments_[0], "setting label");
    const checked = required(arguments_[1], "checked state") === "true";
    const setting = page
      .locator(".setting-item")
      .filter({ has: page.getByText(label, { exact: true }) })
      .last();
    if ((await setting.count()) !== 1) {
      throw new Error(`Expected one checkbox setting named: ${label}`);
    }
    const checkbox = setting.locator('input[type="checkbox"]');
    if ((await checkbox.count()) !== 1) {
      throw new Error(`Setting does not contain exactly one checkbox: ${label}`);
    }
    await setObsidianCheckbox(checkbox, checked);
    console.log(JSON.stringify({ label, checked, url: page.url() }));
  } else if (action === "set-checkboxes") {
    const indexes = required(arguments_[0], "checkbox indexes")
      .split(",")
      .map((value) => Number(value));
    if (indexes.length === 0 || indexes.some((index) => !Number.isInteger(index) || index < 0)) {
      throw new Error("Checkbox indexes must be a comma-separated list of non-negative integers");
    }
    const checked = required(arguments_[1], "checked state") === "true";
    for (const index of indexes) {
      const checkbox = page.locator('input[type="checkbox"]').nth(index);
      await setObsidianCheckbox(checkbox, checked);
    }
    console.log(JSON.stringify({ checkboxes: indexes, checked, url: page.url() }));
  } else if (action === "trace-reconnect") {
    const cdp = await page.context().newCDPSession(page);
    const events = [];
    const record = (kind, value) => events.push({ kind, ...value });
    cdp.on("Network.webSocketCreated", (event) =>
      record("webSocketCreated", { url: event.url }),
    );
    cdp.on("Network.webSocketFrameError", (event) =>
      record("webSocketFrameError", { errorMessage: event.errorMessage }),
    );
    cdp.on("Network.loadingFailed", (event) =>
      record("loadingFailed", {
        errorText: event.errorText,
        blockedReason: event.blockedReason ?? null,
        canceled: event.canceled ?? false,
      }),
    );
    cdp.on("Log.entryAdded", (event) =>
      record("log", { level: event.entry.level, text: event.entry.text.slice(0, 1000) }),
    );
    await cdp.send("Network.enable");
    await cdp.send("Log.enable");
    const pause = page.getByText("Pause", { exact: true }).last();
    if (await pause.isVisible()) await pause.click();
    await page.waitForTimeout(250);
    const resume = page.getByText("Resume", { exact: true }).last();
    if (await resume.isVisible()) await resume.click();
    await page.waitForTimeout(Number(arguments_[0] ?? "8000"));
    console.log(JSON.stringify({ events, url: page.url() }, null, 2));
  } else if (action === "trace-all-targets") {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) =>
      response.json(),
    );
    const events = [];
    const sockets = [];
    for (const target of targets) {
      if (!target.webSocketDebuggerUrl) continue;
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      sockets.push(socket);
      await new Promise((resolveOpen, rejectOpen) => {
        socket.addEventListener("open", resolveOpen, { once: true });
        socket.addEventListener("error", rejectOpen, { once: true });
      });
      const requestUrls = new Map();
      socket.addEventListener("message", (message) => {
        const event = JSON.parse(String(message.data));
        const params = event.params ?? {};
        if (event.method === "Network.webSocketCreated") {
          requestUrls.set(params.requestId, params.url);
          events.push({ target: target.title, method: event.method, url: params.url });
        } else if (event.method === "Network.webSocketHandshakeResponseReceived") {
          events.push({
            target: target.title,
            method: event.method,
            url: requestUrls.get(params.requestId) ?? null,
            status: params.response?.status ?? null,
            statusText: params.response?.statusText ?? null,
          });
        } else if (event.method === "Network.webSocketFrameError") {
          events.push({
            target: target.title,
            method: event.method,
            url: requestUrls.get(params.requestId) ?? null,
            errorMessage: params.errorMessage,
          });
        } else if (event.method === "Network.loadingFailed") {
          events.push({
            target: target.title,
            method: event.method,
            errorText: params.errorText,
            blockedReason: params.blockedReason ?? null,
          });
        } else if (event.method === "Log.entryAdded") {
          events.push({
            target: target.title,
            method: event.method,
            level: params.entry?.level,
            text: params.entry?.text?.slice(0, 1000),
          });
        } else if (event.method === "Runtime.exceptionThrown") {
          events.push({
            target: target.title,
            method: event.method,
            text: params.exceptionDetails?.text,
            description: params.exceptionDetails?.exception?.description?.slice(0, 1000),
          });
        }
      });
      socket.send(JSON.stringify({ id: 1, method: "Network.enable" }));
      socket.send(JSON.stringify({ id: 2, method: "Log.enable" }));
      socket.send(JSON.stringify({ id: 3, method: "Runtime.enable" }));
    }
    const pause = page.getByText("Pause", { exact: true }).last();
    if (await pause.isVisible()) await pause.click();
    await page.waitForTimeout(250);
    const resume = page.getByText("Resume", { exact: true }).last();
    if (await resume.isVisible()) await resume.click();
    await page.waitForTimeout(Number(arguments_[0] ?? "8000"));
    for (const socket of sockets) socket.close();
    console.log(JSON.stringify({ events, url: page.url() }, null, 2));
  } else if (action === "login") {
    const credentialsPath = resolve(required(arguments_[0], "credentials path"));
    assertE2EEvidencePath(credentialsPath, "credentials");
    const credentials = JSON.parse(await readFile(credentialsPath, "utf8"));
    const account =
      arguments_[1] === "secondary"
        ? credentials.secondary
        : arguments_[1] === "outsider"
          ? credentials.outsider
          : credentials;
    if (!account?.email || !account?.password) {
      throw new Error(`Credentials do not contain the requested ${arguments_[1] ?? "primary"} account`);
    }
    await page.locator('input[placeholder="Your email..."]').fill(account.email);
    await page.locator('input[placeholder="Your password..."]').fill(account.password);
    await page.getByText("Login", { exact: true }).last().click();
    console.log(JSON.stringify({ loginSubmitted: true, url: page.url() }));
  } else if (action === "invite-collaborator") {
    const credentialsPath = resolve(required(arguments_[0], "credentials path"));
    assertE2EEvidencePath(credentialsPath, "credentials");
    const credentials = JSON.parse(await readFile(credentialsPath, "utf8"));
    if (!credentials.secondary?.email) {
      throw new Error("Credentials do not contain the secondary account");
    }
    await page.locator('input[placeholder="Enter their email..."]').fill(
      credentials.secondary.email,
    );
    await page.getByText("Add", { exact: true }).last().click();
    console.log(JSON.stringify({ collaboratorInviteSubmitted: true, url: page.url() }));
  } else if (action === "create-vault" || action === "create-managed-vault") {
    const credentialsPath = resolve(required(arguments_[0], "credentials path"));
    assertE2EEvidencePath(credentialsPath, "credentials");
    const credentials = JSON.parse(await readFile(credentialsPath, "utf8"));
    const managed = action === "create-managed-vault";
    const vaultName = page.locator('input[placeholder="My awesome vault"]');
    if (!(await vaultName.isVisible())) {
      await page.getByText("Create new vault", { exact: true }).last().click();
    }
    await vaultName.fill(managed ? "Managed E2E Vault" : "E2E Vault");
    const region = page.locator("select").filter({ hasText: "Blackglass Server" });
    await region.selectOption({ label: "Blackglass Server" });
    if (managed) {
      const encryption = page.locator("select").filter({ hasText: "Standard encryption" });
      await encryption.selectOption({ label: "Standard encryption" });
    } else {
      await page.locator('input[placeholder="Your password"]').fill(credentials.e2ePassword);
    }
    await page.getByText("Create", { exact: true }).last().click();
    console.log(JSON.stringify({
      vaultCreateSubmitted: true,
      encryption: managed ? "managed" : "custom-e2ee",
      url: page.url(),
    }));
  } else if (action === "unlock-vault" || action === "unlock-vault-wrong") {
    const credentialsPath = resolve(required(arguments_[0], "credentials path"));
    assertE2EEvidencePath(credentialsPath, "credentials");
    const credentials = JSON.parse(await readFile(credentialsPath, "utf8"));
    const password = action === "unlock-vault-wrong"
      ? `${credentials.e2ePassword}-wrong`
      : credentials.e2ePassword;
    await page.locator('input[placeholder="Your password"]').last().fill(password);
    await page.getByText("Unlock vault", { exact: true }).last().click();
    console.log(JSON.stringify({
      vaultUnlockSubmitted: true,
      expectedSuccess: action === "unlock-vault",
      url: page.url(),
    }));
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

async function setObsidianCheckbox(checkbox, checked) {
  const container = checkbox.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' checkbox-container ')][1]");
  const hasContainer = (await container.count()) === 1;
  const current = hasContainer
    ? await container.evaluate((element) => element.classList.contains("is-enabled"))
    : await checkbox.isChecked();
  if (current !== checked) {
    // Obsidian owns toggle state and click handling on the styled container.
    if (hasContainer) await container.click({ force: true });
    else if (checked) await checkbox.check();
    else await checkbox.uncheck();
  }
  const observed = hasContainer
    ? await container.evaluate((element) => element.classList.contains("is-enabled"))
    : await checkbox.isChecked();
  if (observed !== checked) {
    throw new Error(`Checkbox did not reach requested state: ${checked}`);
  }
}

async function findBoundLaunchIdentity(debugPort) {
  const e2eRoot = resolve(import.meta.dirname, "../.data/e2e");
  const glob = new Bun.Glob("**/*.json");
  const candidates = [];
  for await (const discoveredPath of glob.scan({ cwd: e2eRoot, absolute: true })) {
    let raw;
    try {
      raw = JSON.parse(await readFile(discoveredPath, "utf8"));
    } catch {
      continue;
    }
    if (raw?.schemaVersion !== 4 || raw?.debugPort !== debugPort || !raw?.pid) continue;
    if (!processIsAlive(raw.pid)) continue;
    const binding = await verifyLiveClientLaunchBinding(discoveredPath);
    candidates.push({
      path: binding.identityPath,
      sha256: binding.identitySha256,
      identity: binding.identity,
      processCommand: binding.launchCommand,
    });
  }
  if (candidates.length !== 1) {
    throw new Error(
      `Expected exactly one live client identity for debugging port ${debugPort}, found ${candidates.length}`,
    );
  }
  return candidates[0];
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function fileExists(path) {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function assertE2EEvidencePath(path, label) {
  const allowedEvidenceRoot = resolve(import.meta.dirname, "../.data/e2e");
  if (!path.startsWith(`${allowedEvidenceRoot}/`)) {
    throw new Error(`${label} must remain inside ${allowedEvidenceRoot}`);
  }
}

function usesForegroundPage(requestedAction) {
  return ![
    "list-pages",
    "sync-structure",
    "sync-status",
    "sync-method",
    "sync-connect-diagnostic",
    "trace-reconnect",
    "trace-all-targets",
  ].includes(requestedAction);
}
