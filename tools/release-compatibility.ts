import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import ts from "typescript";
import { AsarArchive } from "./asar";
import {
  TREE_IDENTITY_FORMAT_VERSION,
  type TreeIdentity,
} from "./tree-identity";
import { isSupportedStableSemver } from "./semver";
import { stableJson } from "./stable-json";

export const COMPATIBILITY_BASELINE_SCHEMA_VERSION = 4;
export const RELEASE_ANALYSIS_FORMAT_VERSION = 5;

export type FileIdentity = { bytes: number; sha256: string };
export type UnpackedJavaScriptFiles = Record<string, FileIdentity>;

export interface CompatibilityAnchor {
  id: string;
  file: string;
  literal: string;
  expectedMatches: number;
}

export interface CompatibilityBaseline {
  schemaVersion: typeof COMPATIBILITY_BASELINE_SCHEMA_VERSION;
  id: string;
  rendererVersion: string;
  officialDmgSha256: string;
  sourceAppTree: TreeIdentity;
  sourceAsarSha256: string;
  sourceWrapperAsarSha256: string;
  keyFiles: Record<"app.js" | "main.js" | "index.html" | "package.json", FileIdentity>;
  javaScriptFiles: Record<string, FileIdentity>;
  unpackedJavaScriptFiles: UnpackedJavaScriptFiles;
  unpackedJavaScriptReview: {
    status: "reviewed";
    reviewedPaths: string[];
  };
  anchors: CompatibilityAnchor[];
  controlPlaneRoutes: Record<string, number>;
  controlPlaneRouteLocations: Record<string, number>;
  controlPlaneRequestHelpers: Record<string, number>;
  networkConstructors: Record<string, number>;
  syncOperations: Record<string, number>;
  syncOperationLocations: Record<string, number>;
  syncMessageShapes: Record<string, number>;
  syncMessageShapeLocations: Record<string, number>;
  syncInboundOperations: Record<string, number>;
}

export interface ReleaseDiscovery {
  rendererVersion: string;
  sourceAsarSha256: string;
  sourceAsarBytes: number;
  dataOffset: number;
  keyFiles: CompatibilityBaseline["keyFiles"];
  javaScriptFiles: CompatibilityBaseline["javaScriptFiles"];
  unpackedJavaScriptFiles: UnpackedJavaScriptFiles;
  anchorMatches: Record<string, number>;
  controlPlaneRoutes: Record<string, number>;
  controlPlaneRouteLocations: Record<string, number>;
  controlPlaneRequestHelpers: Record<string, number>;
  networkConstructors: Record<string, number>;
  syncOperations: Record<string, number>;
  syncOperationLocations: Record<string, number>;
  syncMessageShapes: Record<string, number>;
  syncMessageShapeLocations: Record<string, number>;
  syncInboundOperations: Record<string, number>;
  fileCount: number;
}

export interface CompatibilityCheck {
  id: string;
  ready: boolean;
  expected: unknown;
  actual: unknown;
}

export interface ReleaseAnalysisReport {
  formatVersion: typeof RELEASE_ANALYSIS_FORMAT_VERSION;
  baseline: {
    id: string;
    schemaVersion: typeof COMPATIBILITY_BASELINE_SCHEMA_VERSION;
    sha256: string;
  };
  artifact: {
    sha256: string;
    size: number;
    dataOffset: number;
  };
  packageVersion: string;
  ready: boolean;
  checks: CompatibilityCheck[];
  keyFiles: CompatibilityBaseline["keyFiles"];
  javaScriptFiles: CompatibilityBaseline["javaScriptFiles"];
  unpackedJavaScriptFiles: UnpackedJavaScriptFiles;
  unpackedJavaScriptReview: CompatibilityBaseline["unpackedJavaScriptReview"];
  anchorMatches: Record<string, number>;
  controlPlaneRoutes: Record<string, number>;
  controlPlaneRouteLocations: Record<string, number>;
  controlPlaneRequestHelpers: Record<string, number>;
  networkConstructors: Record<string, number>;
  syncOperations: Record<string, number>;
  syncOperationLocations: Record<string, number>;
  syncMessageShapes: Record<string, number>;
  syncMessageShapeLocations: Record<string, number>;
  syncInboundOperations: Record<string, number>;
  fileCount: number;
}

export interface LoadedCompatibilityBaseline {
  baseline: CompatibilityBaseline;
  sha256: string;
  path: string;
}

export function defaultCompatibilityBaselinePath(rendererVersion: string): string {
  if (!isSupportedStableSemver(rendererVersion)) {
    throw new Error(`Unsafe renderer version for baseline lookup: ${rendererVersion}`);
  }
  return resolve(import.meta.dir, `../compatibility/obsidian-${rendererVersion}.json`);
}

