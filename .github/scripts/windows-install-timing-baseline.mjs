// Which installer a Windows install timing measures (`source --out <file> [--run-id <id>
// --artifact <name> | --installer-url <url>] [--version <v>]`) and which earlier timing it
// compares with (`find --context <file> --committed <file> --dir <dir>`, which adds file= and
// committed= to $GITHUB_OUTPUT and falls back to the committed baseline on any lookup error).
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

export const RELEASE_WORKFLOW = ".github/workflows/release.yml";
export const TIMING_WORKFLOW = ".github/workflows/windows-install-timing.yml";
export const RELEASE_ARTIFACT = "desktop-win-x64";
export const TIMING_ARTIFACT = "windows-install-timing";
export const SCHEMA_VERSION = 2;
const MEDIANS = ["installMs", "firstLaunchMs", "secondLaunchMs"];

/** A release run's channel, from its branch: the release preflight fails any other pairing. */
export function releaseChannel(run) {
  if (run?.path !== RELEASE_WORKFLOW || run.event !== "workflow_dispatch") return null;
  if (run.head_branch === "release/stable") return { channel: "stable", rehearsal: false };
  if (run.head_branch === "main") return { channel: "beta", rehearsal: false };
  if (run.head_branch?.startsWith("release-rehearsal/"))
    return { channel: "stable", rehearsal: true };
  return null;
}

/** Beta compares with the previous Beta; Stable, rehearsals and any other installer with Stable. */
export function baselineChannel(context) {
  return context.channel === "beta" && !context.rehearsal ? "beta" : "stable";
}

export function describeSource({ run, artifact, installerUrl, version, runId, runUrl }) {
  const release = run && artifact === RELEASE_ARTIFACT ? releaseChannel(run) : null;
  return {
    kind: release ? "release" : "manual",
    version: version || null,
    channel: release?.channel ?? null,
    rehearsal: release?.rehearsal ?? false,
    sourceSha: run?.head_sha ?? null,
    installer: installerUrl || `artifact ${artifact} of run ${run?.id}`,
    installerUrl: installerUrl || null,
    installerRunId: run ? String(run.id) : null,
    installerArtifact: installerUrl ? null : artifact,
    installerRunCreatedAt: run?.created_at ?? null,
    runId,
    runUrl,
  };
}

/** Why a timing record cannot be the baseline for `context`, or null when it can. */
export function recordRejection(record, context) {
  const recorded = record?.context;
  if (record?.schemaVersion !== SCHEMA_VERSION || !recorded) return "an older record format";
  if (recorded.kind !== "release" || recorded.installerArtifact !== RELEASE_ARTIFACT)
    return "not a release installer";
  if (recorded.rehearsal) return "a rehearsal";
  const channel = baselineChannel(context);
  if (recorded.channel !== channel) return `${recorded.channel} channel, not ${channel}`;
  if (context.version && recorded.version === context.version) return "the same version";
  if ((record.measurement?.failures ?? ["unknown"]).length > 0) return "it has failed stages";
  const median = record.measurement?.median ?? {};
  if (!MEDIANS.every((key) => Number.isFinite(median[key]) && median[key] > 0))
    return "it lacks a median";
  if (!/^\d+$/u.test(recorded.installerRunId ?? "")) return "it names no installer run";
  return null;
}

/** Why the release run a record timed cannot stand behind it, or null when it can. */
export function releaseRunRejection(run, context) {
  const release = releaseChannel(run);
  const channel = baselineChannel(context);
  if (!release) return "its installer run is not a release run";
  if (release.rehearsal || release.channel !== channel)
    return `its release run built ${release.rehearsal ? "a rehearsal" : release.channel}, not ${channel}`;
  if (run.status !== "completed" || run.conclusion !== "success")
    return `its release run is ${run.status}${run.conclusion ? `/${run.conclusion}` : ""}`;
  if (context.installerRunCreatedAt && !(run.created_at < context.installerRunCreatedAt))
    return "its release run is not earlier than this installer's";
  return null;
}

/**
 * The newest timing record that passes every check, or null. `api(path, { paginate })` returns
 * parsed JSON (an array of pages when paginating); `download(runId)` returns the run's record
 * path or null. Throws on API errors and once `deadline` (performance.now) passes.
 */
