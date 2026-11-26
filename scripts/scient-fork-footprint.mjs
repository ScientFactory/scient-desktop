import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const LIST_LIMIT = 30;

class Unavailable extends Error {}

async function git(cwd, args) {
  const { stdout } = await execFile("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout;
}

function parseArgs(argv) {
  const args = { format: "markdown" };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--") continue;
    if (!["--base", "--head", "--format"].includes(key)) {
      throw new Error(`Unsupported argument: ${key}`);
    }
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    args[key.slice(2)] = value;
  }
  if (!args.base || !args.head) throw new Error("Usage: --base <ref> --head <ref>");
  if (!["markdown", "json"].includes(args.format)) {
    throw new Error("--format must be markdown or json");
  }
  return args;
}

async function resolveCommit(cwd, ref) {
  return (await git(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim();
}

async function integrationBase(cwd, commit) {
  let state;
  try {
    state = JSON.parse(await git(cwd, ["cat-file", "blob", `${commit}:upstream-state.json`]));
  } catch {
    throw new Unavailable(`${commit} has no readable upstream-state.json.`);
  }
  if (typeof state.integrationBase !== "string" || !state.integrationBase) {
    throw new Unavailable(`${commit} records no integrationBase.`);
  }
  try {
    await git(cwd, ["cat-file", "-e", `${state.integrationBase}^{commit}`]);
  } catch {
    throw new Unavailable(
      `T3 integrationBase ${state.integrationBase} (recorded by ${commit}) is not in this clone; fetch it to measure the footprint.`,
    );
  }
  return state.integrationBase;
}

// Raw and numstat records interleave in -z output; numstat paths follow two tabs.
function parseDiff(output) {
  const status = new Map();
  const lines = new Map();
  const tokens = output.split("\0");
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;
    if (token.startsWith(":")) {
      status.set(tokens[++i], token.slice(-1));
      continue;
    }
    const [added, removed] = token.split("\t", 2);
    const path = token.slice(added.length + removed.length + 2);
    lines.set(path, added === "-" ? null : { added: Number(added), removed: Number(removed) });
  }
  const changed = new Map();
  const deleted = new Set();
  for (const [path, code] of status) {
    if (code === "D") deleted.add(path);
    else if (code !== "A") changed.set(path, lines.get(path) ?? null);
  }
  return { changed, deleted };
}

async function measure(cwd, commit) {
  const baseline = await integrationBase(cwd, commit);
  const output = await git(cwd, [
    "diff-tree",
    "-r",
    "-z",
    "--no-renames",
    "--no-ext-diff",
    "--raw",
    "--numstat",
    baseline,
    commit,
    "--",
    ".",
    ":(exclude).repos",
  ]);
  const { changed, deleted } = parseDiff(output);
  let addedLines = 0;
  let removedLines = 0;
  for (const stat of changed.values()) {
    addedLines += stat?.added ?? 0;
    removedLines += stat?.removed ?? 0;
  }
  return {
    commit,
    baseline,
    totals: {
      changedFiles: changed.size,
      addedLines,
      removedLines,
      deletedFiles: deleted.size,
    },
    changed,
    deleted,
  };
}

const sorted = (values) => [...values].toSorted();

export async function measureForkFootprint(argv, { cwd = process.cwd() } = {}) {
  const args = parseArgs(argv);
  const [baseCommit, headCommit] = await Promise.all([
    resolveCommit(cwd, args.base),
    resolveCommit(cwd, args.head),
  ]);
  let base;
  let head;
  try {
    [base, head] = await Promise.all([measure(cwd, baseCommit), measure(cwd, headCommit)]);
  } catch (error) {
    if (error instanceof Unavailable) {
      return { status: "unavailable", base: baseCommit, head: headCommit, reason: error.message };
    }
    throw error;
  }
  const delta = Object.fromEntries(
    Object.keys(head.totals).map((key) => [key, head.totals[key] - base.totals[key]]),
  );
  const summary = (side) => ({ commit: side.commit, baseline: side.baseline, ...side.totals });
  const result = { status: "measured", base: summary(base), head: summary(head), delta };
  if (base.baseline !== head.baseline) {
    const t3Commits = await git(cwd, [
      "rev-list",
      "--count",
      `${base.baseline}..${head.baseline}`,
    ]).then(Number);
    return { ...result, baselineMoved: { from: base.baseline, to: head.baseline, t3Commits } };
  }
  const touchedAtBase = (path) => base.changed.has(path) || base.deleted.has(path);
  const touchedAtHead = (path) => head.changed.has(path) || head.deleted.has(path);
  return {
    ...result,
    baselineMoved: null,
    newlyDiverged: sorted(head.changed.keys()).filter((path) => !touchedAtBase(path)),
    newlyDeleted: sorted(head.deleted).filter((path) => !touchedAtBase(path)),
    returnedToIdentical: sorted([...base.changed.keys(), ...base.deleted]).filter(
      (path) => !touchedAtHead(path),
    ),
  };
}

const short = (sha) => sha.slice(0, 10);
const signed = (value) => (value > 0 ? `+${value}` : value < 0 ? `−${-value}` : "0");

function pathList(title, paths) {
  if (paths.length === 0) return [];
  const shown = paths.slice(0, LIST_LIMIT).map((path) => `- \`${path}\``);
  if (paths.length > LIST_LIMIT) shown.push(`- …and ${paths.length - LIST_LIMIT} more`);
  return ["", `**${title} (${paths.length})**`, "", ...shown];
}

export function formatMarkdown(result) {
  const lines = ["### Scient fork footprint", ""];
  if (result.status === "unavailable") {
    lines.push(`Not measured: ${result.reason}`);
    return `${lines.join("\n")}\n`;
  }
  const { base, head, delta } = result;
  lines.push(
    "Divergence from each ref's T3 `integrationBase`, counted only in files T3 also has. Scient-only files and `.repos/` are excluded. Information only.",
    "",
    `| | Base \`${short(base.commit)}\` | Head \`${short(head.commit)}\` | Change |`,
    "| --- | ---: | ---: | ---: |",
  );
  for (const [key, label] of [
    ["changedFiles", "T3 files changed"],
    ["addedLines", "Lines added"],
    ["removedLines", "Lines removed"],
    ["deletedFiles", "T3 files deleted"],
  ]) {
    lines.push(`| ${label} | ${base[key]} | ${head[key]} | ${signed(delta[key])} |`);
  }
  lines.push("");
  if (result.baselineMoved) {
    const { from, to, t3Commits } = result.baselineMoved;
    lines.push(
      `T3 baseline moved from \`${short(from)}\` to \`${short(to)}\` (${t3Commits} T3 commits), so the change also reflects T3's own movement. Per-file lists are omitted.`,
    );
  } else {
    lines.push(`T3 baseline: \`${short(head.baseline)}\` (unchanged).`);
    lines.push(
      ...pathList("Newly diverged from T3", result.newlyDiverged),
      ...pathList("Newly deleted T3 files", result.newlyDeleted),
      ...pathList("Returned to identical with T3", result.returnedToIdentical),
    );
  }
  return `${lines.join("\n")}\n`;
}

async function main(argv) {
  let result;
  try {
    result = await measureForkFootprint(argv);
  } catch (error) {
    process.stderr.write(`${error.stderr?.trim() || error.message}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    parseArgs(argv).format === "json"
      ? `${JSON.stringify(result, null, 2)}\n`
      : formatMarkdown(result),
  );
}

if (import.meta.main) await main(process.argv.slice(2));
