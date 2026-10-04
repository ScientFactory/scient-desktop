import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
// Like knip-schemas.ts, use the pinned compiler API; TypeScript 7 has no AST API.
import ts from "typescript-legacy";

// Source counterparts of package.json bin/main and the production build inputs.
// Keep these explicit: adding a new independently loaded artifact needs review.
export const PRODUCTION_ENTRIES = [
  // apps/server/package.json, vite.config.ts pack.entry and build:bundle.
  "apps/server/src/bin.ts",
  "apps/server/src/server.ts",
  "apps/server/src/service-launcher.ts",
  "apps/server/src/analytics-worker.ts",
  "apps/server/src/claude-history-worker.ts",
  "apps/server/src/pdf-validation-worker.ts",
  "apps/server/src/pdf.worker.ts",
  // apps/web/index.html -> bootstrap -> dynamic main import.
  "apps/web/src/bootstrap.ts",
  // apps/web/vite.config.ts second HTML input: scient-document.html.
  "apps/web/src/scient/documentPage/main.tsx",
  // apps/desktop/package.json main and vite.config.ts pack entries.
  "apps/desktop/src/boot.ts",
  "apps/desktop/src/compileCache.ts",
  "apps/desktop/src/main.ts",
  "apps/desktop/src/preload.ts",
  "apps/desktop/src/preview-pick-preload.ts",
  "apps/desktop/src/preview-pip-preload.ts",
  "apps/desktop/src/mac-permission-preload.ts",
  "apps/desktop/src/conversation-review-preload.ts",
  "apps/desktop/src/electron/WindowsForegroundFocusWorker.ts",
  "apps/desktop/src/snapShot/GlobalShiftShortcutWorker.ts",
  "apps/desktop/src/snapShot/RegionSnapShotWorker.ts",
  "apps/desktop/src/snapShot/SnapShotAccessibilityWorker.ts",
  // apps/mobile/package.json main (Expo registerRootComponent).
  "apps/mobile/index.ts",
  // Metro's generate-device-stream.mts embeds a separately bundled WebView.
  "apps/mobile/src/features/devices/device-stream.browser.ts",
  // GNOME shell loads extension.js (metadata.json); Astro loads pages by path.
  "apps/desktop/gnome-extension/extension.js",
  "apps/marketing/src/pages/index.astro",
  "apps/marketing/src/pages/95.astro",
  "apps/marketing/src/pages/download.astro",
  "apps/marketing/src/pages/legal.astro",
  "apps/marketing/src/pages/privacy-policy.astro",
  "apps/marketing/src/pages/security-policy.astro",
  "apps/marketing/src/pages/terms-of-service.astro",
  "apps/marketing/src/pages/schema/t3.json.ts",
  // infra/relay/alchemy.run.ts imports the deployed API worker.
  "infra/relay/src/worker.ts",
];

// Explicit support attribution is limited to reviewed suites. Other imports
// remain possible subjects even when one happens to match the test basename.
export const REVIEWED_TEST_SUPPORT = {
  "apps/server/src/orchestration/Layers/OrchestrationEngine.test.ts": {
    reason:
      "Identifiers, persistence and workspace setup supply engine fixtures and observations; the assertions exercise the old engine and its reactors.",
    modules: [
      "apps/server/src/config.ts",
      "apps/server/src/persistence/Errors.ts",
      "apps/server/src/persistence/Layers/OrchestrationCommandReceipts.ts",
      "apps/server/src/persistence/Layers/OrchestrationEventStore.ts",
      "apps/server/src/persistence/Layers/Sqlite.ts",
      "apps/server/src/persistence/Services/OrchestrationCommandReceipts.ts",
      "apps/server/src/persistence/Services/OrchestrationEventStore.ts",
      "apps/server/src/project/RepositoryIdentityResolver.ts",
      "apps/server/src/scient/threadQueue/Ledger.ts",
      "packages/contracts/src/index.ts",
    ],
  },
  "apps/server/src/orchestration/projector.test.ts": {
    reason:
      "Branded identifiers and event constructors build projector inputs; assertions exercise the projector's state transitions.",
    modules: ["packages/contracts/src/index.ts"],
  },
};

