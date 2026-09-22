import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

// Only CLI/schema differences live here. Ownership and integration locators remain
// in the existing manifests, not in a second alignment policy registry.
const definitions = {
  onboarding: { schema: 2, signals: "onboardingDiffSignals" },
  skills: { schema: 1, signals: "skillDiffSignals" },
  analysis: { schema: 2, signals: "analysisDiffSignals" },
  latex: { schema: 2, signals: "latexDiffSignals" },
};

function git(cwd, args, env = process.env) {
  return NodeChildProcess.execFileSync("git", ["--literal-pathspecs", ...args], {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--") continue;
    if (!["--base", "--head", "--snapshot", "--upstream-ref", "--format"].includes(key)) {
      throw new Error(`Unsupported argument: ${key}`);
    }
    const value = argv[++i];
    if (!value || value.startsWith("--") || Object.hasOwn(args, key)) {
      throw new Error(`Missing value or duplicate argument: ${key}`);
    }
    args[key] = value;
  }
  if (args["--head"] && (!args["--base"] || args["--snapshot"])) {
    throw new Error("--head requires --base and cannot be combined with --snapshot");
  }
  if (args["--snapshot"] && !["index", "working-tree"].includes(args["--snapshot"])) {
    throw new Error("--snapshot must be index or working-tree");
  }
  if (args["--format"] && !["text", "json"].includes(args["--format"])) {
    throw new Error("--format must be text or json");
  }
  return args;
}

const commit = (run, ref) =>
  run(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).trim();
const read = (run, tree, path) => run(["show", `${tree}:${path}`]);
const treePaths = (run, tree) =>
  new Set(run(["ls-tree", "-r", "--name-only", "-z", tree]).split("\0").filter(Boolean));
const inside = (path, root) => path === root || path.startsWith(`${root}/`);
const exists = (paths, path) => [...paths].some((entry) => inside(entry, path));
const validPath = (path) =>
  typeof path === "string" &&
  path.length > 0 &&
  path !== "." &&
  path !== ".." &&
  !path.startsWith("/") &&
  !path.startsWith("../") &&
  !path.includes("\\") &&
  !path.includes("\0") &&
  NodePath.posix.normalize(path) === path;

function snapshot(run, mode, env, resources) {
  if (run(["ls-files", "--unmerged", "-z"])) {
    throw new Error("Unresolved index conflicts: finish resolving them before seam verification");
  }
  const objects = run(["rev-parse", "--path-format=absolute", "--git-path", "objects"]).trim();
  const index = run(["rev-parse", "--path-format=absolute", "--git-path", "index"]).trim();
  resources.directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-seam-snapshot-"));
  env.GIT_INDEX_FILE = NodePath.join(resources.directory, "index");
  env.GIT_OBJECT_DIRECTORY = NodePath.join(resources.directory, "objects");
  NodeFS.mkdirSync(env.GIT_OBJECT_DIRECTORY);
  env.GIT_ALTERNATE_OBJECT_DIRECTORIES = [
    JSON.stringify(objects),
    env.GIT_ALTERNATE_OBJECT_DIRECTORIES,
  ]
    .filter(Boolean)
    .join(NodePath.delimiter);
  // All object/index writes remain private, including write-tree. Keep the
  // objects alive until every check finishes, then dispose them in finally.
  if (NodeFS.existsSync(index)) NodeFS.copyFileSync(index, env.GIT_INDEX_FILE);
  else run(["read-tree", "--empty"]);
  if (mode === "working-tree") run(["add", "--all", "--", "."]);
  return run(["write-tree"]).trim();
}

function context(cwd, args, resources) {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
  const env = { ...process.env };
  const stats = { gitCommands: 1, diffBatches: 0 };
  const run = (params) => {
    stats.gitCommands += 1;
    return git(root, params, env);
  };
  const base = args["--base"] ? commit(run, args["--base"]) : null;
  const head = args["--head"] ? commit(run, args["--head"]) : null;
  const mode = head ? "commit" : (args["--snapshot"] ?? "working-tree");
  const tree = head
    ? run(["rev-parse", `${head}^{tree}`]).trim()
    : snapshot(run, mode, env, resources);
  const upstreamRef =
    args["--upstream-ref"] ?? JSON.parse(read(run, tree, "upstream-state.json")).integrationBase;
  if (typeof upstreamRef !== "string" || !upstreamRef) {
    throw new Error("Supply --upstream-ref or a valid integrationBase in the inspected snapshot");
  }
  const upstream = commit(run, upstreamRef);
  const paths = treePaths(run, tree);
  const basePaths = base ? treePaths(run, base) : new Set();
  const upstreamPaths = treePaths(run, upstream);
  // No rename heuristic: both sides of a move, plus deletions and type changes,
  // must be considered. NUL delimiters preserve spaces and unusual filenames.
  const changed = base
    ? run(["diff", "--no-renames", "--name-only", "-z", base, tree, "--"])
        .split("\0")
        .filter(Boolean)
    : [];
  const references = changed.filter((path) => path.startsWith(".repos/"));
  return {
    run,
    stats,
    base,
    head,
    mode,
    tree,
    upstream,
    paths,
    basePaths,
    upstreamPaths,
    changed,
    references,
  };
}

function readDiffs(ctx) {
  const result = new Map();
  const paths = ctx.changed.filter((path) => !path.startsWith(".repos/"));
  // Bounded argv and output, one read per batch shared across all four checks.
  // Raw NUL-delimited paths avoid parsing Git's quoted display filenames.
  for (let i = 0; i < paths.length; i += 64) {
    ctx.stats.diffBatches += 1;
    const output = ctx.run([
      "diff",
      "--raw",
      "-z",
      "--patch",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--no-renames",
      "--unified=0",
      ctx.base,
      ctx.tree,
      "--",
      ...paths.slice(i, i + 64),
    ]);
    const boundary = output.indexOf("\0\0");
    if (boundary < 0) throw new Error("Unable to decode batched Git diff");
    const records = output.slice(0, boundary).split("\0");
    const patches = output.slice(boundary + 2).split(/(?=^diff --git )/mu);
    if (records.length % 2 !== 0 || !patches.every((patch) => patch.startsWith("diff --git ")))
      throw new Error("Incomplete batched Git diff");
    let patchIndex = 0;
    for (let j = 0; j < records.length; j += 2) {
      const typeChange = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ T$/u.exec(records[j]);
      const count = typeChange ? 2 : 1;
      const sections = patches.slice(patchIndex, patchIndex + count);
      // A raw T record has one path but Git emits a deletion and an addition.
      // Retain both so removed signals are audited too, without consuming the
      // following file's patch. Filenames still come only from the raw records.
      if (
        sections.length !== count ||
        (typeChange &&
          (!sections[0].includes(`\ndeleted file mode ${typeChange[1]}\n`) ||
            !sections[1].includes(`\nnew file mode ${typeChange[2]}\n`)))
      )
        throw new Error("Incomplete batched Git diff");
      result.set(records[j + 1], sections.join(""));
      patchIndex += count;
    }
    if (patchIndex !== patches.length) throw new Error("Incomplete batched Git diff");
  }
  return result;
}

function supportingPath(path, name) {
  if (
    /(^|\/)(__tests__\/|[^/]+\.(test|spec)\.[cm]?[jt]sx?$)/u.test(path) ||
    path.endsWith(".md") ||
    /^scient-[a-z0-9-]+-seams\.json$/u.test(path) ||
    /^scripts\/verify-scient-[a-z0-9-]+-seams\.mjs$/u.test(path) ||
    path === "scripts/scient-seam-check.mjs"
  )
    return true;
  // Preserve the existing checks' package/workflow exclusions.
  if (name === "onboarding") return path === "package.json";
  return (
    path.endsWith("package.json") ||
    path.endsWith("pnpm-lock.yaml") ||
    (["analysis", "latex"].includes(name) && path.startsWith(".github/"))
  );
}

function check(name, ctx) {
  const manifestPath = `scient-${name}-seams.json`;
  const definition = definitions[name];
  const findings = [];
  const report = (kind, message) => findings.push({ kind, message });
  const manifest = JSON.parse(read(ctx.run, ctx.tree, manifestPath));
  const roots = manifest.ownedRoots;
  const files = manifest.ownedFiles;
  const mounts = manifest.upstreamMounts;
  if (
    manifest.schemaVersion !== definition.schema ||
    manifest.owner !== "ScientFactory" ||
    !Array.isArray(roots) ||
    !Array.isArray(files) ||
    !Array.isArray(mounts) ||
    !Array.isArray(manifest[definition.signals]) ||
    !manifest[definition.signals].every(
      (signal) => typeof signal === "string" && signal.length > 0,
    ) ||
    !mounts.every((mount) => mount && typeof mount.anchor === "string" && mount.anchor.length > 0)
  ) {
    return {
      name,
      status: "failed",
      findings: [{ kind: "failed", message: `Invalid ${manifestPath} schema or owner` }],
    };
  }
  const allPaths = [...roots, ...files, ...mounts.map((mount) => mount.path)];
  if (!allPaths.every(validPath) || new Set(allPaths).size !== allPaths.length) {
    return {
      name,
      status: "failed",
      findings: [{ kind: "failed", message: `Invalid or duplicate path in ${manifestPath}` }],
    };
  }
  const signals = manifest[definition.signals].map((signal) => new RegExp(signal, "u"));
  // A reviewed relocation removes the old declaration. Still recognize that
  // old path when auditing its removal, without retaining a dead mount forever.
  let previousRoots = [];
  let previousFiles = [];
  if (ctx.base && ctx.basePaths.has(manifestPath)) {
    const previous = JSON.parse(read(ctx.run, ctx.base, manifestPath));
    previousRoots = previous.ownedRoots;
    previousFiles = [...previous.ownedFiles, ...previous.upstreamMounts.map((mount) => mount.path)];
    if (![...previousRoots, ...previousFiles].every(validPath))
      throw new Error(`Invalid base paths in ${manifestPath}`);
    signals.push(...previous[definition.signals].map((signal) => new RegExp(signal, "u")));
  }
  for (const path of [...roots, ...files]) {
    if (!(files.includes(path) ? ctx.paths.has(path) : exists(ctx.paths, path)))
      report("review-needed", `Owned path missing: ${path}`);
    if (exists(ctx.upstreamPaths, path))
      report("review-needed", `Owned path exists upstream; reconcile classification: ${path}`);
  }
  for (const mount of mounts) {
    if (!ctx.paths.has(mount.path)) {
      report("review-needed", `Mount missing: ${mount.path}`);
    } else if (!read(ctx.run, ctx.tree, mount.path).includes(mount.anchor)) {
      report("review-needed", `Mount ${mount.path} missing locator: ${mount.anchor}`);
    }
    if (!ctx.upstreamPaths.has(mount.path)) {
      report("review-needed", `Mount absent at frozen upstream: ${mount.path}`);
    }
  }
  for (const path of ctx.changed) {
    if (
      allPaths.includes(path) ||
      roots.some((root) => inside(path, root)) ||
      supportingPath(path, name) ||
      path.startsWith(".repos/")
    )
      continue;
    const diff = ctx.diffs.get(path);
    if (diff === undefined) throw new Error(`Missing diff for ${path}`);
    const previouslyClassified =
      previousFiles.includes(path) || previousRoots.some((root) => inside(path, root));
    const inspectedDiff = previouslyClassified
      ? diff
          .split("\n")
          .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
          .join("\n")
      : diff;
    if (signals.some((signal) => signal.test(inspectedDiff))) {
      report("review-needed", `Changed path is not classified in ${manifestPath}: ${path}`);
    }
  }
  return {
    name,
    status: findings.length ? "review-needed" : "passed",
    manifestChanged: ctx.changed.includes(manifestPath),
    findings,
  };
}

// Public for fixture-based tests and other maintainer tooling. No output, fetch,
// branch movement, checkout change, or persistent receipt/cache is performed.
export function inspectScientSeams(
  argv = [],
  { cwd = process.cwd(), names = Object.keys(definitions) } = {},
) {
  let ctx;
  const resources = { directory: null };
  try {
    const args = parseArgs(argv);
    ctx = context(cwd, args, resources);
    ctx.diffs = readDiffs(ctx);
    const checks = names.map((name) => {
      try {
        if (!Object.hasOwn(definitions, name)) throw new Error(`Unknown seam: ${name}`);
        return check(name, ctx);
      } catch (error) {
        return {
          name,
          status: "unavailable",
          findings: [{ kind: "unavailable", message: error.message }],
        };
      }
    });
    return {
      scope: "seam locators and changed-path classification, not behavioral or ancestry proof",
      context: {
        base: ctx.base,
        head: ctx.head,
        snapshot: ctx.mode,
        tree: ctx.tree,
        upstream: ctx.upstream,
      },
      coverage: ctx.base ? "changed-paths" : "inventory-only (no diff audited)",
      changedPaths: ctx.changed,
      referencePaths: ctx.references,
      stats: ctx.stats,
      checks,
    };
  } catch (error) {
    return {
      checks: [
        {
          name: "context",
          status: "unavailable",
          findings: [{ kind: "unavailable", message: error.message }],
        },
      ],
    };
  } finally {
    if (resources.directory) NodeFS.rmSync(resources.directory, { recursive: true, force: true });
  }
}

export function runScientSeams(argv = process.argv.slice(2), options) {
  const result = inspectScientSeams(argv, options);
  if (argv[argv.indexOf("--format") + 1] === "json" && argv.includes("--format")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    if (result.context) {
      process.stdout.write(
        `${result.coverage}; ${result.context.snapshot} tree ${result.context.tree}; base ${result.context.base ?? "none"}; upstream ${result.context.upstream}\n`,
      );
      process.stdout.write(`${result.scope}\n`);
      process.stdout.write(
        `${result.referencePaths.length} reference-snapshot paths listed separately, not product-seam audited; ${result.stats.diffBatches} diff batches, ${result.stats.gitCommands} Git commands\n`,
      );
    }
    for (const check of result.checks) {
      process.stdout.write(`${check.name}: ${check.status}\n`);
      if (check.manifestChanged)
        process.stdout.write(
          "  Manifest changed: review classification changes and behavioral evidence.\n",
        );
      for (const finding of check.findings) process.stdout.write(`  ${finding.message}\n`);
    }
  }
  if (result.checks.some((check) => check.status !== "passed")) process.exitCode = 1;
  return result;
}

if (import.meta.main) runScientSeams();
