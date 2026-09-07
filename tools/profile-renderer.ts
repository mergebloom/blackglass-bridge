import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { adapterProfileFileName } from "./launcher-config";
export interface ProfileRenderer {
  rendererVersion: string;
  adapterProfileFileName: string;
  adapterSha256: string;
}
const receiptName = ".blackglass-renderer.json";
const journalName = ".blackglass-renderer-transition.json";
const historyName = ".blackglass-renderer-history";
function valid(value: unknown): value is ProfileRenderer {
  if (!value || typeof value !== "object")
    return false;
  const r = value as ProfileRenderer;
  return typeof r.rendererVersion === "string" && /^\d+\.\d+\.\d+$/.test(r.rendererVersion) &&
    r.adapterProfileFileName === adapterProfileFileName(r.rendererVersion) &&
    typeof r.adapterSha256 === "string" && /^[a-f0-9]{64}$/.test(r.adapterSha256);
}
function same(a: ProfileRenderer, b: ProfileRenderer): boolean {
  return a.adapterProfileFileName === b.adapterProfileFileName && a.adapterSha256 === b.adapterSha256 && a.rendererVersion === b.rendererVersion;
}
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return false;
    throw error;
  }
}
async function owned(path: string, directory = false): Promise<void> {
  const s = await lstat(path);
  if (s.isSymbolicLink() || s.uid !== process.getuid!() || (directory ? !s.isDirectory() : !s.isFile()) ||
    (s.mode & 0o077) !== 0)
    throw new Error("Unsafe Blackglass profile renderer state");
}
async function hash(path: string): Promise<string> {
  await owned(path);
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
async function verify(path: string, renderer: ProfileRenderer, privateFile = true): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("Unsafe renderer input");
  const digest = privateFile ? await hash(path) : createHash("sha256").update(await readFile(path)).digest("hex");
  if (digest !== renderer.adapterSha256)
    throw new Error("Profile renderer does not match its receipt");
}
async function json(path: string): Promise<Record<string, unknown>> {
  await owned(path);
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid profile renderer metadata");
  }
  return value as Record<string, unknown>;
}
async function atomicJson(path: string, value: unknown): Promise<void> {
  if (await exists(path))
    await owned(path);
  const next = `${path}.next-${randomUUID()}`;
  await writeFile(next, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 });
  await rename(next, path);
}
/** Caller holds the exclusive profile launch lease and has verified the
 * target app. Legacy adoption requires a separately verified previous app.
 * A journal and hash-addressed copies make an interrupted switch resumable;
 * no account settings, vault registrations, or local notes are replaced. */
export async function selectProfileRenderer(profile: string, adapter: string, requested: ProfileRenderer, legacyPrevious?: ProfileRenderer): Promise<void> {
  const target: ProfileRenderer = {
    rendererVersion: requested.rendererVersion,
    adapterProfileFileName: requested.adapterProfileFileName, adapterSha256: requested.adapterSha256
  };
  if (!valid(target) || (legacyPrevious && !valid(legacyPrevious)))
    throw new Error("Invalid profile renderer identity");
  await verify(adapter, target, false);
  const receiptPath = join(profile, receiptName), journalPath = join(profile, journalName), history = join(profile, historyName);
  const aliases = (await readdir(profile)).filter(name => /^obsidian-\d+\.\d+\.\d+\.asar$/.test(name));
  let from: ProfileRenderer | null = null;
  let pending = false;
  if (await exists(journalPath)) {
    const journal = await json(journalPath);
    if (journal.schemaVersion !== 1 || !valid(journal.to) || (journal.from !== null && !valid(journal.from)) || !same(journal.to, target)) {
      throw new Error("Resume the recorded Blackglass renderer transition before selecting another app");
    }
    from = journal.from;
    pending = true;
  }
  else if (await exists(receiptPath)) {
    const receipt = await json(receiptPath);
    if (receipt.schemaVersion !== 1 || !valid(receipt.renderer))
      throw new Error("Invalid profile renderer receipt");
    from = receipt.renderer;
  }
  else if (aliases.length) {
    if (aliases.length === 1 && aliases[0] === target.adapterProfileFileName && await hash(join(profile, aliases[0])) === target.adapterSha256)
      from = target;
    else if (legacyPrevious)
      from = legacyPrevious;
    else
      throw new Error("This legacy Blackglass profile requires --blackglass-previous-app with the previous generated app for a verified upgrade");
  }
  if (aliases.some(name => name !== target.adapterProfileFileName && name !== from?.adapterProfileFileName) || aliases.length > 1) {
    throw new Error("Blackglass profile contains unrecognized renderer aliases");
  }
  if (!pending && from)
    await verify(join(profile, from.adapterProfileFileName), from);
  if (!pending && from && same(from, target)) {
    await atomicJson(receiptPath, { schemaVersion: 1, renderer: target });
    return;
  }
  if (!(await exists(history)))
    await mkdir(history, { mode: 0o700 });
  await owned(history, true);
  async function preserve(path: string, identity: ProfileRenderer, privateFile = true): Promise<string> {
    const saved = join(history, identity.adapterSha256 + ".asar");
    if (await exists(saved))
      await verify(saved, identity);
    else {
      await verify(path, identity, privateFile);
      const next = saved + ".next-" + randomUUID();
      await copyFile(path, next);
      await chmod(next, 0o600);
      await verify(next, identity);
      await rename(next, saved);
    }
    return saved;
  }
  const targetCopy = await preserve(adapter, target, false);
  if (!pending) {
    if (from)
      await preserve(join(profile, from.adapterProfileFileName), from);
    await atomicJson(journalPath, { schemaVersion: 1, from, to: target });
  }
  else if (from)
    await verify(join(history, from.adapterSha256 + ".asar"), from);
  if (from && from.adapterProfileFileName !== target.adapterProfileFileName && await exists(join(profile, from.adapterProfileFileName))) {
    await verify(join(profile, from.adapterProfileFileName), from);
    await unlink(join(profile, from.adapterProfileFileName));
  }
  const selected = join(profile, target.adapterProfileFileName);
  if (await exists(selected)) {
    const actual = await hash(selected);
    if (actual !== target.adapterSha256 && !(from && from.adapterProfileFileName === target.adapterProfileFileName && actual === from.adapterSha256)) {
      throw new Error("Unexpected renderer appeared during profile transition");
    }
  }
  const next = selected + ".next-" + randomUUID();
  await copyFile(targetCopy, next);
  await chmod(next, 0o600);
  await verify(next, target);
  await rename(next, selected);
  await atomicJson(receiptPath, { schemaVersion: 1, renderer: target });
  await unlink(journalPath);
}
/** Retry only transient missing/partial writes, never a valid disabled guard. */
export async function readProfileSettings(path: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 500;
  for (;;) {
    try {
      await owned(path);
      const before = await lstat(path);
      const text = await readFile(path, "utf8");
      const after = await lstat(path);
      if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || Buffer.byteLength(text) !== after.size) {
        throw new SyntaxError("Profile settings changed during read");
      }
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Blackglass profile configuration is malformed");
      return value as Record<string, unknown>;
    }
    catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT")
        throw error;
      if (Date.now() >= deadline)
        throw new Error("Blackglass profile settings remained unreadable", { cause: error });
      await Bun.sleep(20);
    }
  }
}