// Published packages' runtime exports are added from package.json below. At the
// initial revision every packages/* workspace is private: its exports resolve
// imports, but must not make unused internals live just by existing in a barrel.
// apps/mobile/eas.json submit.production ships these native targets.
export const MOBILE_PLATFORMS = ["ios", "android"];
const sourcePattern = /(?:\.[cm]?[jt]sx?|\.astro)$/u;
const declarationPattern = /\.d\.[cm]?ts$/u;
const assetPattern =
  /\.(?:json|css|scss|less|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|wasm|node|mp[34]|wav|pdf|xml|glb|gltf)$/u;
const testPattern = /\.(?:test|spec|node-tests)\.[cm]?[jt]sx?$/u;
const helperPattern =
  /(?:^|\/)(?:test|tests|__tests__|testUtils|testkit|testing|fixtures)(?:\/|$)|\.(?:testkit|testFixtures|test-fixtures|fixture|test-harness)\.|(?:TestHelpers|TestUtils|TestFixtures|Harness(?:\.integration)?|Mock)\.[cm]?[jt]sx?$|(?:^|[/.])(?:test-fixtures|test-support)\.[cm]?[jt]sx?$/u;
const ignoredDirectories = new Set([
  "node_modules",
  ".git",
  ".repos",
  ".t3",
  ".scient",
  ".scient-next",
  ".t3-next",
  ".electron-runtime",
  ".generated",
  ".expo",
  ".vite-plus",
  ".vite",
  ".astro",
  "dist",
  "dist-electron",
  "build",
  "coverage",
  "android",
  "ios",
]);
const slash = (path) => path.split(NodePath.sep).join("/");
const isSource = (path) => sourcePattern.test(path) && !declarationPattern.test(path);
const isHelper = (path) => testPattern.test(path) || helperPattern.test(path);

function inventory(root) {
  const files = new Set();
  const manifests = [];
  function walk(directory) {
    for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = NodePath.join(directory, entry.name);
      if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) walk(path);
      else if (entry.isFile()) {
        const relative = slash(NodePath.relative(root, path));
        if (isSource(relative)) files.add(relative);
        if (entry.name === "package.json") {
          manifests.push({
            directory: NodePath.dirname(relative),
            ...JSON.parse(NodeFS.readFileSync(path, "utf8")),
          });
        }
      }
    }
  }
  // Workspace roots from pnpm-workspace.yaml, including local Expo modules.
  for (const directory of [
    "apps",
    "packages",
    "infra",
    "scripts",
    "oxlint-plugin-t3code",
    ".github/scripts",
  ]) {
    if (NodeFS.existsSync(NodePath.join(root, directory))) walk(NodePath.join(root, directory));
  }
  for (const entry of NodeFS.readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && isSource(entry.name)) files.add(entry.name);
  }
  return { files, manifests };
}