export async function loadCompatibilityBaseline(
  path: string,
): Promise<LoadedCompatibilityBaseline> {
  const resolvedPath = resolve(path);
  const bytes = await readFile(resolvedPath);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Invalid compatibility baseline JSON: ${String(error)}`);
  }
  assertCompatibilityBaseline(value);
  return {
    baseline: value,
    sha256: sha256(bytes),
    path: resolvedPath,
  };
}

export async function loadBaselineForRenderer(
  rendererAsar: Buffer,
  baselinePath?: string,
): Promise<LoadedCompatibilityBaseline> {
  const version = rendererVersion(AsarArchive.fromBuffer(rendererAsar));
  return loadCompatibilityBaseline(
    baselinePath ?? defaultCompatibilityBaselinePath(version),
  );
}

export async function discoverUnpackedJavaScriptFiles(
  resourcesDirectoryArgument: string,
): Promise<UnpackedJavaScriptFiles> {
  const resourcesDirectory = resolve(resourcesDirectoryArgument);
  const resourcesStat = await lstat(resourcesDirectory);
  if (resourcesStat.isSymbolicLink() || !resourcesStat.isDirectory()) {
    throw new Error(`Application Resources must be a real directory: ${resourcesDirectory}`);
  }
  const discovered = new Map<string, FileIdentity>();
  for (const rootName of ["obsidian.asar.unpacked", "app.asar.unpacked"] as const) {
    const root = join(resourcesDirectory, rootName);
    let rootStat;
    try {
      rootStat = await lstat(root);
    } catch (error) {
      if (isMissingPathError(error)) continue;
      throw error;
    }
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error(`Unpacked ASAR root must be a real directory: ${root}`);
    }
    await walkUnpackedJavaScript(root, rootName, "", discovered);
  }
  return Object.fromEntries(
    [...discovered].sort(([left], [right]) => compareStrings(left, right)),
  );
}

export function discoverRendererRelease(
  rendererAsar: Buffer,
  anchors: CompatibilityAnchor[],
  unpackedJavaScriptFiles: UnpackedJavaScriptFiles = {},
): ReleaseDiscovery {
  const archive = AsarArchive.fromBuffer(rendererAsar);
  const appJsBuffer = archive.read("app.js");
  const mainJsBuffer = archive.read("main.js");
  const indexHtmlBuffer = archive.read("index.html");
  const packageJsonBuffer = archive.read("package.json");
  const anchorSources = new Map<string, string>([
    ["app.js", appJsBuffer.toString("utf8")],
    ["main.js", mainJsBuffer.toString("utf8")],
    ["index.html", indexHtmlBuffer.toString("utf8")],
  ]);
  const javaScriptEntries = archive.entries()
    .filter(
      (entry) =>
        /\.(?:cjs|js|mjs)$/u.test(entry.path) &&
        !entry.node.files &&
        !entry.node.unpacked,
    )
    .sort((left, right) => compareStrings(left.path, right.path));
  if (javaScriptEntries.length === 0) {
    throw new Error("Renderer archive contains no packed JavaScript files");
  }
  const javaScriptFiles: CompatibilityBaseline["javaScriptFiles"] = {};
  const routes: string[] = [];
  const routeLocations: string[] = [];
  const requestHelpers: string[] = [];
  const networkConstructors: string[] = [];
  const operations: string[] = [];
  const operationLocations: string[] = [];
  const messageShapes: string[] = [];
  const messageShapeLocations: string[] = [];
  const inboundOperations: string[] = [];
  for (const entry of javaScriptEntries) {
    const buffer = archive.read(entry.path);
    const source = buffer.toString("utf8");
    anchorSources.set(entry.path, source);
    javaScriptFiles[entry.path] = fileIdentity(buffer);
    const network = collectNetworkCompatibility(entry.path, source);
    routes.push(...network.routes);
    routeLocations.push(...network.routeLocations);
    requestHelpers.push(...network.requestHelpers);
    networkConstructors.push(...network.networkConstructors);
    const fileOperations = collectLiteralOperations(source);
    const fileShapes = collectLiteralOperationMessageShapeList(source);
    // Keep both inventories. A literal `op` property can occur in non-Sync
    // libraries, while first-field object shapes are the stronger outbound
    // protocol signal. Binding both to the reviewed baseline makes either
    // class of change visible without misclassifying unrelated JavaScript.
    operations.push(...fileOperations);
    operationLocations.push(...fileOperations.map((operation) => `${entry.path}:${operation}`));
    messageShapes.push(...fileShapes);
    messageShapeLocations.push(...fileShapes.map((shape) => `${entry.path}:${shape}`));
    inboundOperations.push(
      ...collectInboundSyncOperations(source).map((operation) => `${entry.path}:${operation}`),
    );
  }

  return {
    rendererVersion: rendererVersion(archive),
    sourceAsarSha256: sha256(rendererAsar),
    sourceAsarBytes: rendererAsar.length,
    dataOffset: archive.dataOffset,
    keyFiles: {
      "app.js": fileIdentity(appJsBuffer),
      "main.js": fileIdentity(mainJsBuffer),
      "index.html": fileIdentity(indexHtmlBuffer),
      "package.json": fileIdentity(packageJsonBuffer),
    },
    javaScriptFiles,
    unpackedJavaScriptFiles: sortedFileIdentityInventory(unpackedJavaScriptFiles),
    anchorMatches: Object.fromEntries(
      [...anchors]
        .sort((left, right) => compareStrings(left.id, right.id))
        .map((item) => {
          const source = anchorSources.get(item.file);
          if (source === undefined) {
            throw new Error(`Compatibility anchor references a missing file: ${item.file}`);
          }
          return [item.id, countLiteral(source, item.literal)];
        }),
    ),
    controlPlaneRoutes: countValues(routes),
    controlPlaneRouteLocations: countValues(routeLocations),
    controlPlaneRequestHelpers: countValues(requestHelpers),
    networkConstructors: countValues(networkConstructors),
    syncOperations: countValues(operations),
    syncOperationLocations: countValues(operationLocations),
    syncMessageShapes: countValues(messageShapes),
    syncMessageShapeLocations: countValues(messageShapeLocations),
    syncInboundOperations: countValues(inboundOperations),
    fileCount: archive.entries().filter((entry) => !entry.node.files).length,
  };
}

export function analyzeRendererRelease(
  rendererAsar: Buffer,
  loaded: Pick<LoadedCompatibilityBaseline, "baseline" | "sha256">,
  unpackedJavaScriptFiles: UnpackedJavaScriptFiles = {},
): ReleaseAnalysisReport {
  const { baseline, sha256: baselineSha256 } = loaded;
  const discovery = discoverRendererRelease(
    rendererAsar,
    baseline.anchors,
    unpackedJavaScriptFiles,
  );
  const checks: CompatibilityCheck[] = [
    check("renderer-version", baseline.rendererVersion, discovery.rendererVersion),
    check("source-asar-sha256", baseline.sourceAsarSha256, discovery.sourceAsarSha256),
    check("key-files", baseline.keyFiles, discovery.keyFiles),
    check("javascript-files", baseline.javaScriptFiles, discovery.javaScriptFiles),
    check(
      "unpacked-javascript-files",
      baseline.unpackedJavaScriptFiles,
      discovery.unpackedJavaScriptFiles,
    ),
    check(
      "anchor-match-counts",
      Object.fromEntries(
        baseline.anchors
          .map((item) => [item.id, item.expectedMatches] as const)
          .sort(([left], [right]) => compareStrings(left, right)),
      ),
      discovery.anchorMatches,
    ),
    check("control-plane-routes", baseline.controlPlaneRoutes, discovery.controlPlaneRoutes),
    check(
      "control-plane-route-locations",
      baseline.controlPlaneRouteLocations,
      discovery.controlPlaneRouteLocations,
    ),
    check(
      "control-plane-request-helpers",
      baseline.controlPlaneRequestHelpers,
      discovery.controlPlaneRequestHelpers,
    ),
    check("network-constructors", baseline.networkConstructors, discovery.networkConstructors),
    check("sync-operations", baseline.syncOperations, discovery.syncOperations),
    check(
      "sync-operation-locations",
      baseline.syncOperationLocations,
      discovery.syncOperationLocations,
    ),
    check("sync-message-shapes", baseline.syncMessageShapes, discovery.syncMessageShapes),
    check(
      "sync-message-shape-locations",
      baseline.syncMessageShapeLocations,
      discovery.syncMessageShapeLocations,
    ),
    check(
      "sync-inbound-operations",
      baseline.syncInboundOperations,
      discovery.syncInboundOperations,
    ),
  ];
  return {
    formatVersion: RELEASE_ANALYSIS_FORMAT_VERSION,
    baseline: {
      id: baseline.id,
      schemaVersion: COMPATIBILITY_BASELINE_SCHEMA_VERSION,
      sha256: baselineSha256,
    },
    artifact: {
      sha256: discovery.sourceAsarSha256,
      size: discovery.sourceAsarBytes,
      dataOffset: discovery.dataOffset,
    },
    packageVersion: discovery.rendererVersion,
    ready: checks.every((item) => item.ready),
    checks,
    keyFiles: discovery.keyFiles,
    javaScriptFiles: discovery.javaScriptFiles,
    unpackedJavaScriptFiles: discovery.unpackedJavaScriptFiles,
    unpackedJavaScriptReview: baseline.unpackedJavaScriptReview,
    anchorMatches: discovery.anchorMatches,
    controlPlaneRoutes: discovery.controlPlaneRoutes,
    controlPlaneRouteLocations: discovery.controlPlaneRouteLocations,
    controlPlaneRequestHelpers: discovery.controlPlaneRequestHelpers,
    networkConstructors: discovery.networkConstructors,
    syncOperations: discovery.syncOperations,
    syncOperationLocations: discovery.syncOperationLocations,
    syncMessageShapes: discovery.syncMessageShapes,
    syncMessageShapeLocations: discovery.syncMessageShapeLocations,
    syncInboundOperations: discovery.syncInboundOperations,
    fileCount: discovery.fileCount,
  };
}

export async function qualifyRendererRelease(
  rendererAsar: Buffer,
  baselinePath?: string,
  unpackedJavaScriptFiles: UnpackedJavaScriptFiles = {},
): Promise<{
  loadedBaseline: LoadedCompatibilityBaseline;
  report: ReleaseAnalysisReport;
}> {
  const loadedBaseline = await loadBaselineForRenderer(rendererAsar, baselinePath);
  const report = analyzeRendererRelease(
    rendererAsar,
    loadedBaseline,
    unpackedJavaScriptFiles,
  );
  if (!report.ready) {
    const failed = report.checks
      .filter((item) => !item.ready)
      .map((item) => item.id)
      .join(", ");
    throw new Error(`Renderer is not compatible with the reviewed baseline: ${failed}`);
  }
  return { loadedBaseline, report };
}

async function walkUnpackedJavaScript(
  root: string,
  rootName: string,
  parent: string,
  output: Map<string, FileIdentity>,
): Promise<void> {
  const entries = await readdir(join(root, parent), { withFileTypes: true });
  entries.sort((left, right) => compareStrings(left.name, right.name));
  for (const entry of entries) {
    const relativePath = parent ? `${parent}/${entry.name}` : entry.name;
    const normalizedPath = relativePath.normalize("NFC");
    const absolutePath = join(root, relativePath);
    const stat = await lstat(absolutePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Unpacked ASAR trees must not contain symlinks: ${absolutePath}`);
    }
    if (stat.isDirectory()) {
      await walkUnpackedJavaScript(root, rootName, relativePath, output);
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(`Unpacked ASAR tree contains an unsupported entry: ${absolutePath}`);
    }
    if (!isJavaScriptPath(normalizedPath)) continue;
    const inventoryPath = `${rootName}/${normalizedPath}`;
    if (output.has(inventoryPath)) {
      throw new Error(`Duplicate normalized unpacked JavaScript path: ${inventoryPath}`);
    }
    output.set(inventoryPath, fileIdentity(await readFile(absolutePath)));
  }
}

