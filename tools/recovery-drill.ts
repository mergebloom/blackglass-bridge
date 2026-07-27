import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { Database } from "bun:sqlite";

const [action, firstArgument, secondArgument] = Bun.argv.slice(2);

if (action === "create") {
  if (!firstArgument) usage();
  const vault = resolve(firstArgument);
  const files = fixtureFiles();
  for (const [path, contents] of files) {
    const target = join(vault, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  console.log(JSON.stringify({ action, vault, files: [...files.keys()] }, null, 2));
} else if (action === "capture") {
  if (!firstArgument || !secondArgument) usage();
  const runRoot = resolve(firstArgument);
  const vault = resolve(secondArgument);
  const manifest = await buildManifest(vault);
  const output = join(runRoot, "recovery-manifest.json");
  await writeJson(output, { capturedAt: Date.now(), vault, files: manifest });
  console.log(JSON.stringify({ action, output, count: manifest.length }, null, 2));
} else if (action === "verify") {
  if (!firstArgument || !secondArgument) usage();
  const runRoot = resolve(firstArgument);
  const restoredVault = resolve(secondArgument);
  const manifest = JSON.parse(
    await readFile(join(runRoot, "recovery-manifest.json"), "utf8"),
  ) as { files: ManifestEntry[] };
  const restored = await buildManifest(restoredVault);
  const expectedMap = new Map(manifest.files.map((entry) => [entry.path, entry]));
  const restoredMap = new Map(restored.map((entry) => [entry.path, entry]));
  const missing = manifest.files.filter((entry) => !restoredMap.has(entry.path));
  const unexpected = restored.filter((entry) => !expectedMap.has(entry.path));
  const changed = manifest.files.filter((entry) => {
    const actual = restoredMap.get(entry.path);
    return actual && (actual.sha256 !== entry.sha256 || actual.size !== entry.size);
  });
  const clientAExists = await Bun.file(join(runRoot, "client-a")).exists();
  const database = new Database(join(runRoot, "server.sqlite"), { readonly: true });
  const server = database
    .query(
      "SELECT COUNT(*) AS revisions, COALESCE(SUM(size), 0) AS revisionBytes, " +
        "COUNT(DISTINCT path) AS encryptedPaths, COALESCE(MAX(uid), 0) AS maxUid FROM revisions",
    )
    .get() as Record<string, number>;
  const vaults = database
    .query("SELECT name, size, version FROM vaults ORDER BY created")
    .all() as Array<Record<string, string | number>>;
  database.close();
  const report = {
    verifiedAt: Date.now(),
    ok: !clientAExists && missing.length === 0 && unexpected.length === 0 && changed.length === 0,
    clientAExists,
    expectedFiles: manifest.files.length,
    restoredFiles: restored.length,
    missing,
    unexpected,
    changed,
    server,
    vaults,
  };
  const output = join(runRoot, "recovery-report.json");
  await writeJson(output, report);
  console.log(JSON.stringify({ action, output, ...report }, null, 2));
  if (!report.ok) process.exitCode = 1;
} else {
  usage();
}

type ManifestEntry = { path: string; size: number; sha256: string };

async function buildManifest(vault: string): Promise<ManifestEntry[]> {
  const paths = await walk(vault);
  const entries: ManifestEntry[] = [];
  for (const path of paths) {
    const relativePath = relative(vault, path).split("\\").join("/");
    if (relativePath === ".DS_Store" || relativePath.startsWith(".obsidian/")) continue;
    const bytes = await readFile(path);
    entries.push({
      path: relativePath,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

async function walk(root: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) output.push(...(await walk(path)));
    else if (entry.isFile() && (await stat(path)).isFile()) output.push(path);
  }
  return output;
}

function fixtureFiles(): Map<string, string | Uint8Array> {
  const files = new Map<string, string | Uint8Array>();
  files.set(
    "Home.md",
    `---\ntags: [recovery, sync, e2e]\nstatus: verified-source\n---\n\n# Recovery Drill Home\n\n> [!success] Background sync fixture\n> This vault mixes notes, images, structured data, a canvas, source code, and a PDF.\n\n## Navigation\n\n- [[Projects/Recovery Plan]]\n- [[Research/Field Notes]]\n- [[Journal/2026-07-25]]\n- [[Data/Inventory]]\n- [[Gallery]]\n\n## Visual proof\n\n![[Assets/recovery-chart.png]]\n\n![[Assets/system-map.svg]]\n\n| Stage | Expected result |\n| --- | --- |\n| Client A | Uploads automatically |\n| Server | Stores encrypted revisions |\n| Client B | Restores byte-identical files |\n`,
  );
  files.set(
    "Projects/Recovery Plan.md",
    `# Recovery Plan\n\n- [x] Connect client A\n- [x] Enable images, PDFs, and other types\n- [ ] Remove the original local client\n- [ ] Restore to a clean client B\n- [ ] Compare every SHA-256 digest\n\n## Acceptance\n\n1. No manual retry after fixture creation.\n2. Server revision count and bytes increase.\n3. The clean client recreates the complete manifest.\n\nSee [[Home]] and [[Research/Field Notes]].\n`,
  );
  files.set(
    "Research/Field Notes.md",
    `# Field Notes\n\n## Hypothesis\n\nThe patched stock Sync client can preserve the built-in UX while targeting a self-hosted control and data plane.\n\n> [!note]\n> Paths and content should be encrypted before reaching the server.\n\n## Evidence links\n\n- [[Data/Inventory]]\n- [[Gallery]]\n- [[Projects/Recovery Plan]]\n`,
  );
  files.set(
    "Journal/2026-07-25.md",
    `# 2026-07-25\n\nCreated the recovery corpus from disposable client A.\n\n- Mixed Markdown syntax\n- Multiple nested folders\n- Raster and vector images\n- PDF and structured data\n- Canvas and JavaScript fixture\n\nUnique marker: RECOVERY-20260725-ALPHA\n`,
  );
  files.set(
    "Gallery.md",
    `# Gallery\n\n## PNG\n\n![[Assets/recovery-chart.png]]\n\n## SVG\n\n![[Assets/system-map.svg]]\n\nThe two images exercise raster and vector attachment synchronization.\n`,
  );
  files.set(
    "Data/Inventory.md",
    `# Inventory\n\nThe structured fixtures are [[inventory.csv]] and [[sample.json]].\n\n| Kind | File | Purpose |\n| --- | --- | --- |\n| CSV | inventory.csv | Tabular data |\n| JSON | sample.json | Structured metadata |\n| Canvas | ../Boards/Recovery.canvas | Visual graph |\n| Source | ../Snippets/recovery-check.js | Unsupported extension |\n| PDF | ../Documents/recovery-brief.pdf | Document attachment |\n`,
  );
  files.set("Data/inventory.csv", "kind,path,count\nnote,Markdown,6\nimage,Assets,2\ndocument,Documents,1\nstructured,Data,2\n");
  files.set(
    "Data/sample.json",
    JSON.stringify({ drill: "recovery", date: "2026-07-25", expected: "byte-identical", values: [1, 2, 3, 5, 8] }, null, 2) + "\n",
  );
  files.set(
    "Boards/Recovery.canvas",
    JSON.stringify(
      {
        nodes: [
          { id: "a", type: "text", text: "Client A", x: 0, y: 0, width: 240, height: 120 },
          { id: "s", type: "text", text: "Blackglass Server", x: 360, y: 0, width: 260, height: 120 },
          { id: "b", type: "text", text: "Fresh client B", x: 760, y: 0, width: 240, height: 120 },
        ],
        edges: [
          { id: "e1", fromNode: "a", fromSide: "right", toNode: "s", toSide: "left" },
          { id: "e2", fromNode: "s", fromSide: "right", toNode: "b", toSide: "left" },
        ],
      },
      null,
      2,
    ) + "\n",
  );
  files.set(
    "Snippets/recovery-check.js",
    `export function recoveryMarker() {\n  return "RECOVERY-20260725-ALPHA";\n}\n`,
  );
  files.set("Assets/recovery-chart.png", makePng(720, 360));
  files.set(
    "Assets/system-map.svg",
    `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="300" viewBox="0 0 900 300"><rect width="900" height="300" rx="24" fill="#171923"/><g font-family="Arial,sans-serif" text-anchor="middle"><rect x="55" y="85" width="210" height="130" rx="18" fill="#7c3aed"/><rect x="345" y="85" width="210" height="130" rx="18" fill="#2563eb"/><rect x="635" y="85" width="210" height="130" rx="18" fill="#059669"/><g fill="white" font-size="25" font-weight="700"><text x="160" y="155">Client A</text><text x="450" y="155">Blackglass</text><text x="740" y="155">Client B</text></g><g stroke="#d1d5db" stroke-width="7" fill="none"><path d="M265 150h75"/><path d="M555 150h75"/></g><g fill="#d1d5db"><path d="M335 135l25 15-25 15z"/><path d="M625 135l25 15-25 15z"/></g></g></svg>\n`,
  );
  files.set("Documents/recovery-brief.pdf", makePdf());
  return files;
}

function makePng(width: number, height: number): Uint8Array {
  const scanline = width * 3 + 1;
  const raw = Buffer.alloc(scanline * height);
  for (let y = 0; y < height; y++) {
    raw[y * scanline] = 0;
    for (let x = 0; x < width; x++) {
      const offset = y * scanline + 1 + x * 3;
      const band = Math.floor((x / width) * 5);
      raw[offset] = 42 + band * 35;
      raw[offset + 1] = 74 + Math.floor((y / height) * 140);
      raw[offset + 2] = 190 - band * 18;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const payload = Buffer.concat([typeBytes, Buffer.from(data)]);
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length, 0);
  typeBytes.copy(output, 4);
  Buffer.from(data).copy(output, 8);
  output.writeUInt32BE(crc32(payload), data.length + 8);
  return output;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makePdf(): Uint8Array {
  const stream = "BT /F1 24 Tf 72 720 Td (Blackglass recovery drill) Tj 0 -36 Td /F1 14 Tf (RECOVERY-20260725-ALPHA) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "ascii");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function usage(): never {
  console.error(
    "Usage: bun run tools/recovery-drill.ts create <vault> | " +
      "capture <run-root> <vault> | verify <run-root> <restored-vault>",
  );
  process.exit(2);
}