/** Audit independently loaded framework inputs without evaluating build code. */
export function discoverProductionInputs(root) {
  const inputs = new Set();
  const configPath = "apps/web/vite.config.ts";
  const config = NodePath.join(root, configPath);
  if (NodeFS.existsSync(config)) {
    const source = ts.createSourceFile(
      configPath,
      NodeFS.readFileSync(config, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const html = new Set();
    function collect(node) {
      if (ts.isStringLiteralLike(node) && node.text.endsWith(".html"))
        html.add(slash(NodePath.join(NodePath.dirname(configPath), node.text)));
      ts.forEachChild(node, collect);
    }
    function visit(node) {
      if (
        ts.isPropertyAssignment(node) &&
        node.name.getText(source).replace(/["']/gu, "") === "input"
      )
        collect(node.initializer);
      else ts.forEachChild(node, visit);
    }
    visit(source);
    if (!html.size) html.add("apps/web/index.html");
    for (const file of [...html].sort()) {
      const content = NodeFS.readFileSync(NodePath.join(root, file), "utf8");
      for (const match of content.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gu)) {
        const src = match[1].replace(/[?#].*$/u, "");
        if (isSource(src) && !/^(?:[a-z]+:)?\/\//iu.test(src))
          inputs.add(
            slash(
              NodePath.join(
                src.startsWith("/") ? "apps/web" : NodePath.dirname(file),
                src.replace(/^\//u, ""),
              ),
            ),
          );
      }
    }
  }
  const pages = NodePath.join(root, "apps/marketing/src/pages");
  function walk(directory) {
    for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && isSource(entry.name) && !isHelper(entry.name))
        inputs.add(slash(NodePath.relative(root, path)));
    }
  }
  if (NodeFS.existsSync(pages)) walk(pages);
  return [...inputs].sort();
}

function runtimeTargets(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(runtimeTargets);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([condition, target]) =>
    condition === "types" || condition === "typesVersions" ? [] : runtimeTargets(target),
  );
}

function exportTargets(manifest, subpath) {
  const exports = manifest.exports;
  if (exports === undefined)
    return subpath === "."
      ? [manifest.module ?? manifest.main ?? "./index.js"]
      : [`./${subpath.slice(2)}`];
  if (
    typeof exports !== "object" ||
    exports === null ||
    Array.isArray(exports) ||
    !Object.keys(exports).some((key) => key.startsWith("."))
  ) {
    return subpath === "." ? runtimeTargets(exports) : [];
  }
  if (Object.hasOwn(exports, subpath)) return runtimeTargets(exports[subpath]);
  // Node chooses the most specific export pattern, not the first JSON key.
  const patterns = Object.keys(exports)
    .filter((key) => key.includes("*"))
    .sort((a, b) => b.indexOf("*") - a.indexOf("*") || b.length - a.length);
  for (const pattern of patterns) {
    const [prefix, suffix] = pattern.split("*");
    if (subpath.startsWith(prefix) && subpath.endsWith(suffix)) {
      const match = subpath.slice(prefix.length, suffix ? -suffix.length : undefined);
      return runtimeTargets(exports[pattern]).map((target) => target.replaceAll("*", match));
    }
  }
  return [];
}

/** Read runtime syntax without evaluating source, fixtures, or build configs. */
export function runtimeImports(path, text) {
  if (path.endsWith(".astro")) {
    // Parse frontmatter and client script blocks, preserving source line numbers.
    const spans = [
      ...text.matchAll(/^(---\r?\n)([\s\S]*?)^---\s*$|(<script\b[^>]*>)([\s\S]*?)<\/script>/gmu),
    ].map((match) => {
      const code = match[2] ?? match[4];
      const start = match.index + (match[1] ?? match[3]).length;
      return { start, end: start + code.length };
    });
    text = text
      .split("")
      .map((character, index) =>
        spans.some((span) => index >= span.start && index < span.end)
          ? character
          : character === "\n"
            ? "\n"
            : " ",
      )
      .join("");
  }
  const source = ts.createSourceFile(
    path.endsWith(".astro") ? `${path}.ts` : path,
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const imports = [];
  const mocked = [];
  const viNames = new Set(["vi", "vitest"]);
  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ["vitest", "vite-plus/test"].includes(statement.moduleSpecifier.text)
    ) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings))
        for (const binding of bindings.elements)
          if (["vi", "vitest"].includes(binding.propertyName?.text ?? binding.name.text))
            viNames.add(binding.name.text);
    }
  }
  const viMethod = (node) =>
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    viNames.has(node.expression.expression.text)
      ? node.expression.name.text
      : undefined;
  const diagnostics = source.parseDiagnostics.map((diagnostic) => ({
    kind: "error",
    file: path,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  }));
  function add(node, expression, kind = "import") {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    if (expression && ts.isStringLiteralLike(expression)) {
      imports.push({ specifier: expression.text, line, kind });
    } else {
      diagnostics.push({
        kind: "warning",
        file: path,
        line,
        message: "Computed runtime import cannot be resolved statically",
      });
    }
  }
  const executionURLs = new Set();
  function urlInitializer(expression, use, seen = new Set()) {
    if (!expression || seen.has(expression)) return undefined;
    seen.add(expression);
    if (ts.isNewExpression(expression) && expression.expression.getText(source) === "URL")
      return expression;
    if (!ts.isIdentifier(expression)) return undefined;
    for (let scope = use.parent; scope; scope = scope.parent) {
      if (
        ts.isFunctionLike(scope) &&
        scope.parameters.some((p) => p.name.getText(source) === expression.text)
      )
        return undefined;
      if (ts.isBlock(scope) || ts.isSourceFile(scope)) {
        for (const statement of scope.statements)
          if (ts.isVariableStatement(statement))
            for (const declaration of statement.declarationList.declarations)
              if (declaration.name.getText(source) === expression.text)
                return urlInitializer(declaration.initializer, declaration, seen);
      }
    }
    return undefined;
  }
  function findWorkers(node) {
    if (ts.isTypeNode(node)) return;
    if (
      ts.isNewExpression(node) &&
      /^(?:.*\.)?(?:Worker|SharedWorker)$/u.test(node.expression.getText(source))
    ) {
      const url = urlInitializer(node.arguments?.[0], node);
      if (url) executionURLs.add(url);
    }
    ts.forEachChild(node, findWorkers);
  }
  findWorkers(source);
  function visit(node, originals = new Map()) {
    // import('x') inside a type, ambient declarations and import type are erased.
    if (
      ts.isTypeNode(node) ||
      (ts.canHaveModifiers(node) &&
        ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword))
    )
      return;
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      if (
        !clause ||
        (!clause.isTypeOnly &&
          (clause.name ||
            !bindings ||
            ts.isNamespaceImport(bindings) ||
            bindings.elements.length === 0 ||
            bindings.elements.some((element) => !element.isTypeOnly)))
      )
        add(node, node.moduleSpecifier);
      return;
    }
    if (ts.isExportDeclaration(node)) {
      if (
        node.moduleSpecifier &&
        !node.isTypeOnly &&
        (!node.exportClause ||
          ts.isNamespaceExport(node.exportClause) ||
          node.exportClause.elements.length === 0 ||
          node.exportClause.elements.some((element) => !element.isTypeOnly))
      )
        add(node, node.moduleSpecifier);
      return;
    }
    if (ts.isImportEqualsDeclaration(node)) {
      if (!node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference))
        add(node, node.moduleReference.expression);
      return;
    }
    if (ts.isCallExpression(node)) {
      const method = viMethod(node);
      if (method === "mock" || method === "doMock") {
        const argument = node.arguments[0];
        const target =
          argument &&
          ts.isCallExpression(argument) &&
          argument.expression.kind === ts.SyntaxKind.ImportKeyword
            ? argument.arguments[0]
            : argument;
        if (target && ts.isStringLiteralLike(target)) mocked.push(target.text);
        else add(node, target, "mock");
        const factory = node.arguments[1];
        if (factory && (ts.isArrowFunction(factory) || ts.isFunctionExpression(factory))) {
          const callback = factory.parameters[0]?.name;
          const scope = new Map(originals);
          for (const parameter of factory.parameters) scope.delete(parameter.name.getText(source));
          if (callback && ts.isIdentifier(callback)) scope.set(callback.text, target);
          visit(factory.body, scope);
        } else if (factory) visit(factory, originals);
        return;
      }
      if (method === "importActual") add(node, node.arguments[0], "actual");
      if (ts.isIdentifier(node.expression) && originals.has(node.expression.text))
        add(node, originals.get(node.expression.text), "actual");
    }
    // A nested parameter or local binding can shadow the factory callback.
    if (ts.isFunctionLike(node) || ts.isBlock(node)) {
      originals = new Map(originals);
      for (const parameter of node.parameters ?? [])
        originals.delete(parameter.name.getText(source));
      if (ts.isBlock(node))
        for (const statement of node.statements)
          if (ts.isVariableStatement(statement))
            for (const declaration of statement.declarationList.declarations)
              originals.delete(declaration.name.getText(source));
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    )
      add(node, node.arguments[0]);
    // Bundler worker URLs are execution edges even without import syntax.
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "URL" &&
      node.arguments?.[1]?.getText(source) === "import.meta.url" &&
      (executionURLs.has(node) ||
        (ts.isStringLiteralLike(node.arguments[0]) &&
          isSource(node.arguments[0].text.replace(/[?#].*$/u, ""))))
    )
      add(node, node.arguments[0], executionURLs.has(node) ? "worker" : "url");
    ts.forEachChild(node, (child) => visit(child, originals));
  }
  visit(source);
  return { imports, mocked, diagnostics };
}

function resolver(root, files, manifests) {
  const packages = new Map(
    manifests.filter((manifest) => manifest.name).map((manifest) => [manifest.name, manifest]),
  );
  const configs = new Map();
  const directories = new Map();
  const resolutions = new Map();
  function options(file) {
    const directory = NodePath.dirname(NodePath.join(root, file));
    if (!directories.has(directory))
      directories.set(directory, ts.findConfigFile(directory, ts.sys.fileExists));
    const config = directories.get(directory);
    if (!configs.has(config)) {
      const read = config && ts.readConfigFile(config, ts.sys.readFile);
      if (read?.error)
        throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, "\n"));
      const parsed = config
        ? ts.parseJsonConfigFileContent(
            read.config,
            ts.sys,
            NodePath.dirname(config),
            undefined,
            config,
          )
        : { options: {}, errors: [] };
      const errors = parsed.errors.filter((error) => ![18002, 18003].includes(error.code));
      if (errors.length)
        throw new Error(
          `Invalid tsconfig ${slash(NodePath.relative(root, config))}: ${errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("; ")}`,
        );
      configs.set(config, parsed.options);
    }
    return {
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowJs: true,
      ...configs.get(config),
    };
  }
  function candidates(path, platform) {
    const normalized = slash(NodePath.normalize(path));
    const extension = normalized.match(sourcePattern)?.[0];
    // Vite/TS source substitution for emitted JS imports; an explicit source
    // extension otherwise names that file. Metro tries platform/native/generic
    // for each extension, selecting one winner per shipped platform.
    const extensions = extension
      ? ({
          ".js": [".ts", ".tsx", ".js", ".jsx"],
          ".mjs": [".mts", ".mjs"],
          ".cjs": [".cts", ".cjs", ".ts"],
        }[extension] ?? [extension])
      : [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".astro"];
    if (files.has(normalized)) return [normalized];
    const bases = extension
      ? [normalized.slice(0, -extension.length)]
      : [normalized, `${normalized}/index`];
    for (const base of bases)
      for (const ext of extensions)
        for (const variant of platform && !/\.(?:ios|android|native)$/u.test(base)
          ? [`.${platform}`, ".native", ""]
          : [""]) {
          const candidate = `${base}${variant}${ext}`;
          if (files.has(candidate)) return [candidate];
        }
    return [];
  }
  function resolve(file, original, platform) {
    // raw source is data, whereas ?worker and ?url refer to executable assets.
    if (/[?&]raw(?:[=&]|$)/u.test(original)) return { targets: [], local: false };
    const specifier = original.replace(/[?#].*$/u, "");
    if (assetPattern.test(specifier)) return { targets: [], local: false };
    if (specifier.split("/").some((part) => ignoredDirectories.has(part)))
      return { targets: [], local: false };
    if (specifier.startsWith("."))
      return {
        targets: candidates(NodePath.join(NodePath.dirname(file), specifier), platform),
        local: true,
      };
    const name = specifier.startsWith("@")
      ? specifier.split("/").slice(0, 2).join("/")
      : specifier.split("/")[0];
    const manifest = packages.get(name);
    if (manifest) {
      const subpath = specifier === name ? "." : `.${specifier.slice(name.length)}`;
      return {
        targets: exportTargets(manifest, subpath).flatMap((target) =>
          candidates(NodePath.join(manifest.directory, target), platform),
        ),
        local: true,
      };
    }
    const compilerOptions = options(file);
    const paths = compilerOptions.paths ?? {};
    const patterns = Object.keys(paths)
      .filter((pattern) =>
        pattern.includes("*")
          ? specifier.startsWith(pattern.split("*")[0]) && specifier.endsWith(pattern.split("*")[1])
          : pattern === specifier,
      )
      .sort(
        (a, b) =>
          (b.includes("*") ? b.indexOf("*") : Infinity) -
          (a.includes("*") ? a.indexOf("*") : Infinity),
      );
    if (patterns.length) {
      const pattern = patterns[0];
      const [prefix, suffix] = pattern.split("*");
      const match = pattern.includes("*")
        ? specifier.slice(prefix.length, suffix ? -suffix.length : undefined)
        : "";
      for (const path of paths[pattern]) {
        const base = compilerOptions.baseUrl ?? compilerOptions.pathsBasePath ?? root;
        const targets = candidates(
          slash(NodePath.relative(root, NodePath.resolve(base, path.replaceAll("*", match)))),
          platform,
        );
        if (targets.length) return { targets, local: true };
      }
      return { targets: [], local: true };
    }
    const key = `${file}\0${specifier}`;
    if (!resolutions.has(key))
      resolutions.set(
        key,
        ts.resolveModuleName(specifier, NodePath.join(root, file), compilerOptions, ts.sys)
          .resolvedModule,
      );
    const resolved = resolutions.get(key);
    const relative = resolved && slash(NodePath.relative(root, resolved.resolvedFileName));
    const targets = relative ? candidates(relative, platform) : [];
    const alias = Object.keys(paths).some((pattern) =>
      pattern.includes("*")
        ? specifier.startsWith(pattern.split("*")[0]) && specifier.endsWith(pattern.split("*")[1])
        : pattern === specifier,
    );
    return { targets, local: alias };
  }
  return { resolve, candidates, options };
}

function readAllowlist(root, path, tests) {
  if (!path) return new Map();
  const entries = JSON.parse(NodeFS.readFileSync(NodePath.resolve(root, path), "utf8"));
  if (!Array.isArray(entries))
    throw new Error("Allowlist must be an array of { test, reason } entries");
  const result = new Map();
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry.test !== "string" ||
      !tests.has(entry.test) ||
      typeof entry.reason !== "string" ||
      !entry.reason.trim() ||
      result.has(entry.test)
    )
      throw new Error(`Invalid, duplicate, or missing test in allowlist: ${JSON.stringify(entry)}`);
    result.set(entry.test, entry.reason.trim());
  }
  return result;
}