function sortedFileIdentityInventory(
  value: UnpackedJavaScriptFiles,
): UnpackedJavaScriptFiles {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => compareStrings(left, right)),
  );
}

function isJavaScriptPath(path: string): boolean {
  return /\.(?:c|m)?js$/iu.test(path);
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface NetworkCompatibilityDiscovery {
  routes: string[];
  routeLocations: string[];
  requestHelpers: string[];
  networkConstructors: string[];
}

type BrowserNetworkPrimitive =
  | "fetch"
  | "URL"
  | "WebSocket"
  | "XMLHttpRequest"
  | "EventSource"
  | "Request";
type ElectronNetworkPrimitive = "electron.net.fetch" | "electron.net.request";
type NetworkPrimitive = BrowserNetworkPrimitive | ElectronNetworkPrimitive;
type NetworkTarget =
  | NetworkPrimitive
  | "browser.global"
  | "electron"
  | "electron.net";

interface NetworkBindingCandidate {
  alias: ts.Identifier;
  source: ts.Expression;
  properties: string[];
}

interface NetworkProvenance {
  checker: ts.TypeChecker;
  possibleAliases: Map<ts.Symbol, Set<NetworkTarget>>;
  bindings: Map<ts.Symbol, NetworkBindingCandidate[]>;
}

/**
 * Inventories the JavaScript network boundary with a real parser. A regex can
 * enumerate `gw("/literal")`, but silently omits `gw(variable)` and aliases of
 * the helper. That omission is unsafe when reviewing a new minified release,
 * so every discovered control-helper call must have a literal route.
 */
function collectNetworkCompatibility(
  file: string,
  input: string,
): NetworkCompatibilityDiscovery {
  const sourceFile = ts.createSourceFile(
    file,
    input,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(file),
  );
  const parseDiagnostics = (
    sourceFile as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }
  ).parseDiagnostics;
  if (parseDiagnostics.length > 0) {
    const diagnostic = parseDiagnostics[0]!;
    throw new Error(
      `Cannot parse packed JavaScript ${file} at ${diagnostic.start ?? 0}: ` +
        ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
    );
  }

  const checker = createLexicalChecker(sourceFile);
  const possibleNetworkAliases = new Map<ts.Symbol, Set<NetworkTarget>>();
  const networkBindings: NetworkBindingCandidate[] = [];
  const aliasBindings: Array<{ alias: string; source: string }> = [];
  const functions = new Map<string, ts.FunctionLikeDeclaration>();

  visit(sourceFile, (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      collectNetworkBindingCandidates(node.name, node.initializer, networkBindings);
      if (ts.isIdentifier(node.name) && ts.isIdentifier(node.initializer)) {
        aliasBindings.push({ alias: node.name.text, source: node.initializer.text });
      }
      if (ts.isIdentifier(node.name) && isFunctionLike(node.initializer)) {
        functions.set(node.name.text, node.initializer);
      }
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      functions.set(node.name.text, node);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      networkBindings.push({ alias: node.left, source: node.right, properties: [] });
      if (ts.isIdentifier(node.right)) {
        aliasBindings.push({ alias: node.left.text, source: node.right.text });
      }
    } else if (ts.isImportDeclaration(node)) {
      collectElectronImportAliases(node, checker, possibleNetworkAliases);
    }
  });
  const networkBindingGroups = resolvePossibleNetworkAliases(
    checker,
    possibleNetworkAliases,
    networkBindings,
  );
  const provenance: NetworkProvenance = {
    checker,
    possibleAliases: possibleNetworkAliases,
    bindings: networkBindingGroups,
  };

  const networkConstructors: string[] = [];
  for (const binding of networkBindings) {
    const targets = applyNetworkProperties(
      networkTargetsForExpression(binding.source, provenance),
      binding.properties,
    );
    for (const target of targets) {
      if (!isNetworkPrimitive(target)) continue;
      networkConstructors.push(
        `${file}:binding:${binding.alias.text}=${canonicalNetworkPrimitive(target)}`,
      );
    }
  }

  // `gw` is the reviewed 1.12.7 app.js helper. Other files must prove their
  // helper from a POST-capable reviewed transport so unrelated minified
  // identifiers do not become protocol routes merely because they happen to
  // be named `gw`.
  const helperNames = new Set<string>(file === "app.js" ? ["gw"] : []);
  const requestHelpers: string[] = [];
  for (const [name, declaration] of functions) {
    const parameters = new Set(
      declaration.parameters
        .map((parameter) => ts.isIdentifier(parameter.name) ? parameter.name.text : undefined)
        .filter((value): value is string => value !== undefined),
    );
    visit(declaration, (node) => {
      if (!ts.isCallExpression(node)) return;
      const primitives = networkPrimitivesForExpression(node.expression, provenance);
      for (const primitive of primitives) {
        const address = postRequestAddress(node, primitive);
        if (!address || !expressionUsesIdentifier(address, parameters)) continue;
        const target = compactExpression(node.expression, sourceFile);
        const compactAddress = compactExpression(address, sourceFile);
        helperNames.add(name);
        requestHelpers.push(`${file}:${name}->${target}(${compactAddress})`);
        break;
      }
    });
  }

  const helperAliases: Array<{ alias: string; source: string }> = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const binding of aliasBindings) {
      if (!helperNames.has(binding.source) || helperNames.has(binding.alias)) continue;
      helperNames.add(binding.alias);
      helperAliases.push(binding);
      changed = true;
    }
  }
  for (const { alias, source } of helperAliases) {
    requestHelpers.push(`${file}:${alias}=alias(${source})`);
  }

  const routes: string[] = [];
  const routeLocations: string[] = [];
  const rejectedCalls: string[] = [];
  // Reads and invocations are separate compatibility facts. A property call
  // intentionally contributes both, while capturing a sink without invoking
  // it contributes only the read.
  visit(sourceFile, (node) => {
    if (ts.isPropertyAccessExpression(node)) {
      for (const primitive of networkPrimitivesForExpression(node, provenance)) {
        networkConstructors.push(
          `${file}:read:${compactNetworkTarget(
            node,
            primitive,
            provenance,
            sourceFile,
          )}`,
        );
      }
      if (node.name.text === "hostname") {
        networkConstructors.push(`${file}:read:hostname`);
      }
      return;
    }
    if (ts.isElementAccessExpression(node)) {
      for (const primitive of networkPrimitivesForExpression(node, provenance)) {
        networkConstructors.push(
          `${file}:read:${compactNetworkTarget(
            node,
            primitive,
            provenance,
            sourceFile,
          )}:computed`,
        );
      }
      return;
    }
    if (ts.isCallExpression(node)) {
      for (const primitive of networkPrimitivesForExpression(
        node.expression,
        provenance,
      )) {
        networkConstructors.push(
          `${file}:call:${compactNetworkTarget(
            node.expression,
            primitive,
            provenance,
            sourceFile,
          )}`,
        );
      }
      if (isHostnameDescriptorCall(node, provenance)) {
        networkConstructors.push(`${file}:read:URL.prototype.hostname`);
      }
      if (!ts.isIdentifier(node.expression) || !helperNames.has(node.expression.text)) return;
      const route = literalControlRoute(node.arguments[0]);
      if (!route) {
        rejectedCalls.push(
          `${file}:${node.expression.text}(${node.arguments[0]
            ? compactExpression(node.arguments[0], sourceFile)
            : "<missing>"})`,
        );
        return;
      }
      routes.push(route);
      routeLocations.push(`${file}:${node.expression.text}:${route}`);
      return;
    }
    if (ts.isNewExpression(node)) {
      for (const primitive of networkPrimitivesForExpression(
        node.expression,
        provenance,
      )) {
        if (!isNetworkConstructor(primitive)) continue;
        networkConstructors.push(
          `${file}:new:${compactNetworkTarget(
            node.expression,
            primitive,
            provenance,
            sourceFile,
          )}`,
        );
      }
    }
  });
  if (rejectedCalls.length > 0) {
    throw new Error(
      "Control-plane request helpers require literal routes; rejected " +
        rejectedCalls.sort(compareStrings).join(", "),
    );
  }
  return { routes, routeLocations, requestHelpers, networkConstructors };
}

