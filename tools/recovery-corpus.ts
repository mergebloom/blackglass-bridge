import { createHash } from "node:crypto";
import { extname } from "node:path";

export const RECOVERY_CORPUS_SCHEMA_VERSION = 1 as const;
export const RECOVERY_CORPUS_ID = "blackglass-mixed-vault-v1" as const;
export const RECOVERY_CORPUS_MANIFEST_SHA256 =
  "6c761cf6226399283726fc29036e2ec35b961c106a18c3fbd8fd36da70e81d68" as const;

// Keep compressed bytes in source so a zlib/runtime update cannot silently
// change the versioned corpus identity.
const RECOVERY_CHART_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAKAAAABQCAIAAAARP+ljAAAFHklEQVR4nLXCgWYQUBSA4fs891HKkSVpkiXTzDTH1J1ZZjbT" +
  "bSbLkc2RJdNMTibNMc1uyqSZLLMH6in+z1fqrYGWW4HWW462Wx2dtxq61NsDLbcDrbcdbbc7Om83dKky0CKBVnG0SUenNHSp" +
  "dwZa7gRa7zja7nR03mnoUicGWiYCrROOtomOzomGLvXuQMvdQOtdR9vdjs67DV3qvYGWe4HWe462ex2d9xq61PsDLfcDrfcd" +
  "bfc7Ou83dKkPBloeBFofONoedHQ+aOhSJwdaJgOtk462yY7OyYYu9eFAy8NA60NH28OOzocNXeqjgZZHgdZHjrZHHZ2PGrrU" +
  "qYGWqUDrlKNtqqNzqqFLfTzQ8jjQ+tjR9rij83FDl/pkoOVJoPWJo+1JR+eThi51eqBlOtA67Wib7uicbuhSnw60PA20PnW0" +
  "Pe3ofNrQpc4MtMwEWmccbTMdnTMNXersQMtsoHXW0Tbb0Tnb0KXODbTMBVrnHG1zHZ1zDV3qs4GWZ4HWZ462Zx2dzxq61PmB" +
  "lvlA67yjbb6jc76hS9WBFg20qqNNOzq1oUtdGGhZCLQuONoWOjoXGrrU5wMtzwOtzx1tzzs6nzd0qS8GWl4EWl842l50dL5o" +
  "6FIXB1oWA62LjrbFjs7Fhi51aaBlKdC65Ghb6uhcauhSlwdalgOty4625Y7O5YYu9eVAy8tA60tH28uOzpcNXerKQMtKoHXF" +
  "0bbS0bnS0KWuDrSsBlpXHW2rHZ2rDV3q2kDLWqB1zdG21tG51tClrg+0rAda1x1t6x2d6w1d6sZAy0agdcPRttHRudHQpb4a" +
  "aHkVaH3laHvV0fmqoUt9PdDyOtD62tH2uqPzdUOXujnQshlo3XS0bXZ0bjZ0qVsDLVuB1i1H21ZH51ZDl/pmoOVNoPWNo+1N" +
  "R+ebhi51e6BlO9C67Wjb7ujcbuhS3w60vA20vnW0ve3ofNvQpdpAiwVazdFmHZ3W0KW+G2h5F2h952h719H5rqFL3Rlo2Qm0" +
  "7jjadjo6dxq61N2Blt1A666jbbejc7ehS/WBFg+0uqPNOzq9oUt9P9DyPtD63tH2vqPzfUOXujfQshdo3XO07XV07jV0qR8G" +
  "Wj4EWj842j50dH5o6FI/DrR8DLR+dLR97Oj82NCl7g+07Ada9x1t+x2d+w1d6qeBlk+B1k+Otk8dnZ8autSDgZaDQOuBo+2g" +
  "o/OgoUs9HGg5DLQeOtoOOzoPG7rUzwMtnwOtnx1tnzs6Pzd0qTHQEoHWcLRFR2c0dKlfBlq+BFq/ONq+dHR+aehSjwZajgKt" +
  "R462o47Oo4Yu9etAy9dA61dH29eOzq8NXeq3gZZvgdZvjrZvHZ3fGrrU44GW40DrsaPtuKPzuKFLzYGWDLSmoy07OrOhSz0Z" +
  "aDkJtJ442k46Ok8autTvAy3fA63fHW3fOzq/N3SppwMtp4HWU0fbaUfnaUOXejbQchZoPXO0nXV0njV0qT8GWn4EWn842n50" +
  "dP5o6FJ/DrT8DLT+dLT97Oj82dCl/hpo+RVo/eVo+9XR+auhSz0faDkPtJ472s47Os8butTfAy2/A62/HW2/Ozp/N3SpfwZa" +
  "/gRa/zja/nR0/mnoUi8GWi4CrReOtouOzouGLvVyoOUy0HrpaLvs6Lxs6FL/DrT8DbT+dbT97ej829ClXg20XAVarxxtVx2d" +
  "Vw1d6r+Bln+B1n+Otn8dnf8autTrgZbrQOu1o+26o/O6oUu9GWi5CbTeONpuOjpvGvo/c4PaIvVJXHgAAAAASUVORK5CYII=";