/** Follow helpers to the first subject boundary; subjects' dependencies are support. */
function subjectsOf(test, graph, helpers, supportMetadata) {
  const subjects = new Set();
  const seen = new Set([test]);
  const pending = [[test]];
  const witnesses = {};
  const ownStem = test.replace(testPattern, "");
  const ownHelper = (target) =>
    NodePath.basename(target).replace(sourcePattern, "") === NodePath.basename(ownStem) &&
    [NodePath.dirname(test), NodePath.dirname(NodePath.dirname(test))].includes(
      NodePath.dirname(target),
    );
  while (pending.length) {
    const witness = pending.pop();
    for (const target of [...(graph.get(witness.at(-1)) ?? [])].sort()) {
      if (seen.has(target)) continue;
      seen.add(target);
      const path = [...witness, target];
      if (helpers.has(target) && !ownHelper(target)) pending.push(path);
      else {
        subjects.add(target);
        witnesses[target] = path;
      }
    }
  }
  const imports = [...subjects].sort();
  const support = supportMetadata[test];
  if (
    support &&
    (typeof support.reason !== "string" ||
      !support.reason.trim() ||
      !Array.isArray(support.modules) ||
      new Set(support.modules).size !== support.modules.length ||
      support.modules.some((module) => !imports.includes(module)))
  )
    throw new Error(`Invalid reviewed support metadata for ${test}`);
  const selected = imports.filter((file) => !support?.modules.includes(file));
  if (support && !selected.length)
    throw new Error(`Support metadata removes every subject of ${test}`);
  return {
    imports,
    subjects: selected,
    subjectWitnesses: witnesses,
    ...(support ? { supportReason: support.reason } : {}),
  };
}

