import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const mapping = JSON.parse(
  NodeFS.readFileSync(new URL("./scient-alignment-checks.json", import.meta.url)),
);
const matches = (path, prefix) => path.startsWith(prefix);

/** Select consumers conservatively, including paths the maintained map does not know. */
export function selectBoundaries(paths) {
  const selected = new Set();
  const excluded = [];
  const unknown = [];
  for (const path of paths) {
    if (mapping.excludedPrefixes.some((prefix) => matches(path, prefix))) {
      excluded.push(path);
      continue;
    }
    const rows = mapping.globalTriggers.some((prefix) => matches(path, prefix))
      ? mapping.boundaries
      : mapping.boundaries.filter((row) => row.triggers.some((prefix) => matches(path, prefix)));
    if (rows.length === 0) unknown.push(path);
    for (const row of rows.length === 0 ? mapping.boundaries : rows) selected.add(row.id);
  }
  return {
    boundaries: mapping.boundaries.filter((row) => selected.has(row.id)),
    excluded,
    unknown,
  };
}

function parseArgs(argv) {
  const args = {
    cwd: process.cwd(),
    paths: [],
    boundaries: [],
    run: false,
    native: false,
    all: false,
  };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === "--") continue;
    if (["--all", "--run", "--native"].includes(key)) {
      if (seen.has(key)) throw new Error(`Duplicate argument: ${key}`);
      args[key.slice(2)] = true;
    } else if (["--cwd", "--base", "--path", "--boundary"].includes(key)) {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`Missing value: ${key}`);
      if (["--cwd", "--base"].includes(key) && seen.has(key)) {
        throw new Error(`Duplicate argument: ${key}`);
      }
      if (key === "--path") args.paths.push(value);
      else if (key === "--boundary") args.boundaries.push(value);
      else args[key.slice(2)] = value;
    } else throw new Error(`Unsupported argument: ${key}`);
    seen.add(key);
  }
  const modes =
    Number(args.all) +
    Number(Boolean(args.base)) +
    Number(args.paths.length > 0) +
    Number(args.boundaries.length > 0);
  if (modes !== 1)
    throw new Error(
      "Choose exactly one of --all, --base REF, --path PATH (repeatable), or --boundary ID (repeatable)",
    );
  for (const path of args.paths) {
    if (
      NodePath.posix.normalize(path) !== path ||
      path.startsWith("/") ||
      path.startsWith("../") ||
      path.includes("\\") ||
      path.includes("\0") ||
      path === "." ||
      path === ".."
    ) {
      throw new Error(`Expected repository-relative path: ${path}`);
    }
  }
  for (const id of args.boundaries) {
    if (!mapping.boundaries.some((row) => row.id === id))
      throw new Error(`Unknown boundary: ${id}`);
  }
  return args;
}

const git = (cwd, args) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });

/** Run the target checkout's existing suites serially; this never copies lane source into it. */
export function main(argv) {
  const args = parseArgs(argv);
  const cwd = NodeFS.realpathSync(git(args.cwd, ["rev-parse", "--show-toplevel"]).trim());
  const head = git(cwd, ["rev-parse", "HEAD"]).trim();
  const base = args.base
    ? git(cwd, ["rev-parse", "--verify", "--end-of-options", `${args.base}^{commit}`]).trim()
    : null;
  const paths = base
    ? [
        ...new Set(
          [
            ...git(cwd, ["diff", "--no-renames", "--name-only", "-z", base, "--"]).split("\0"),
            ...git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0"),
          ].filter(Boolean),
        ),
      ]
    : args.paths;
  const selection =
    args.all || args.boundaries.length
      ? {
          boundaries: mapping.boundaries.filter(
            (row) => args.all || args.boundaries.includes(row.id),
          ),
          excluded: [],
          unknown: [],
        }
      : selectBoundaries(paths);
  const commands = Object.entries(mapping.groups).flatMap(([id, group]) => {
    const files = [...new Set(selection.boundaries.flatMap((row) => row.checks[id] ?? []))];
    if (!files.length) return [];
    return [
      {
        id,
        cwd: NodePath.join(cwd, group.cwd),
        argv: ["pnpm", ...group.args, ...files],
        files,
        requiredEnv: group.requiredEnv ?? null,
        included: id !== "native" || args.native,
      },
    ];
  });
  const plan = {
    scope: mapping.scope,
    cwd,
    head,
    base,
    paths,
    excluded: selection.excluded,
    unknown: selection.unknown,
    boundaries: selection.boundaries.map((row) => row.id),
    commands,
    limits: selection.boundaries.flatMap((row) => row.limits),
  };
  console.log(JSON.stringify(plan, null, 2));
  if (!args.run) return 0;
  if (git(cwd, ["ls-files", "--unmerged", "-z"]))
    throw new Error(
      "Unresolved index: selection is available, but resolve the candidate before executing checks",
    );
  // Preflight every included file before starting any command. A renamed/missing
  // suite is unavailable evidence, never a substring-filtered empty success.
  for (const command of commands.filter((command) => command.included)) {
    for (const file of command.files) {
      if (!NodeFS.statSync(NodePath.join(command.cwd, file), { throwIfNoEntry: false })?.isFile()) {
        throw new Error(`Unavailable check in target checkout: ${file}`);
      }
    }
    if (command.requiredEnv && !process.env[command.requiredEnv]) {
      throw new Error(`Native checks require ${command.requiredEnv}; no native pass claimed`);
    }
  }
  if (!commands.some((command) => command.included)) {
    console.log("No mapped checks selected; no behavioral qualification claimed.");
  }
  for (const command of commands.filter((command) => command.included)) {
    const start = performance.now();
    const result = NodeChildProcess.spawnSync(command.argv[0], command.argv.slice(1), {
      cwd: command.cwd,
      stdio: "inherit",
    });
    console.log(
      JSON.stringify({
        check: command.id,
        exit: result.status,
        signal: result.signal,
        elapsedSeconds: (performance.now() - start) / 1000,
      }),
    );
    if (result.error) throw result.error;
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href
) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
