import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RELEASE_RUNTIME_DEPENDENCY_IMPORTS } from "../tools/packaging-toolchain";

const repositoryRoot = resolve(import.meta.dir, "..");

test("release runtime imports bypass ignored nested shadow packages", async () => {
  for (const dependency of RELEASE_RUNTIME_DEPENDENCY_IMPORTS) {
    const importer = await readFile(
      resolve(repositoryRoot, dependency.importer),
      "utf8",
    );
    expect(importer).toContain(`from "${dependency.specifier}"`);
  }

  const fixture = await mkdtemp(
    join(tmpdir(), "blackglass-runtime-dependency-shadow-"),
  );
  try {
    await Promise.all([
      writeFile(
        join(fixture, "package.json"),
        `${JSON.stringify({
          type: "module",
          imports: {
            "#release-playwright-core": "playwright-core",
            "#release-typescript": "typescript",
          },
        })}\n`,
      ),
      writePackage(fixture, "typescript", "lib/typescript.js", "attested-typescript"),
      writePackage(
        join(fixture, "tools"),
        "typescript",
        "lib/typescript.js",
        "shadow-typescript",
      ),
      writePackage(
        fixture,
        "playwright-core",
        "index.mjs",
        "attested-playwright",
      ),
      writePackage(
        join(fixture, "tools"),
        "playwright-core",
        "index.mjs",
        "shadow-playwright",
      ),
    ]);
    const tools = join(fixture, "tools");
    await Promise.all([
      writeFile(
        join(tools, "pinned-typescript.mjs"),
        'import value from "#release-typescript"; console.log(value);\n',
      ),
      writeFile(
        join(tools, "bare-typescript.mjs"),
        'import value from "typescript"; console.log(value);\n',
      ),
      writeFile(
        join(tools, "pinned-playwright.mjs"),
        'import { chromium } from "#release-playwright-core"; console.log(chromium);\n',
      ),
      writeFile(
        join(tools, "bare-playwright.mjs"),
        'import { chromium } from "playwright-core"; console.log(chromium);\n',
      ),
    ]);

    expect(runFixture(join(tools, "bare-typescript.mjs"))).toBe(
      "shadow-typescript",
    );
    expect(runFixture(join(tools, "pinned-typescript.mjs"))).toBe(
      "attested-typescript",
    );
    expect(runFixture(join(tools, "bare-playwright.mjs"))).toBe(
      "shadow-playwright",
    );
    expect(runFixture(join(tools, "pinned-playwright.mjs"))).toBe(
      "attested-playwright",
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

async function writePackage(
  root: string,
  name: "typescript" | "playwright-core",
  entry: string,
  value: string,
): Promise<void> {
  const packageRoot = join(root, "node_modules", name);
  const entryPath = join(packageRoot, entry);
  await mkdir(resolve(entryPath, ".."), { recursive: true });
  const isTypeScript = name === "typescript";
  await Promise.all([
    writeFile(
      join(packageRoot, "package.json"),
      `${JSON.stringify({
        name,
        type: "module",
        ...(isTypeScript
          ? { main: "./lib/typescript.js" }
          : { exports: { ".": "./index.mjs" } }),
      })}\n`,
    ),
    writeFile(
      entryPath,
      isTypeScript
        ? `export default ${JSON.stringify(value)};\n`
        : `export const chromium = ${JSON.stringify(value)};\n`,
    ),
  ]);
}

function runFixture(path: string): string {
  const result = Bun.spawnSync([process.execPath, path], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim();
}