export function inspectLivecode({
  root = NodePath.resolve(import.meta.dirname, ".."),
  entries = PRODUCTION_ENTRIES,
  allowlist,
  supportMetadata = REVIEWED_TEST_SUPPORT,
} = {}) {
  root = NodePath.resolve(root);
  const { files, manifests } = inventory(root);
  const { resolve, candidates, options } = resolver(root, files, manifests);
  const contexts = [null, ...MOBILE_PLATFORMS];
  const graphs = new Map(contexts.map((platform) => [platform, new Map()]));
  const subjectGraphs = new Map(contexts.map((platform) => [platform, new Map()]));
  const helpers = new Set([...files].filter(isHelper));
  const diagnostics = [];
  const unresolvedEdges = [];
  for (const input of discoverProductionInputs(root))
    if (!entries.includes(input))
      diagnostics.push({
        kind: "error",
        file: input,
        message: "Production input is missing from the explicit entry list",
      });
  for (const file of [...files].sort()) {
    options(file);
    const parsed = runtimeImports(file, NodeFS.readFileSync(NodePath.join(root, file), "utf8"));
    if (
      parsed.imports.some((entry) =>
        ["vite-plus/test", "vitest", "@effect/vitest", "node:test"].includes(entry.specifier),
      )
    )
      helpers.add(file);
    diagnostics.push(...parsed.diagnostics);
    for (const platform of contexts) {
      const targets = new Set();
      const subjectTargets = new Set();
      const mockTargets = new Set(
        parsed.mocked.flatMap((specifier) => resolve(file, specifier, platform).targets),
      );
      for (const imported of parsed.imports) {
        if (imported.kind === "mock") continue;
        const resolved = resolve(file, imported.specifier, platform);
        for (const target of resolved.targets) {
          if (imported.kind !== "actual" && mockTargets.has(target)) continue;
          targets.add(target);
          if (imported.kind !== "url") subjectTargets.add(target);
        }
        if (imported.kind !== "url" && resolved.local && !resolved.targets.length)
          unresolvedEdges.push({
            platform,
            worker: imported.kind === "worker",
            kind: "error",
            file,
            line: imported.line,
            message: `Unresolved local runtime import: ${imported.specifier}`,
          });
      }
      graphs.get(platform).set(file, targets);
      subjectGraphs.get(platform).set(file, subjectTargets);
    }
  }

  const productionEntries = new Set(entries);
  // Only externally published public surfaces are independent roots. Private
  // workspace exports remain ordinary graph edges, including /testing exports.
  for (const manifest of manifests.filter(
    (manifest) => manifest.private !== true && manifest.directory.startsWith("packages/"),
  )) {
    const targets = runtimeTargets(manifest.exports ?? manifest.module ?? manifest.main);
    for (const target of targets) {
      const path = slash(NodePath.join(manifest.directory, target));
      const matches = target.includes("*")
        ? [...files].filter(
            (file) => file.startsWith(path.split("*")[0]) && file.endsWith(path.split("*")[1]),
          )
        : candidates(path, null);
      for (const match of matches) productionEntries.add(match);
      if (!matches.length && isSource(path))
        diagnostics.push({
          kind: "error",
          file: `${manifest.directory}/package.json`,
          message: `Missing published export: ${target}`,
        });
    }
  }
  const reachable = new Set();
  const productionParents = {};
  const reachedContexts = new Set();
  const pending = [...productionEntries].sort().flatMap((file) =>
    (file.startsWith("apps/mobile/") ? MOBILE_PLATFORMS : [null]).map((platform) => ({
      file,
      platform,
      from: null,
    })),
  );
  for (const entry of productionEntries)
    if (!files.has(entry))
      diagnostics.push({ kind: "error", file: entry, message: "Missing production entry point" });
  while (pending.length) {
    const { file, platform, from } = pending.pop();
    const key = `${platform}:${file}`;
    if (reachedContexts.has(key) || !files.has(file)) continue;
    reachedContexts.add(key);
    if (!reachable.has(file)) productionParents[file] = from;
    reachable.add(file);
    if (from && helpers.has(file))
      diagnostics.push({
        kind: "warning",
        file,
        message: `Production imports test support from ${from}`,
      });
    pending.push(
      ...[...graphs.get(platform).get(file)]
        .sort()
        .map((target) => ({ file: target, platform, from: file })),
    );
  }
  for (const { platform, worker, ...diagnostic } of unresolvedEdges) {
    const defaultContext = diagnostic.file.startsWith("apps/mobile/")
      ? platform !== null
      : platform === null;
    if ((defaultContext && !worker) || reachedContexts.has(`${platform}:${diagnostic.file}`)) {
      if (
        !diagnostics.some(
          (entry) =>
            entry.file === diagnostic.file &&
            entry.line === diagnostic.line &&
            entry.message === diagnostic.message,
        )
      )
        diagnostics.push(diagnostic);
    }
  }
  const testFiles = new Set([...files].filter((file) => testPattern.test(file)));
  const allowed = readAllowlist(root, allowlist, testFiles);
  const tests = [...testFiles].sort().map((test) => {
    const platforms = test.startsWith("apps/mobile/") ? MOBILE_PLATFORMS : [null];
    const frontiers = platforms.map((platform) =>
      subjectsOf(test, subjectGraphs.get(platform), helpers, {}),
    );
    const combined = new Map([[test, new Set(frontiers.flatMap((frontier) => frontier.imports))]]);
    const { subjects, imports, supportReason } = subjectsOf(
      test,
      combined,
      new Set(),
      supportMetadata,
    );
    const subjectWitnesses = Object.fromEntries(
      imports.map((subject) => [
        subject,
        frontiers.find((frontier) => frontier.subjectWitnesses[subject]).subjectWitnesses[subject],
      ]),
    );
    const deadSubjects = subjects.filter((subject) => !reachable.has(subject));
    const liveSubjects = subjects.filter((subject) => reachable.has(subject));
    const deadImports = imports.filter((subject) => !reachable.has(subject));
    const status = !subjects.length
      ? "no-subject"
      : !liveSubjects.length
        ? "dead"
        : deadImports.length
          ? "mixed"
          : "live";
    return {
      test,
      status,
      imports,
      subjects,
      deadSubjects,
      liveSubjects,
      deadImports,
      subjectWitnesses,
      ...(supportReason ? { supportReason } : {}),
      ...(allowed.has(test) ? { allowlistReason: allowed.get(test) } : {}),
    };
  });
  return {
    schemaVersion: 1,
    productionEntries: [...productionEntries].sort(),
    reachableFiles: [...reachable].sort(),
    productionParents: Object.fromEntries(
      Object.entries(productionParents).sort(([a], [b]) => a.localeCompare(b)),
    ),
    summary: {
      sourceFiles: files.size,
      reachableFiles: reachable.size,
      tests: tests.length,
      dead: tests.filter((test) => test.status === "dead" && !test.allowlistReason).length,
      allowed: tests.filter((test) => test.status === "dead" && test.allowlistReason).length,
      mixed: tests.filter((test) => test.status === "mixed").length,
      noSubject: tests.filter((test) => test.status === "no-subject").length,
    },
    tests,
    diagnostics: diagnostics
      .filter(
        (entry, index) =>
          diagnostics.findIndex((other) => JSON.stringify(other) === JSON.stringify(entry)) ===
          index,
      )
      .sort(
        (a, b) =>
          a.file.localeCompare(b.file) ||
          (a.line ?? 0) - (b.line ?? 0) ||
          a.message.localeCompare(b.message),
      ),
  };
}

