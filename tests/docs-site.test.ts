import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const siteRoot = resolve(root, "site");
const html = readFileSync(resolve(siteRoot, "index.html"), "utf8");
const css = readFileSync(resolve(siteRoot, "styles.css"), "utf8");
const javascript = readFileSync(resolve(siteRoot, "app.js"), "utf8");

describe("documentation site", () => {
  test("explains the product and both beginner workflows", () => {
    expect(html).toContain("What is Blackglass?");
    expect(html).toContain("Set up Blackglass Server");
    expect(html).toContain("Create Blackglass.app");
    expect(html).toContain("Blackglass Server");
    expect(html).toContain("Blackglass Bridge");
    expect(html).toContain("Blackglass.app");
    expect(html).toContain("compatibility/MATRIX.md");
  });

  test("provides copy-ready prompts for setup and maintenance", () => {
    for (const id of ["prompt-server", "prompt-client", "prompt-upgrade", "prompt-future"]) {
      expect(html).toContain(`id="${id}"`);
      expect(html).toContain(`data-copy="${id}"`);
    }
    expect(javascript).toContain("navigator.clipboard.writeText");
    expect(javascript).toContain("document.execCommand");
  });

  test("keeps all local links and assets resolvable", () => {
    const ids = new Set(Array.from(html.matchAll(/\sid="([^"]+)"/gu), (match) => match[1]));
    const references = Array.from(html.matchAll(/\s(?:href|src)="([^"]+)"/gu))
      .map((match) => match[1])
      .filter((reference): reference is string => reference !== undefined);

    for (const reference of references) {
      if (reference.startsWith("#")) {
        expect(ids.has(reference.slice(1))).toBeTrue();
      } else if (!reference.startsWith("https://")) {
        expect(existsSync(resolve(siteRoot, reference))).toBeTrue();
      }
    }
  });

  test("is dependency-free, responsive, and accessibility-aware", () => {
    expect(html).not.toMatch(/<script[^>]+https?:\/\//u);
    expect(html).not.toMatch(/<link[^>]+href="https?:\/\//u);
    expect(html).toContain('aria-label="Primary navigation"');
    expect(html).toContain('aria-live="polite"');
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("@media (max-width:");
  });

  test("uses neutral examples and contains no obvious secret values", () => {
    const publicFiles = `${html}\n${css}\n${javascript}`.toLowerCase();
    expect(publicFiles).not.toMatch(/(?:password|token|secret)\s*[=:]\s*["']?[a-z0-9/+_-]{16,}/u);
    expect(html).toContain("sync-control.example.com");
    expect(html).toContain("sync-data.example.com");
  });

  test("ships every static entrypoint", () => {
    for (const path of ["index.html", "styles.css", "app.js", ".nojekyll", "robots.txt", "assets/blackglass-prism.png"]) {
      expect(existsSync(resolve(siteRoot, path))).toBeTrue();
    }
  });
});