function scriptKindFor(file: string): ts.ScriptKind {
  if (file.endsWith(".mjs")) return ts.ScriptKind.JS;
  if (file.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.JS;
}

function visit(root: ts.Node, callback: (node: ts.Node) => void): void {
  const walk = (node: ts.Node): void => {
    callback(node);
    ts.forEachChild(node, walk);
  };
  walk(root);
}

function isFunctionLike(node: ts.Expression): node is ts.FunctionExpression | ts.ArrowFunction {
  return ts.isFunctionExpression(node) || ts.isArrowFunction(node);
}

function createLexicalChecker(sourceFile: ts.SourceFile): ts.TypeChecker {
  // The checker is used only for lexical binding identity. Omitting libraries
  // leaves browser globals unresolved while still distinguishing local
  // shadows and repeated one-letter names in minified scopes.
  const options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    noEmit: true,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
  };
  const host = ts.createCompilerHost(options, true);
  host.fileExists = (fileName) => fileName === sourceFile.fileName;
  host.readFile = (fileName) =>
    fileName === sourceFile.fileName ? sourceFile.text : undefined;
  host.getSourceFile = (fileName) =>
    fileName === sourceFile.fileName ? sourceFile : undefined;
  host.writeFile = () => {};
  return ts.createProgram([sourceFile.fileName], options, host).getTypeChecker();
}

function directWindowPrimitive(
  node: ts.Expression,
  checker: ts.TypeChecker,
): BrowserNetworkPrimitive | undefined {
  if (
    ts.isPropertyAccessExpression(node) &&
    isUnboundBrowserGlobal(node.expression, checker) &&
    isBrowserNetworkPrimitive(node.name.text)
  ) {
    return node.name.text;
  }
  if (
    ts.isElementAccessExpression(node) &&
    isUnboundBrowserGlobal(node.expression, checker) &&
    node.argumentExpression &&
    (ts.isStringLiteral(node.argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(node.argumentExpression)) &&
    isBrowserNetworkPrimitive(node.argumentExpression.text)
  ) {
    return node.argumentExpression.text;
  }
  return undefined;
}

function isUnboundBrowserGlobal(
  node: ts.Expression,
  checker: ts.TypeChecker,
): node is ts.Identifier {
  return (
    ts.isIdentifier(node) &&
    ["window", "globalThis", "self"].includes(node.text) &&
    !hasLexicalDeclaration(node, checker)
  );
}

function hasLexicalDeclaration(
  node: ts.Identifier,
  checker: ts.TypeChecker,
): boolean {
  return (checker.getSymbolAtLocation(node)?.declarations?.length ?? 0) > 0;
}

function isBrowserNetworkPrimitive(value: string): value is BrowserNetworkPrimitive {
  return (
    value === "fetch" ||
    value === "URL" ||
    value === "WebSocket" ||
    value === "XMLHttpRequest" ||
    value === "EventSource" ||
    value === "Request"
  );
}

function isNetworkPrimitive(value: NetworkTarget): value is NetworkPrimitive {
  return (
    isBrowserNetworkPrimitive(value) ||
    value === "electron.net.fetch" ||
    value === "electron.net.request"
  );
}

function isNetworkConstructor(value: NetworkPrimitive): boolean {
  return (
    value === "URL" ||
    value === "WebSocket" ||
    value === "XMLHttpRequest" ||
    value === "EventSource" ||
    value === "Request"
  );
}

function collectNetworkBindingCandidates(
  name: ts.BindingName,
  source: ts.Expression,
  output: NetworkBindingCandidate[],
  properties: string[] = [],
): void {
  if (ts.isIdentifier(name)) {
    output.push({ alias: name, source, properties });
    return;
  }
  if (!ts.isObjectBindingPattern(name)) return;
  for (const element of name.elements) {
    if (element.dotDotDotToken) continue;
    const property = bindingPropertyName(element.propertyName ?? element.name);
    if (!property) continue;
    collectNetworkBindingCandidates(
      element.name,
      source,
      output,
      [...properties, property],
    );
  }
}

function bindingPropertyName(name: ts.PropertyName | ts.BindingName): string | undefined {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name)
  ) {
    return name.text;
  }
  return undefined;
}