export interface RecoveryCorpusFileEntry {
  path: string;
  size: number;
  sha256: string;
}

export interface RecoveryCorpusIdentity {
  schemaVersion: typeof RECOVERY_CORPUS_SCHEMA_VERSION;
  id: typeof RECOVERY_CORPUS_ID;
  files: number;
  bytes: number;
  manifestSha256: string;
  types: Record<string, number>;
}

const corpusFiles = buildCorpusFiles();
const corpusManifest = [...corpusFiles.entries()]
  .map(([path, bytes]) => ({
    path,
    size: bytes.byteLength,
    sha256: sha256(bytes),
  }))
  .sort((left, right) => compareCodePointStrings(left.path, right.path));
const computedManifestSha256 = sha256(Buffer.from(stableJson(corpusManifest)));
if (computedManifestSha256 !== RECOVERY_CORPUS_MANIFEST_SHA256) {
  throw new Error(
    "Canonical recovery corpus changed without a new version and reviewed digest: " +
      `expected ${RECOVERY_CORPUS_MANIFEST_SHA256}, got ${computedManifestSha256}`,
  );
}
const corpusIdentity: RecoveryCorpusIdentity = {
  schemaVersion: RECOVERY_CORPUS_SCHEMA_VERSION,
  id: RECOVERY_CORPUS_ID,
  files: corpusManifest.length,
  bytes: corpusManifest.reduce((total, file) => total + file.size, 0),
  manifestSha256: RECOVERY_CORPUS_MANIFEST_SHA256,
  types: Object.fromEntries(
    [...corpusManifest.reduce((types, file) => {
      const extension = extname(file.path).toLocaleLowerCase("en-US");
      types.set(extension, (types.get(extension) ?? 0) + 1);
      return types;
    }, new Map<string, number>())].sort(([left], [right]) =>
      compareCodePointStrings(left, right),
    ),
  ),
};

export function canonicalRecoveryCorpusFiles(): Map<string, Buffer> {
  return new Map(
    [...corpusFiles.entries()].map(([path, bytes]) => [path, Buffer.from(bytes)]),
  );
}

export function canonicalRecoveryCorpusIdentity(): RecoveryCorpusIdentity {
  return structuredClone(corpusIdentity);
}

export function assertCanonicalRecoveryCorpusIdentity(
  value: unknown,
): asserts value is RecoveryCorpusIdentity {
  if (stableJson(value) !== stableJson(corpusIdentity)) {
    throw new Error("Recovery evidence does not bind the canonical mixed-file corpus");
  }
}

export function assertCanonicalRecoveryCorpusManifest(
  entries: unknown,
): asserts entries is RecoveryCorpusFileEntry[] {
  if (!Array.isArray(entries)) {
    throw new Error("Recovery manifest does not contain a file list");
  }
  const byPath = new Map<string, RecoveryCorpusFileEntry>();
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry !== "object" ||
      !("path" in entry) ||
      typeof entry.path !== "string" ||
      entry.path.length === 0 ||
      entry.path.startsWith("/") ||
      entry.path
        .split("/")
        .some((segment: string) => !segment || segment === "." || segment === "..") ||
      !("size" in entry) ||
      !Number.isSafeInteger(entry.size) ||
      (entry.size as number) < 0 ||
      !("sha256" in entry) ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256)
    ) {
      throw new Error("Recovery manifest contains a malformed file entry");
    }
    if (byPath.has(entry.path)) {
      throw new Error(`Recovery manifest contains a duplicate path: ${entry.path}`);
    }
    byPath.set(entry.path, entry as RecoveryCorpusFileEntry);
  }
  for (const expected of corpusManifest) {
    const actual = byPath.get(expected.path);
    if (
      !actual ||
      actual.size !== expected.size ||
      actual.sha256 !== expected.sha256 ||
      extname(actual.path).toLocaleLowerCase("en-US") !==
        extname(expected.path).toLocaleLowerCase("en-US")
    ) {
      throw new Error(`Recovery manifest changed canonical corpus file: ${expected.path}`);
    }
  }
}