export function formatReport(report) {
  const { summary } = report;
  const lines = [
    `Live-code check: ${summary.tests} tests; ${summary.reachableFiles}/${summary.sourceFiles} source files reachable from production.`,
    `${summary.dead} tests with only dead subjects; ${summary.allowed} allowlisted; ${summary.mixed} mixed; ${summary.noSubject} without runtime subjects.`,
  ];
  for (const test of report.tests.filter(
    (test) => test.status === "dead" || test.status === "mixed",
  )) {
    lines.push(
      `\n${test.status.toUpperCase()} ${test.test}${test.allowlistReason ? ` (allowlisted: ${test.allowlistReason})` : ""}`,
    );
    for (const subject of test.deadSubjects) lines.push(`  unreachable subject: ${subject}`);
    for (const subject of test.deadImports.filter((file) => !test.deadSubjects.includes(file)))
      lines.push(`  unreachable supporting import: ${subject}`);
    if (test.status === "mixed")
      lines.push(`  ${test.liveSubjects.length} live subjects; not a strict failure`);
  }
  for (const diagnostic of report.diagnostics)
    lines.push(
      `\n${diagnostic.kind.toUpperCase()} ${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}` : ""}: ${diagnostic.message}`,
    );
  return lines.join("\n");
}

export function runLivecode(argv, options = {}) {
  let strict = false;
  let format = "text";
  let allowlist;
  try {
    for (let index = 0; index < argv.length; index += 1) {
      const flag = argv[index];
      if (flag === "--strict") strict = true;
      else if (flag === "--format" || flag === "--allowlist") {
        const value = argv[++index];
        if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
        if (flag === "--format") format = value;
        else allowlist = value;
      } else throw new Error(`Unsupported argument: ${flag}`);
    }
    if (!["text", "json"].includes(format)) throw new Error("--format must be text or json");
    const report = inspectLivecode({ ...options, allowlist });
    return {
      report,
      output: format === "json" ? JSON.stringify(report, null, 2) : formatReport(report),
      exitCode:
        strict &&
        (report.summary.dead > 0 ||
          report.diagnostics.some((diagnostic) => diagnostic.kind === "error"))
          ? 1
          : 0,
    };
  } catch (error) {
    return {
      output:
        format === "json"
          ? JSON.stringify({ error: error.message })
          : `Live-code check unavailable: ${error.message}`,
      exitCode: argv.includes("--strict") ? 1 : 0,
    };
  }
}

if (
  process.argv[1] &&
  NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href === import.meta.url
) {
  const result = runLivecode(process.argv.slice(2));
  console.log(result.output);
  process.exitCode = result.exitCode;
}