function collectElectronImportAliases(
  node: ts.ImportDeclaration,
  checker: ts.TypeChecker,
  aliases: Map<ts.Symbol, Set<NetworkTarget>>,
): void {
  if (
    (!ts.isStringLiteral(node.moduleSpecifier) &&
      !ts.isNoSubstitutionTemplateLiteral(node.moduleSpecifier)) ||
    !isElectronModuleName(node.moduleSpecifier.text) ||
    !node.importClause
  ) {
    return;
  }
  if (node.importClause.name) {
    setNetworkAlias(
      node.importClause.name,
      "electron",
      checker,
      aliases,
    );
  }
  const bindings = node.importClause.namedBindings;
  if (!bindings) return;
  if (ts.isNamespaceImport(bindings)) {
    setNetworkAlias(bindings.name, "electron", checker, aliases);
    return;
  }
  for (const element of bindings.elements) {
    const imported = (element.propertyName ?? element.name).text;
    if (imported === "net") {
      setNetworkAlias(element.name, "electron.net", checker, aliases);
    }
  }
}

function resolvePossibleNetworkAliases(
  checker: ts.TypeChecker,
  aliases: Map<ts.Symbol, Set<NetworkTarget>>,
  bindings: NetworkBindingCandidate[],
): Map<ts.Symbol, NetworkBindingCandidate[]> {
  // This map is deliberately a union of every proven assignment. Use-site
  // resolution below narrows definitely ordered writes, while ambiguous
  // branches and closures retain all possible network provenance.
  const groups = new Map<ts.Symbol, NetworkBindingCandidate[]>();
  for (const binding of bindings) {
    const symbol = checker.getSymbolAtLocation(binding.alias);
    if (!symbol) continue;
    const group = groups.get(symbol) ?? [];
    group.push(binding);
    groups.set(symbol, group);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [symbol, group] of groups) {
      for (const binding of group) {
        const targets = applyNetworkProperties(
          possibleNetworkTargetsForExpression(binding.source, checker, aliases),
          binding.properties,
        );
        for (const target of targets) {
          if (addPossibleNetworkAlias(aliases, symbol, target)) changed = true;
        }
      }
    }
  }
  return groups;
}

function setNetworkAlias(
  alias: ts.Identifier,
  target: NetworkTarget,
  checker: ts.TypeChecker,
  aliases: Map<ts.Symbol, Set<NetworkTarget>>,
): void {
  const symbol = checker.getSymbolAtLocation(alias);
  if (!symbol) return;
  addPossibleNetworkAlias(aliases, symbol, target);
}

function addPossibleNetworkAlias(
  aliases: Map<ts.Symbol, Set<NetworkTarget>>,
  symbol: ts.Symbol,
  target: NetworkTarget,
): boolean {
  const targets = aliases.get(symbol) ?? new Set<NetworkTarget>();
  const size = targets.size;
  targets.add(target);
  aliases.set(symbol, targets);
  return targets.size !== size;
}

function networkPrimitivesForExpression(
  expression: ts.Expression,
  provenance: NetworkProvenance,
): NetworkPrimitive[] {
  return networkTargetsForExpression(expression, provenance)
    .filter(isNetworkPrimitive)
    .sort(compareStrings);
}

function networkTargetsForExpression(
  expression: ts.Expression,
  provenance: NetworkProvenance,
  resolving: Set<ts.Symbol> = new Set(),
): NetworkTarget[] {
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  if (ts.isCommaListExpression(expression)) {
    const last = expression.elements.at(-1);
    return last ? networkTargetsForExpression(last, provenance, resolving) : [];
  }
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.CommaToken
  ) {
    return networkTargetsForExpression(expression.right, provenance, resolving);
  }
  const direct = directWindowPrimitive(expression, provenance.checker);
  if (direct) return [direct];
  if (ts.isIdentifier(expression)) {
    const symbol = provenance.checker.getSymbolAtLocation(expression);
    if (symbol && (symbol.declarations?.length ?? 0) > 0) {
      return networkTargetsForSymbolAtUse(symbol, expression, provenance, resolving);
    }
    if (["window", "globalThis", "self"].includes(expression.text)) {
      return ["browser.global"];
    }
    if (isBrowserNetworkPrimitive(expression.text)) return [expression.text];
    return [];
  }
  if (isElectronRequireCall(expression, provenance.checker)) return ["electron"];
  const member = networkMemberExpression(expression);
  if (member) {
    return uniqueNetworkTargets(
      networkTargetsForExpression(member.owner, provenance, resolving)
        .map((owner) => networkMemberTarget(owner, member.property))
        .filter((target): target is NetworkTarget => target !== undefined),
    );
  }
  return [];
}

function possibleNetworkTargetsForExpression(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  aliases: Map<ts.Symbol, Set<NetworkTarget>>,
): NetworkTarget[] {
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  if (ts.isCommaListExpression(expression)) {
    const last = expression.elements.at(-1);
    return last ? possibleNetworkTargetsForExpression(last, checker, aliases) : [];
  }
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.CommaToken
  ) {
    return possibleNetworkTargetsForExpression(expression.right, checker, aliases);
  }
  const direct = directWindowPrimitive(expression, checker);
  if (direct) return [direct];
  if (ts.isIdentifier(expression)) {
    const symbol = checker.getSymbolAtLocation(expression);
    if (symbol && (symbol.declarations?.length ?? 0) > 0) {
      return [...(aliases.get(symbol) ?? [])];
    }
    if (["window", "globalThis", "self"].includes(expression.text)) {
      return ["browser.global"];
    }
    return isBrowserNetworkPrimitive(expression.text) ? [expression.text] : [];
  }
  if (isElectronRequireCall(expression, checker)) return ["electron"];
  const member = networkMemberExpression(expression);
  if (!member) return [];
  return uniqueNetworkTargets(
    possibleNetworkTargetsForExpression(member.owner, checker, aliases)
      .map((owner) => networkMemberTarget(owner, member.property))
      .filter((target): target is NetworkTarget => target !== undefined),
  );
}