function buildCorpusFiles(): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const text = (path: string, contents: string): void => {
    files.set(path, Buffer.from(contents));
  };
  text(
    "Home.md",
    `---\ntags: [recovery, sync, e2e]\nstatus: verified-source\n---\n\n# Recovery Drill Home\n\n> [!success] Background sync fixture\n> This vault mixes notes, images, structured data, a canvas, source code, and a PDF.\n\n## Navigation\n\n- [[Projects/Recovery Plan]]\n- [[Research/Field Notes]]\n- [[Journal/2026-07-25]]\n- [[Data/Inventory]]\n- [[Gallery]]\n\n## Visual proof\n\n![[Assets/recovery-chart.png]]\n\n![[Assets/system-map.svg]]\n\n| Stage | Expected result |\n| --- | --- |\n| Client A | Uploads automatically |\n| Server | Stores encrypted revisions |\n| Client B | Restores byte-identical files |\n`,
  );
  text(
    "Projects/Recovery Plan.md",
    `# Recovery Plan\n\n- [x] Connect client A\n- [x] Enable images, PDFs, and other types\n- [ ] Remove the original local client\n- [ ] Restore to a clean client B\n- [ ] Compare every SHA-256 digest\n\n## Acceptance\n\n1. No manual retry after fixture creation.\n2. Server revision count and bytes increase.\n3. The clean client recreates the complete manifest.\n\nSee [[Home]] and [[Research/Field Notes]].\n`,
  );
  text(
    "Research/Field Notes.md",
    `# Field Notes\n\n## Hypothesis\n\nThe patched stock Sync client can preserve the built-in UX while targeting a self-hosted control and data plane.\n\n> [!note]\n> Paths and content should be encrypted before reaching the server.\n\n## Evidence links\n\n- [[Data/Inventory]]\n- [[Gallery]]\n- [[Projects/Recovery Plan]]\n`,
  );
  text(
    "Journal/2026-07-25.md",
    `# 2026-07-25\n\nCreated the recovery corpus from disposable client A.\n\n- Mixed Markdown syntax\n- Multiple nested folders\n- Raster and vector images\n- PDF and structured data\n- Canvas and JavaScript fixture\n\nUnique marker: RECOVERY-20260725-ALPHA\n`,
  );
  text(
    "Gallery.md",
    `# Gallery\n\n## PNG\n\n![[Assets/recovery-chart.png]]\n\n## SVG\n\n![[Assets/system-map.svg]]\n\nThe two images exercise raster and vector attachment synchronization.\n`,
  );
  text(
    "Data/Inventory.md",
    `# Inventory\n\nThe structured fixtures are [[inventory.csv]] and [[sample.json]].\n\n| Kind | File | Purpose |\n| --- | --- | --- |\n| CSV | inventory.csv | Tabular data |\n| JSON | sample.json | Structured metadata |\n| Canvas | ../Boards/Recovery.canvas | Visual graph |\n| Source | ../Snippets/recovery-check.js | Unsupported extension |\n| PDF | ../Documents/recovery-brief.pdf | Document attachment |\n`,
  );
  text(
    "Data/inventory.csv",
    "kind,path,count\nnote,Markdown,6\nimage,Assets,2\ndocument,Documents,1\nstructured,Data,2\n",
  );
  text(
    "Data/sample.json",
    `${JSON.stringify(
      {
        drill: "recovery",
        date: "2026-07-25",
        expected: "byte-identical",
        values: [1, 2, 3, 5, 8],
      },
      null,
      2,
    )}\n`,
  );
  text(
    "Boards/Recovery.canvas",
    `${JSON.stringify(
      {
        nodes: [
          { id: "a", type: "text", text: "Client A", x: 0, y: 0, width: 240, height: 120 },
          {
            id: "s",
            type: "text",
            text: "Blackglass Server",
            x: 360,
            y: 0,
            width: 260,
            height: 120,
          },
          {
            id: "b",
            type: "text",
            text: "Fresh client B",
            x: 760,
            y: 0,
            width: 240,
            height: 120,
          },
        ],
        edges: [
          { id: "e1", fromNode: "a", fromSide: "right", toNode: "s", toSide: "left" },
          { id: "e2", fromNode: "s", fromSide: "right", toNode: "b", toSide: "left" },
        ],
      },
      null,
      2,
    )}\n`,
  );
  text(
    "Snippets/recovery-check.js",
    `export function recoveryMarker() {\n  return "RECOVERY-20260725-ALPHA";\n}\n`,
  );
  files.set(
    "Assets/recovery-chart.png",
    Buffer.from(RECOVERY_CHART_PNG_BASE64, "base64"),
  );
  text(
    "Assets/system-map.svg",
    `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="300" viewBox="0 0 900 300"><rect width="900" height="300" rx="24" fill="#171923"/><g font-family="Arial,sans-serif" text-anchor="middle"><rect x="55" y="85" width="210" height="130" rx="18" fill="#7c3aed"/><rect x="345" y="85" width="210" height="130" rx="18" fill="#2563eb"/><rect x="635" y="85" width="210" height="130" rx="18" fill="#059669"/><g fill="white" font-size="25" font-weight="700"><text x="160" y="155">Client A</text><text x="450" y="155">Blackglass</text><text x="740" y="155">Client B</text></g><g stroke="#d1d5db" stroke-width="7" fill="none"><path d="M265 150h75"/><path d="M555 150h75"/></g><g fill="#d1d5db"><path d="M335 135l25 15-25 15z"/><path d="M625 135l25 15-25 15z"/></g></g></svg>\n`,
  );
  files.set("Documents/recovery-brief.pdf", makePdf());
  return files;
}

function makePdf(): Buffer {
  const stream =
    "BT /F1 24 Tf 72 720 Td (Blackglass recovery drill) Tj 0 -36 Td " +
    "/F1 14 Tf (RECOVERY-20260725-ALPHA) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources " +
      "<< /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "ascii");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => compareCodePointStrings(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

// Evidence identities must not depend on the host's ICU data or locale.
export function compareCodePointStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
