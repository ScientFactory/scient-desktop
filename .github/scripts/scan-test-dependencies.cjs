// SCIENT-FORK:START — qualify test inputs that package manifests cannot describe.
// Regenerate with: node .github/scripts/scan-test-dependencies.cjs --write
// The checked-in inventory keeps change detection independent of node_modules.
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "../..");
const inventoryPath = path.join(__dirname, "ci-test-dependencies.json");
const CODE = /\.[cm]?[jt]sx?$/;
const SOURCE = /\.(?:[cm]?[jt]sx?|py)$/;
const TEST =
  /(?:^|\/)(?:__tests__\/.*|test_[^/]+\.py|[^/]+(?:\.(?:test|spec)|\.node-tests?)[.](?:[cm]?[jt]sx?|py))$/;

function scan(packages, repo = root) {
  const ts = createRequire(path.join(root, "scripts/package.json"))("typescript-legacy");
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(path.join(repo, dir), { withFileTypes: true })) {
      if (/^(?:node_modules|dist|dist-electron|\.git|\.vite.*|\.repos)$/.test(entry.name)) continue;
      const file = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) files.push(file);
    }
  }
  for (const pkg of packages) walk(pkg.dir);
  const pythonFiles = files.filter((file) => file.endsWith(".py"));
  const pythonRefs = pythonFiles.length
    ? JSON.parse(
        execFileSync("python3", [path.join(__dirname, "scan-python-test-dependencies.py")], {
          input: JSON.stringify({ root: repo, files: pythonFiles }),
          encoding: "utf8",
        }),
      )
    : {};
  const known = new Set(files);
  const owner = (file) => packages.find((pkg) => file.startsWith(`${pkg.dir}/`));
  const absolute = (file) => path.join(repo, file);
  const relative = (file) => path.relative(repo, file).split(path.sep).join("/");
  const resolveFile = (file) =>
    [
      file,
      ...(/\.[cm]?js$/.test(file)
        ? [
            file
              .replace(/\.js$/, ".ts")
              .replace(/\.mjs$/, ".mts")
              .replace(/\.cjs$/, ".cts"),
            file.replace(/\.js$/, ".tsx"),
          ]
        : []),
      ...[".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json"].flatMap((ext) => [
        file + ext,
        `${file}/index${ext}`,
      ]),
    ].find((candidate) => known.has(candidate));
  const cache = new Map();

  function inspect(file) {
    if (cache.has(file)) return cache.get(file);
    const refs = new Set();
    const imports = new Set();
    if (file.endsWith(".py")) {
      for (const value of pythonRefs[file]) record(value);
      cache.set(file, refs);
      return refs;
    }
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(absolute(file), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const bindings = new Map();
    function declarations(node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const entries = bindings.get(node.name.text) ?? [];
        entries.push(node.initializer);
        bindings.set(node.name.text, entries);
      }
      if (ts.isForOfStatement(node) && ts.isVariableDeclarationList(node.initializer)) {
        for (const declaration of node.initializer.declarations) {
          if (ts.isIdentifier(declaration.name))
            bindings.set(declaration.name.text, [node.expression]);
        }
      }
      ts.forEachChild(node, declarations);
    }
    declarations(source);
    // Union same-named bindings across scopes: over-selection is safe. Unknown
    // template/join tails become a directory prefix, covering future fixtures.
    function values(node, seen = new Set()) {
      if (!node || seen.has(node)) return [];
      seen = new Set([...seen, node]);
      if (ts.isStringLiteralLike(node)) return /[\n\r\0]/.test(node.text) ? [] : [node.text];
      if (ts.isIdentifier(node)) {
        if (node.text === "__dirname") return [path.dirname(absolute(file))];
        if (node.text === "__filename") return [absolute(file)];
        return (bindings.get(node.text) ?? []).flatMap((value) => values(value, seen));
      }
      if (
        ts.isParenthesizedExpression(node) ||
        ts.isAsExpression(node) ||
        ts.isAwaitExpression(node)
      )
        return values(node.expression, seen);
      if (ts.isArrayLiteralExpression(node))
        return node.elements.flatMap((item) => values(item, seen));
      if (ts.isConditionalExpression(node))
        return [...values(node.whenTrue, seen), ...values(node.whenFalse, seen)];
      const text = node.getText(source);
      if (text === "import.meta.url") return [absolute(file)];
      if (text === "import.meta.dirname") return [path.dirname(absolute(file))];
      if (ts.isPropertyAccessExpression(node) && ["pathname", "href"].includes(node.name.text))
        return values(node.expression, seen);
      if (ts.isTemplateExpression(node)) {
        if (/[\n\r\0]/.test(node.head.text)) return [];
        let result = [node.head.text];
        for (const span of node.templateSpans)
          result = combine(
            result,
            values(span.expression, seen).length ? values(span.expression, seen) : ["*"],
            (a, b) => a + b + span.literal.text,
          );
        return result;
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
        return combine(values(node.left, seen), values(node.right, seen), (a, b) => a + b);
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const name = node.expression.getText(source).split(".").at(-1);
        const args = node.arguments ?? [];
        if (name === "cwd") return [absolute(owner(file)?.dir ?? "")];
        if (["fileURLToPath", "pathToFileURL"].includes(name)) return values(args[0], seen);
        if (name === "dirname") return values(args[0], seen).map((value) => path.dirname(value));
        if (name === "URL" && args.length > 1)
          return combine(values(args[1], seen), values(args[0], seen), (base, value) =>
            path.resolve(path.dirname(base), value),
          );
        if (["join", "resolve"].includes(name)) {
          let result = [""];
          for (const arg of args)
            result = combine(result, values(arg, seen).length ? values(arg, seen) : ["*"], (a, b) =>
              path.join(a, b),
            );
          return result;
        }
      }
      return [];
    }
    function combine(left, right, fn) {
      // Extremely large unions retain their common directory rather than
      // silently dropping candidate paths.
      if (left.length * right.length > 256) {
        let prefix = left[0];
        while (prefix && !left.every((value) => value.startsWith(prefix)))
          prefix = prefix.slice(0, -1);
        return [prefix + "*"];
      }
      return left.flatMap((a) => right.map((b) => fn(a, b)));
    }
    function record(value, allowRelative = true) {
      if (!value || /[\n\r\0]/.test(value)) return;
      if (!allowRelative && !path.isAbsolute(value)) return;
      const candidates = path.isAbsolute(value)
        ? [relative(value)]
        : [
            value,
            path.posix.normalize(path.posix.join(path.posix.dirname(file), value)),
            path.posix.join(owner(file)?.dir ?? "", value),
          ];
      for (let candidate of candidates) {
        candidate = candidate.replace(/\?(?:raw|url|worker).*$/, "");
        const wildcard = candidate.search(/[*{[]/);
        if (wildcard !== -1)
          candidate = candidate.slice(0, candidate.lastIndexOf("/", wildcard) + 1);
        if (!candidate || candidate.startsWith("../")) continue;
        const resolved = resolveFile(candidate);
        if (resolved) refs.add(resolved);
        else if (
          candidate.startsWith("docs/") &&
          fs.existsSync(absolute(candidate)) &&
          fs.statSync(absolute(candidate)).isFile()
        )
          refs.add(candidate);
        else if (
          (owner(candidate) || candidate.startsWith("docs/")) &&
          fs.existsSync(absolute(candidate)) &&
          fs.statSync(absolute(candidate)).isDirectory()
        )
          refs.add(candidate.replace(/\/$/, "") + "/");
      }
    }
    function visit(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
        imports.add(node.moduleSpecifier.text);
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          node.expression.getText(source) === "require")
      ) {
        for (const value of values(node.arguments[0])) imports.add(value);
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        // Repository-anchored expressions also cover custom read helpers. Bare
        // strings in assertions describe synthetic workspaces, not this repo.
        for (const value of values(node)) record(value, false);
        const name = node.expression.getText(source).split(".").at(-1);
        if (
          /^(?:readFile(?:Sync|String)?|readDirectory|readdir(?:Sync)?|glob(?:Sync)?)$/.test(name)
        ) {
          for (const value of values(node.arguments?.[0])) record(value);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    for (const specifier of imports) {
      const clean = specifier.replace(/\?.*$/, "");
      const pkg = packages.find((item) => clean === item.name || clean.startsWith(`${item.name}/`));
      if (pkg) {
        refs.add(pkg.dir + "/");
        // The package edge covers every source; follow its exported source too
        // so test helpers can bring their own non-manifest inputs with them.
        const manifest = JSON.parse(fs.readFileSync(absolute(`${pkg.dir}/package.json`), "utf8"));
        const key = clean === pkg.name ? "." : "." + clean.slice(pkg.name.length);
        const exports = manifest.exports ?? {};
        const targets = typeof exports === "string" ? [exports] : [exports[key], exports["./*"]];
        const strings = (value) =>
          typeof value === "string"
            ? [value]
            : value && typeof value === "object"
              ? Object.values(value).flatMap(strings)
              : [];
        for (const target of targets.flatMap(strings))
          record(path.posix.join(pkg.dir, target.replace("*", key.slice(2))));
      } else if (clean.startsWith("~/")) record(`${owner(file)?.dir}/src/${clean.slice(2)}`);
      else if (clean.startsWith(".")) record(path.posix.join(path.posix.dirname(file), clean));
    }
    cache.set(file, refs);
    return refs;
  }

  const dependencies = {};
  const inputs = {};
  let testFiles = 0;
  const add = (map, key, value) => (map[key] ??= new Set()).add(value);
  for (const pkg of packages) {
    const visited = new Set();
    const manifest = JSON.parse(fs.readFileSync(absolute(`${pkg.dir}/package.json`), "utf8"));
    const testCommands = Object.entries(manifest.scripts ?? {})
      .filter(([name]) => /test|smoke/.test(name))
      .map(([, command]) => command)
      .join(" ");
    const pending = files.filter(
      (file) =>
        owner(file)?.name === pkg.name &&
        (TEST.test(file) ||
          (CODE.test(file) && testCommands.includes(file.slice(pkg.dir.length + 1)))),
    );
    testFiles += pending.length;
    while (pending.length) {
      const file = pending.pop();
      if (visited.has(file) || !SOURCE.test(file)) continue;
      visited.add(file);
      for (const ref of inspect(file)) {
        const target = owner(ref);
        if (target && target.name !== pkg.name) add(dependencies, pkg.name, target.name);
        else if (!target && ref.startsWith("docs/")) add(inputs, ref, pkg.name);
        if (SOURCE.test(ref) && known.has(ref)) pending.push(ref);
      }
    }
  }
  const sorted = (map) =>
    Object.fromEntries(
      Object.keys(map)
        .sort()
        .map((key) => [key, [...map[key]].sort()]),
    );
  return {
    testFiles,
    scannedFiles: cache.size,
    dependencies: sorted(dependencies),
    inputs: sorted(inputs),
  };
}

module.exports = { scan };
if (require.main === module) {
  const result = scan(require("./ci-changes.cjs").readWorkspace());
  if (process.argv.includes("--write"))
    fs.writeFileSync(inventoryPath, JSON.stringify(result, null, 2) + "\n");
  else console.log(JSON.stringify(result, null, 2));
}
// SCIENT-FORK:END