function networkTargetsForSymbolAtUse(
  symbol: ts.Symbol,
  use: ts.Identifier,
  provenance: NetworkProvenance,
  resolving: Set<ts.Symbol>,
): NetworkTarget[] {
  if (resolving.has(symbol)) return [];
  const bindings = provenance.bindings.get(symbol) ?? [];
  const dominating = latestDominatingBinding(bindings, use);
  if (!dominating) return [...(provenance.possibleAliases.get(symbol) ?? [])];

  const nextResolving = new Set(resolving).add(symbol);
  const targets = applyNetworkProperties(
    networkTargetsForExpression(dominating.source, provenance, nextResolving),
    dominating.properties,
  );
  for (const binding of bindings) {
    if (
      binding === dominating ||
      binding.source.getStart() <= dominating.source.getStart() ||
      binding.source.getStart() >= use.getStart() ||
      bindingDominatesUse(binding, use)
    ) {
      continue;
    }
    targets.push(
      ...applyNetworkProperties(
        networkTargetsForExpression(binding.source, provenance, nextResolving),
        binding.properties,
      ),
    );
  }
  return uniqueNetworkTargets(targets);
}

function latestDominatingBinding(
  bindings: NetworkBindingCandidate[],
  use: ts.Identifier,
): NetworkBindingCandidate | undefined {
  if (bindings.some((binding) => nearestFunction(binding.alias) !== nearestFunction(use))) {
    return undefined;
  }
  return bindings
    .filter((binding) => binding.source.getStart() < use.getStart())
    .filter((binding) => bindingDominatesUse(binding, use))
    .sort((left, right) => right.source.getStart() - left.source.getStart())[0];
}

function bindingDominatesUse(
  binding: NetworkBindingCandidate,
  use: ts.Identifier,
): boolean {
  if (nearestFunction(binding.alias) !== nearestFunction(use)) return false;
  const bindingLocation = directStatementLocation(binding.alias);
  const useLocation = directStatementLocation(use);
  return Boolean(
    bindingLocation &&
      useLocation &&
      bindingLocation.container === useLocation.container &&
      bindingLocation.closest === bindingLocation.direct &&
      bindingLocation.index < useLocation.index,
  );
}

function directStatementLocation(node: ts.Node): {
  container: ts.Node;
  direct: ts.Statement;
  closest: ts.Statement;
  index: number;
} | undefined {
  let closest: ts.Statement | undefined;
  let current: ts.Node | undefined = node;
  while (current?.parent) {
    if (!closest && ts.isStatement(current)) closest = current;
    const statements = statementList(current.parent);
    if (statements && ts.isStatement(current)) {
      const index = statements.indexOf(current);
      if (index >= 0 && closest) {
        return { container: current.parent, direct: current, closest, index };
      }
    }
    current = current.parent;
  }
  return undefined;
}

function statementList(node: ts.Node): readonly ts.Statement[] | undefined {
  if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node)) {
    return node.statements;
  }
  if (ts.isCaseClause(node) || ts.isDefaultClause(node)) return node.statements;
  return undefined;
}

function nearestFunction(node: ts.Node): ts.Node | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionLike(current)) return current;
    current = current.parent;
  }
  return undefined;
}

function applyNetworkProperties(
  targets: NetworkTarget[],
  properties: string[],
): NetworkTarget[] {
  let current = targets;
  for (const property of properties) {
    current = current
      .map((target) => networkMemberTarget(target, property))
      .filter((target): target is NetworkTarget => target !== undefined);
  }
  return uniqueNetworkTargets(current);
}

function uniqueNetworkTargets(targets: NetworkTarget[]): NetworkTarget[] {
  return [...new Set(targets)].sort(compareStrings);
}

function compactNetworkTarget(
  expression: ts.Expression,
  primitive: NetworkPrimitive,
  provenance: NetworkProvenance,
  sourceFile: ts.SourceFile,
): string {
  const symbol = ts.isIdentifier(expression)
    ? provenance.checker.getSymbolAtLocation(expression)
    : undefined;
  if (
    ts.isIdentifier(expression) &&
    symbol &&
    networkTargetsForSymbolAtUse(symbol, expression, provenance, new Set()).includes(
      primitive,
    )
  ) {
    return `${expression.text}[${canonicalNetworkPrimitive(primitive)}]`;
  }
  if (directWindowPrimitive(expression, provenance.checker) === primitive) {
    return canonicalNetworkPrimitive(primitive);
  }
  if (primitive.startsWith("electron.")) {
    return `${compactExpression(expression, sourceFile)}[${primitive}]`;
  }
  return primitive;
}

function canonicalNetworkPrimitive(primitive: NetworkPrimitive): string {
  return primitive.startsWith("electron.") ? primitive : `window.${primitive}`;
}

function networkMemberExpression(
  expression: ts.Expression,
): { owner: ts.Expression; property: string } | undefined {
  if (ts.isPropertyAccessExpression(expression)) {
    return { owner: expression.expression, property: expression.name.text };
  }
  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression &&
    (ts.isStringLiteral(expression.argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(expression.argumentExpression))
  ) {
    return { owner: expression.expression, property: expression.argumentExpression.text };
  }
  return undefined;
}

function networkMemberTarget(
  owner: NetworkTarget,
  property: string,
): NetworkTarget | undefined {
  if (owner === "browser.global" && isBrowserNetworkPrimitive(property)) return property;
  if (owner === "electron" && property === "default") return "electron";
  if (owner === "electron" && property === "net") return "electron.net";
  if (owner === "electron.net" && property === "fetch") return "electron.net.fetch";
  if (owner === "electron.net" && property === "request") return "electron.net.request";
  return undefined;
}

function isElectronRequireCall(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  return (
    ts.isCallExpression(expression) &&
    isUnboundRequire(expression.expression, checker) &&
    expression.arguments.length === 1 &&
    expression.arguments[0] !== undefined &&
    (ts.isStringLiteral(expression.arguments[0]) ||
      ts.isNoSubstitutionTemplateLiteral(expression.arguments[0])) &&
    isElectronModuleName(expression.arguments[0].text)
  );
}

function isUnboundRequire(
  expression: ts.LeftHandSideExpression,
  checker: ts.TypeChecker,
): boolean {
  if (
    ts.isIdentifier(expression) &&
    expression.text === "require" &&
    !hasLexicalDeclaration(expression, checker)
  ) {
    return true;
  }
  const member = networkMemberExpression(expression);
  return Boolean(
    member &&
      member.property === "require" &&
      isUnboundBrowserGlobal(member.owner, checker),
  );
}

