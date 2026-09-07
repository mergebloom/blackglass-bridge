import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { adapterProfileFileName, packagedLauncherArguments } from "../tools/launcher-config";
import { assertRuntimeProfile } from "../tools/launcher-runtime";
import type { BridgeLaunchConfig } from "../tools/launcher-config";
import { readProfileSettings, selectProfileRenderer, type ProfileRenderer } from "../tools/profile-renderer";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "blackglass-profile-regression-"));
  roots.push(root);
  const profile = join(root, "profile");
  await mkdir(profile, { mode: 0o700 });
  async function renderer(version: string, content = version) {
    const path = join(root, createHash("sha256").update(content).digest("hex"));
    await writeFile(path, content, { mode: 0o644 }); // App resources need not be private.
    const identity: ProfileRenderer = {
      rendererVersion: version, adapterProfileFileName: adapterProfileFileName(version),
      adapterSha256: createHash("sha256").update(content).digest("hex")
    };
    return { path, identity };
  }
  return { root, profile, renderer };
}
test("selects, upgrades and rolls back a hash-bound renderer without replacing local state", async () => {
  const { profile, renderer } = await fixture();
  const old = await renderer("1.12.7"), next = await renderer("1.13.4");
  const settings = '{"updateDisabled":true,"vaults":{"local":{"path":"/example/vault"}}}';
  await writeFile(join(profile, "obsidian.json"), settings, { mode: 0o600 });
  await writeFile(join(profile, "unsynced.md"), "keep local edits", { mode: 0o600 });
  await selectProfileRenderer(profile, old.path, old.identity);
  await selectProfileRenderer(profile, next.path, next.identity);
  expect((await readdir(profile)).filter(p => p.endsWith(".asar"))).toEqual([next.identity.adapterProfileFileName]);
  await selectProfileRenderer(profile, old.path, old.identity);
  expect(await readFile(join(profile, old.identity.adapterProfileFileName), "utf8")).toBe("1.12.7");
  expect(await readFile(join(profile, "obsidian.json"), "utf8")).toBe(settings);
  expect(await readFile(join(profile, "unsynced.md"), "utf8")).toBe("keep local edits");
  expect((await readdir(join(profile, ".blackglass-renderer-history"))).length).toBe(2);
});
test("legacy upgrades require the previous identity; corruption and unknown aliases fail closed", async () => {
  const { profile, renderer } = await fixture();
  const old = await renderer("1.12.7"), next = await renderer("1.13.4");
  const alias = join(profile, old.identity.adapterProfileFileName);
  await copyFile(old.path, alias);
  await chmod(alias, 0o600);
  await expect(selectProfileRenderer(profile, next.path, next.identity)).rejects.toThrow("previous-app");
  await writeFile(alias, "tampered");
  await expect(selectProfileRenderer(profile, next.path, next.identity, old.identity)).rejects.toThrow("receipt");
  await writeFile(alias, "1.12.7");
  await selectProfileRenderer(profile, next.path, next.identity, old.identity);
  await writeFile(join(profile, "obsidian-99.0.0.asar"), "unknown", { mode: 0o600 });
  await expect(selectProfileRenderer(profile, next.path, next.identity)).rejects.toThrow("unrecognized");
});
test("resumes a journal after the old alias was removed, but refuses a different target", async () => {
  const { profile, renderer } = await fixture();
  const old = await renderer("1.12.7"), next = await renderer("1.13.4");
  await selectProfileRenderer(profile, old.path, old.identity);
  await writeFile(join(profile, ".blackglass-renderer-transition.json"), JSON.stringify({ schemaVersion: 1, from: old.identity, to: next.identity }), { mode: 0o600 });
  await unlink(join(profile, old.identity.adapterProfileFileName));
  await expect(selectProfileRenderer(profile, old.path, old.identity)).rejects.toThrow("Resume");
  await selectProfileRenderer(profile, next.path, next.identity);
  expect(await readFile(join(profile, next.identity.adapterProfileFileName), "utf8")).toBe("1.13.4");
  expect(await Bun.file(join(profile, ".blackglass-renderer-transition.json")).exists()).toBe(false);
});
test("supports a reviewed endpoint rebuild with the same alias, and rejects symlink state", async () => {
  const { profile, renderer, root } = await fixture();
  const old = await renderer("1.13.4"), next = await renderer("1.13.4", "new endpoints");
  await selectProfileRenderer(profile, old.path, old.identity);
  await selectProfileRenderer(profile, next.path, next.identity);
  expect(await readFile(join(profile, next.identity.adapterProfileFileName), "utf8")).toBe("new endpoints");
  const receipt = join(profile, ".blackglass-renderer.json");
  await unlink(receipt);
  await writeFile(join(root, "foreign"), "{}", { mode: 0o600 });
  await symlink(join(root, "foreign"), receipt);
  await expect(selectProfileRenderer(profile, next.path, next.identity)).rejects.toThrow("Unsafe");
});
test("partial settings writes recover, but persistent corruption and disabled protection do not", async () => {
  const { profile, renderer } = await fixture();
  const current = await renderer("1.13.4");
  await selectProfileRenderer(profile, current.path, current.identity);
  const settings = join(profile, "obsidian.json");
  await writeFile(settings, "", { mode: 0o600 });
  const repair = Bun.sleep(40).then(() => writeFile(settings, '{"updateDisabled":true}'));
  await assertRuntimeProfile(current.identity as BridgeLaunchConfig, profile);
  await repair;
  await unlink(settings);
  const recreate = Bun.sleep(40).then(() => writeFile(settings, '{"updateDisabled":true}', { mode: 0o600 }));
  expect((await readProfileSettings(settings)).updateDisabled).toBe(true);
  await recreate;
  await writeFile(settings, '{"updateDisabled":false}');
  await expect(assertRuntimeProfile(current.identity as BridgeLaunchConfig, profile)).rejects.toThrow("update protection");
  await writeFile(settings, "{");
  await expect(readProfileSettings(settings)).rejects.toThrow("remained unreadable");
});
test("the runtime guard survives concurrent Node writeFileSync settings saves", async () => {
  const { profile, renderer, root } = await fixture();
  const current = await renderer("1.13.4");
  await selectProfileRenderer(profile, current.path, current.identity);
  const settings = join(profile, "obsidian.json");
  await writeFile(settings, '{"updateDisabled":true}', { mode: 0o600 });
  const script = join(root, "writer.mjs");
  await writeFile(script, `import {writeFileSync} from "node:fs";
for (let i=0;i<2500;i++) writeFileSync(process.argv[2],JSON.stringify({updateDisabled:true,save:i,padding:"x".repeat(16384)}));
`, { mode: 0o600 });
  const node = Bun.which("node");
  if (!node) throw new Error("Node.js is required for the upstream file-save regression");
  const writer = Bun.spawn([node, script, settings], { stdout: "pipe", stderr: "pipe" });
  try {
    for (let read = 0; read < 100; read++) await assertRuntimeProfile(current.identity as BridgeLaunchConfig, profile);
    expect(await writer.exited).toBe(0);
    expect((await readProfileSettings(settings)).save).toBe(2499);
  } finally {
    if (writer.exitCode === null) writer.kill();
    await writer.exited;
  }
});

test("previous-app is a launcher-only option with duplicate rejection", () => {
  expect(packagedLauncherArguments(["--blackglass-previous-app", "/previous/Blackglass.app"])).toEqual({ previousAppPath: "/previous/Blackglass.app", runtimeArguments: [] });
  expect(() => packagedLauncherArguments(["--blackglass-previous-app", "/a", "--blackglass-previous-app", "/b"])).toThrow("duplicate");
});