export function findBaseline({ api, download, repository, context, deadline, log }) {
  const runs = new Map();
  const runOf = (id) => {
    if (performance.now() > deadline) throw new Error("the baseline lookup ran out of time");
    if (!runs.has(id)) runs.set(id, api(`repos/${repository}/actions/runs/${id}`));
    return runs.get(id);
  };
  const pages = api(`repos/${repository}/actions/artifacts?name=${TIMING_ARTIFACT}&per_page=100`, {
    paginate: true,
  });
  const artifacts = pages
    .flatMap((page) => page.artifacts ?? [])
    .filter((artifact) => artifact.name === TIMING_ARTIFACT && !artifact.expired)
    .filter((artifact) => String(artifact.workflow_run?.id) !== String(context.runId))
    .toSorted((a, b) => b.created_at.localeCompare(a.created_at));
  log(`${artifacts.length} earlier timing artifact(s) kept`);
  for (const artifact of artifacts) {
    const runId = String(artifact.workflow_run.id);
    const timingRun = runOf(runId);
    let reason =
      timingRun.path !== TIMING_WORKFLOW
        ? "not a timing run"
        : timingRun.status !== "completed"
          ? "its timing run is still running"
          : null;
    let file = null;
    let record = null;
    if (reason === null) {
      file = download(runId);
      record = file ? JSON.parse(NodeFS.readFileSync(file, "utf8")) : null;
      reason = record ? recordRejection(record, context) : "its record could not be read";
    }
    if (reason === null)
      reason = releaseRunRejection(runOf(record.context.installerRunId), context);
    if (reason === null) {
      log(`run ${runId}: ${record.context.version ?? "unknown version"}, accepted`);
      return file;
    }
    log(`run ${runId}: skipped, ${reason}`);
  }
  return null;
}

const LOOKUP_MS = 2 * 60_000;
const GH_CALL_MS = 60_000;

function gh(args) {
  try {
    return NodeChildProcess.execFileSync("gh", args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: GH_CALL_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail =
      String(error.stderr ?? "")
        .trim()
        .split("\n")
        .at(-1) || error.message;
    throw new Error(`gh ${args[0]} ${args.at(-1)}: ${detail}`, { cause: error });
  }
}

const api = (path, { paginate = false } = {}) =>
  JSON.parse(gh(["api", ...(paginate ? ["--paginate", "--slurp"] : []), path]));

if (import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const { positionals, values } = NodeUtil.parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string" },
      "run-id": { type: "string" },
      artifact: { type: "string" },
      "installer-url": { type: "string" },
      version: { type: "string" },
      context: { type: "string" },
      committed: { type: "string" },
      dir: { type: "string" },
    },
  });
  const {
    GITHUB_REPOSITORY: repository,
    GITHUB_RUN_ID: runId,
    GITHUB_SERVER_URL: server,
  } = process.env;
  const log = (message) => console.log(message);
  if (positionals[0] === "source") {
    const runIdInput = values["run-id"] ?? "";
    const installerUrl = values["installer-url"] ?? "";
    if ((runIdInput === "") === (installerUrl === ""))
      throw new Error("Give either a run ID and artifact or an installer URL");
    if (runIdInput !== "" && (!/^\d+$/u.test(runIdInput) || !values.artifact))
      throw new Error("The run ID must be numeric and come with an artifact name");
    if (installerUrl !== "" && new URL(installerUrl).protocol !== "https:")
      throw new Error("The installer URL must use HTTPS");
    let run = null;
    if (runIdInput !== "") {
      try {
        run = api(`repos/${repository}/actions/runs/${runIdInput}`);
      } catch (error) {
        // Timed all the same; only a verified release run's timing can become a baseline.
        console.log(
          `::warning title=Windows install timing source::Could not read run ${runIdInput} (${String(error.message).split("\n")[0]}); recording this timing as manual`,
        );
        run = { id: Number(runIdInput) };
      }
    }
    const context = describeSource({
      run,
      artifact: values.artifact,
      installerUrl,
      version: values.version,
      runId,
      runUrl: `${server}/${repository}/actions/runs/${runId}`,
    });
    NodeFS.writeFileSync(values.out, `${JSON.stringify(context, null, 2)}\n`);
    log(JSON.stringify(context, null, 2));
  } else if (positionals[0] === "find") {
    let file = null;
    try {
      const context = JSON.parse(NodeFS.readFileSync(values.context, "utf8"));
      log(`Looking for the newest earlier ${baselineChannel(context)} release timing`);
      file = findBaseline({
        api,
        download: (id) => {
          const dir = NodePath.join(values.dir, id);
          try {
            gh(["run", "download", id, "-R", repository, "-n", TIMING_ARTIFACT, "-D", dir]);
          } catch {
            return null;
          }
          const record = NodePath.join(dir, "windows-install-timing.json");
          return NodeFS.existsSync(record) ? record : null;
        },
        repository,
        context,
        deadline: performance.now() + LOOKUP_MS,
        log,
      });
    } catch (error) {
      console.log(
        `::warning title=Windows install timing baseline::The lookup failed (${String(error.message).split("\n")[0]}); comparing with the committed baseline`,
      );
    }
    log(`Baseline: ${file ?? `${values.committed} (committed)`}`);
    const output = `file=${file ?? values.committed}\ncommitted=${file === null}\n`;
    if (process.env.GITHUB_OUTPUT) NodeFS.appendFileSync(process.env.GITHUB_OUTPUT, output);
    else process.stdout.write(output);
  } else {
    throw new Error("usage: source | find");
  }
}