function isElectronModuleName(value: string): boolean {
  return value === "electron" || value === "electron/main";
}

function compactExpression(node: ts.Node, sourceFile: ts.SourceFile): string {
  const value = node.getText(sourceFile).replace(/\s+/gu, "");
  return value.length <= 160 ? value : `${value.slice(0, 157)}...`;
}

function expressionUsesIdentifier(node: ts.Node, identifiers: Set<string>): boolean {
  let found = false;
  visit(node, (candidate) => {
    if (ts.isIdentifier(candidate) && identifiers.has(candidate.text)) found = true;
  });
  return found;
}

function literalControlRoute(node: ts.Expression | undefined): string | undefined {
  if (
    !node ||
    (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node)) ||
    !/^\/[A-Za-z0-9_./-]+$/u.test(node.text)
  ) {
    return undefined;
  }
  return node.text;
}

function hasLiteralPostMethod(node: ts.Expression | undefined): boolean {
  if (!node || !ts.isObjectLiteralExpression(node)) return false;
  return node.properties.some((property) => {
    if (!ts.isPropertyAssignment(property)) return false;
    const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
      ? property.name.text
      : undefined;
    return (
      name === "method" &&
      (ts.isStringLiteral(property.initializer) ||
        ts.isNoSubstitutionTemplateLiteral(property.initializer)) &&
      property.initializer.text === "POST"
    );
  });
}

function postRequestAddress(
  node: ts.CallExpression,
  primitive: NetworkPrimitive | undefined,
): ts.Expression | undefined {
  if (primitive === "fetch" || primitive === "electron.net.fetch") {
    return hasLiteralPostMethod(node.arguments[1]) ? node.arguments[0] : undefined;
  }
  if (primitive !== "electron.net.request") return undefined;
  const options = node.arguments[0];
  if (!options || !ts.isObjectLiteralExpression(options) || !hasLiteralPostMethod(options)) {
    return undefined;
  }
  for (const property of options.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
      ? property.name.text
      : undefined;
    if (name === "url") return property.initializer;
  }
  return undefined;
}

function isHostnameDescriptorCall(
  node: ts.CallExpression,
  provenance: NetworkProvenance,
): boolean {
  if (
    !ts.isPropertyAccessExpression(node.expression) ||
    node.expression.name.text !== "getOwnPropertyDescriptor" ||
    !ts.isIdentifier(node.expression.expression) ||
    node.expression.expression.text !== "Object" ||
    node.arguments.length !== 2
  ) {
    return false;
  }
  const [prototype, property] = node.arguments;
  return Boolean(
    prototype &&
      ts.isPropertyAccessExpression(prototype) &&
      prototype.name.text === "prototype" &&
      networkPrimitivesForExpression(prototype.expression, provenance).includes("URL") &&
      property &&
      (ts.isStringLiteral(property) || ts.isNoSubstitutionTemplateLiteral(property)) &&
      property.text === "hostname",
  );
}

function collectLiteralOperations(input: string): string[] {
  return collectMatches(
    input,
    /\bop\s*:\s*(["'])([A-Za-z][A-Za-z0-9_-]{0,63})\1/gu,
    2,
  );
}

function collectLiteralOperationMessageShapeList(input: string): string[] {
  const shapes: string[] = [];
  const pattern = /\{\s*op\s*:\s*(["'])([A-Za-z][A-Za-z0-9_-]{0,63})\1/gu;
  for (const match of input.matchAll(pattern)) {
    if (match.index === undefined || match[2] === undefined) continue;
    const object = readObjectLiteral(input, match.index);
    const fields = topLevelObjectFields(object);
    if (fields[0] !== "op") {
      throw new Error(`Literal operation ${match[2]} is not the first message field`);
    }
    shapes.push(`${match[2]}(${fields.join(",")})`);
  }
  return shapes;
}

export function collectInboundSyncOperations(input: string): string[] {
  const operations: string[] = [];
  const marker = ".prototype.onMessage=function";
  let cursor = 0;
  while ((cursor = input.indexOf(marker, cursor)) !== -1) {
    const nextPrototype = input.indexOf(".prototype.", cursor + marker.length);
    const handler = input.slice(
      cursor,
      nextPrototype === -1 ? Math.min(input.length, cursor + 32_768) : nextPrototype,
    );
    const operationVariable = /\bvar\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*[A-Za-z_$][A-Za-z0-9_$]*\.op\b/u.exec(handler)?.[1];
    if (operationVariable) {
      const escaped = escapeRegExp(operationVariable);
      const literalFirst = new RegExp(
        `(["'])([A-Za-z][A-Za-z0-9_-]{0,63})\\1\\s*===\\s*${escaped}\\b`,
        "g",
      );
      const variableFirst = new RegExp(
        `\\b${escaped}\\s*===\\s*(["'])([A-Za-z][A-Za-z0-9_-]{0,63})\\1`,
        "g",
      );
      for (const pattern of [literalFirst, variableFirst]) {
        for (const match of handler.matchAll(pattern)) {
          if (match[2]) operations.push(match[2]);
        }
      }
    }
    cursor = nextPrototype === -1 ? input.length : nextPrototype;
  }
  return operations;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function readObjectLiteral(input: string, start: number): string {
  let braces = 0;
  let quote: "\"" | "'" | "`" | null = null;
  let escaped = false;
  for (let index = start; index < input.length; index += 1) {
    const character = input[index];
    if (character === undefined) break;
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") {
      quote = character;
    } else if (character === "{") {
      braces += 1;
    } else if (character === "}") {
      braces -= 1;
      if (braces === 0) return input.slice(start, index + 1);
    }
  }
  throw new Error("Unterminated literal operation message object");
}

function topLevelObjectFields(object: string): string[] {
  const body = object.slice(1, -1);
  const fields: string[] = [];
  let segmentStart = 0;
  let braces = 0;
  let brackets = 0;
  let parentheses = 0;
  let quote: "\"" | "'" | "`" | null = null;
  let escaped = false;
  for (let index = 0; index <= body.length; index += 1) {
    const character = body[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") braces += 1;
    else if (character === "}") braces -= 1;
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets -= 1;
    else if (character === "(") parentheses += 1;
    else if (character === ")") parentheses -= 1;
    const boundary =
      index === body.length ||
      (character === "," && braces === 0 && brackets === 0 && parentheses === 0);
    if (!boundary) continue;
    const segment = body.slice(segmentStart, index).trim();
    const name = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*:/u.exec(segment)?.[1];
    if (!name) throw new Error(`Unsupported operation message field: ${segment}`);
    fields.push(name);
    segmentStart = index + 1;
  }
  return fields;
}

function rendererVersion(archive: AsarArchive): string {
  const metadata = JSON.parse(archive.read("package.json").toString("utf8")) as {
    version?: unknown;
  };
  if (!isSupportedStableSemver(metadata.version)) {
    throw new Error("Renderer package has no semantic version");
  }
  return metadata.version;
}

function fileIdentity(value: Buffer): { bytes: number; sha256: string } {
  return { bytes: value.length, sha256: sha256(value) };
}

function countLiteral(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let cursor = 0;
  while ((cursor = haystack.indexOf(needle, cursor)) !== -1) {
    count += 1;
    cursor += needle.length;
  }
  return count;
}

function collectMatches(input: string, pattern: RegExp, group: number): string[] {
  return [...input.matchAll(pattern)]
    .map((match) => match[group])
    .filter((value): value is string => value !== undefined);
}

function countValues(values: Iterable<string>): Record<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries(
    [...counts].sort(([left], [right]) => compareStrings(left, right)),
  );
}

function check(id: string, expected: unknown, actual: unknown): CompatibilityCheck {
  return {
    id,
    ready: stableJson(expected) === stableJson(actual),
    expected,
    actual,
  };
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertCompatibilityBaseline(value: unknown): asserts value is CompatibilityBaseline {
  if (!isRecord(value) || value.schemaVersion !== COMPATIBILITY_BASELINE_SCHEMA_VERSION) {
    throw new Error("Unsupported compatibility baseline schema");
  }
  for (const field of [
    "id",
    "rendererVersion",
    "officialDmgSha256",
    "sourceAsarSha256",
    "sourceWrapperAsarSha256",
  ] as const) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      throw new Error(`Compatibility baseline has invalid ${field}`);
    }
  }
  if (!isSupportedStableSemver(value.rendererVersion)) {
    throw new Error("Compatibility baseline rendererVersion is invalid");
  }
  for (const field of [
    "officialDmgSha256",
    "sourceAsarSha256",
    "sourceWrapperAsarSha256",
  ] as const) {
    if (!/^[a-f0-9]{64}$/u.test(value[field] as string)) {
      throw new Error(`Compatibility baseline has invalid ${field}`);
    }
  }
  assertTreeIdentity(value.sourceAppTree, "sourceAppTree");
  if (!isRecord(value.keyFiles)) throw new Error("Compatibility baseline keyFiles is invalid");
  for (const filename of ["app.js", "main.js", "index.html", "package.json"] as const) {
    const identity = value.keyFiles[filename];
    if (
      !isRecord(identity) ||
      !Number.isSafeInteger(identity.bytes) ||
      (identity.bytes as number) < 0 ||
      typeof identity.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(identity.sha256)
    ) {
      throw new Error(`Compatibility baseline key file is invalid: ${filename}`);
    }
  }
  assertFileIdentityInventory(value.javaScriptFiles, "javaScriptFiles", true);
  assertFileIdentityInventory(
    value.unpackedJavaScriptFiles,
    "unpackedJavaScriptFiles",
    false,
  );
  for (const path of Object.keys(value.unpackedJavaScriptFiles as Record<string, unknown>)) {
    if (
      !path.startsWith("obsidian.asar.unpacked/") &&
      !path.startsWith("app.asar.unpacked/")
    ) {
      throw new Error(`Compatibility baseline has an invalid unpacked path: ${path}`);
    }
  }
  if (
    !isRecord(value.unpackedJavaScriptReview) ||
    value.unpackedJavaScriptReview.status !== "reviewed" ||
    !Array.isArray(value.unpackedJavaScriptReview.reviewedPaths) ||
    value.unpackedJavaScriptReview.reviewedPaths.some(
      (path) => typeof path !== "string",
    ) ||
    stableJson(value.unpackedJavaScriptReview.reviewedPaths) !==
      stableJson(Object.keys(value.unpackedJavaScriptFiles as Record<string, unknown>).sort(compareStrings))
  ) {
    throw new Error(
      "Compatibility baseline must explicitly mark every unpacked JavaScript file reviewed",
    );
  }
  if (!Array.isArray(value.anchors) || value.anchors.length === 0) {
    throw new Error("Compatibility baseline must contain anchors");
  }
  const anchorIds = new Set<string>();
  const reviewedJavaScriptFiles = value.javaScriptFiles as Record<string, unknown>;
  for (const anchor of value.anchors) {
    if (
      !isRecord(anchor) ||
      typeof anchor.id !== "string" ||
      anchorIds.has(anchor.id) ||
      typeof anchor.file !== "string" ||
      (anchor.file !== "index.html" &&
        !Object.prototype.hasOwnProperty.call(reviewedJavaScriptFiles, anchor.file)) ||
      typeof anchor.literal !== "string" ||
      anchor.literal.length === 0 ||
      !Number.isSafeInteger(anchor.expectedMatches) ||
      (anchor.expectedMatches as number) < 1
    ) {
      throw new Error("Compatibility baseline contains an invalid or duplicate anchor");
    }
    anchorIds.add(anchor.id);
  }
  for (const field of [
    "controlPlaneRoutes",
    "controlPlaneRouteLocations",
    "controlPlaneRequestHelpers",
    "networkConstructors",
    "syncOperations",
    "syncOperationLocations",
    "syncMessageShapes",
    "syncMessageShapeLocations",
    "syncInboundOperations",
  ] as const) {
    const inventory = value[field];
    if (!isRecord(inventory)) {
      throw new Error(`Compatibility baseline ${field} is invalid`);
    }
    for (const [name, count] of Object.entries(inventory)) {
      if (!name || !Number.isSafeInteger(count) || (count as number) < 1) {
        throw new Error(`Compatibility baseline ${field} contains an invalid count`);
      }
    }
  }
}

function assertFileIdentityInventory(
  value: unknown,
  label: string,
  requireNonEmpty: boolean,
): void {
  if (!isRecord(value) || (requireNonEmpty && Object.keys(value).length === 0)) {
    throw new Error(`Compatibility baseline ${label} is invalid`);
  }
  for (const [path, identity] of Object.entries(value)) {
    if (
      !isJavaScriptPath(path) ||
      !isRecord(identity) ||
      !Number.isSafeInteger(identity.bytes) ||
      (identity.bytes as number) < 0 ||
      !isSha256(identity.sha256)
    ) {
      throw new Error(`Compatibility baseline ${label} has an invalid entry`);
    }
  }
}

function assertTreeIdentity(value: unknown, label: string): void {
  if (
    !isRecord(value) ||
    value.formatVersion !== TREE_IDENTITY_FORMAT_VERSION ||
    !isSha256(value.sha256)
  ) {
    throw new Error(`Compatibility baseline ${label} is invalid`);
  }
  for (const field of [
    "entries",
    "files",
    "directories",
    "symlinks",
    "fileBytes",
  ] as const) {
    if (!Number.isSafeInteger(value[field]) || (value[field] as number) < 0) {
      throw new Error(`Compatibility baseline ${label}.${field} is invalid`);
    }
  }
  if (
    (value.entries as number) !==
    (value.files as number) + (value.directories as number) + (value.symlinks as number)
  ) {
    throw new Error(`Compatibility baseline ${label} counts are inconsistent`);
  }
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
