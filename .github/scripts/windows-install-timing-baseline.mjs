// `wait --run-id --attempt --artifact`: a release attempt's packaged installer ID, or none.
// `source --out [--run-id --artifact [--artifact-id] | --installer-url] [--version]
// [--installer-name]`: which installer a timing measures. `find --context --committed --dir`: its
// baseline. `installer --baseline`: that baseline's installer. All but `source` set step outputs.
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
export const PACKAGE_JOB = "Package Windows x64";

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

export function describeSource({
  run,
  artifact,
  artifactId,
  installerUrl,
  version,
  runId,
  runUrl,
}) {
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
    installerArtifactId: artifactId || null,
    installerRunCreatedAt: run?.created_at ?? null,
    runId,
    runUrl,
  };
}

/** Why `artifact` (the API's record) is not `name` from run `runId`, or null when it is. */
export function artifactMismatch(artifact, runId, name) {
  if (String(artifact?.workflow_run?.id) !== String(runId))
    return `it belongs to run ${artifact?.workflow_run?.id}, not ${runId}`;
  if (artifact.name !== name) return `it is ${artifact.name}, not ${name}`;
  return null;
}

/** The version in an installer's file name (`Scient-<version>-x64.exe`), or null. */
export function installerVersion(name) {
  return /^Scient-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)-x64\.exe$/u.exec(name ?? "")?.[1] ?? null;
}

/**
 * Polls attempt `attempt` of release run `runId` until its `job` has finished. Returns
 * `{ artifactId }` once the job succeeded and uploaded `artifact` in this attempt, or `{ skip }`
 * with the reason when the job ended otherwise, the attempt ended without it, or `deadline` (a
 * `now()` value) passed. Throws once `maxFailures` polls in a row fail.
 */
export function waitForInstaller({
  api,
  repository,
  runId,
  attempt,
  job = PACKAGE_JOB,
  artifact = RELEASE_ARTIFACT,
  now,
  sleep,
  deadline,
  log,
  pollMs = 30_000,
  maxFailures = 5,
}) {
  const attemptPath = `repos/${repository}/actions/runs/${runId}/attempts/${attempt}`;
  let failures = 0;
  for (;;) {
    try {
      // The attempt's state first: once it reads completed, the job list that follows is final.
      const run = api(attemptPath);
      const found = api(`${attemptPath}/jobs?per_page=100`, { paginate: true })
        .flatMap((page) => page.jobs ?? [])
        .find((entry) => entry.name === job);
      if (found?.status === "completed") {
        if (found.conclusion !== "success") return { skip: `${job} ended ${found.conclusion}` };
        const upload = api(
          `repos/${repository}/actions/runs/${runId}/artifacts?name=${artifact}&per_page=100`,
        )
          .artifacts?.filter(
            (entry) =>
              entry.name === artifact && !entry.expired && entry.created_at >= found.started_at,
          )
          .toSorted((a, b) => b.created_at.localeCompare(a.created_at))[0];
        if (!upload) throw new Error(`${job} succeeded but no ${artifact} upload is listed yet`);
        return { artifactId: String(upload.id) };
      }
      if (run.status === "completed")
        return { skip: `the release ended (${run.conclusion}) before ${job} finished` };
      failures = 0;
      log(`${job}: ${found?.status ?? "not started"}`);
    } catch (error) {
      failures += 1;
      log(`Poll failed (${failures} of ${maxFailures} in a row): ${String(error.message)}`);
      if (failures >= maxFailures) throw error;
    }
    if (now() + pollMs > deadline) return { skip: `${job} had not finished in time` };
    sleep(pollMs);
  }
}

/** Why a timing record cannot be the baseline for `context`, or null when it can. */
export function recordRejection(record, context) {
  const recorded = record?.context;
  if (record?.schemaVersion !== SCHEMA_VERSION || !recorded) return "an older record format";
  if (record.measurement?.complete !== true)
    return "its measurement did not record finishing every sample";
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
 * Where `record`'s own installer comes from, by the exact upload it timed when the record names
 * one, and the SHA-256 it must have; a string says why it cannot be fetched.
 */
export function baselineInstaller(record) {
  const recorded = record?.context ?? {};
  const sha256 = record?.measurement?.installer?.sha256 ?? "";
  if (!/^[0-9a-f]{64}$/u.test(sha256)) return "the baseline records no installer SHA-256";
  if (recorded.installerUrl?.startsWith("https://")) return { url: recorded.installerUrl, sha256 };
  if (/^\d+$/u.test(recorded.installerRunId ?? "") && recorded.installerArtifact) {
    const artifactId = /^\d+$/u.test(recorded.installerArtifactId ?? "")
      ? recorded.installerArtifactId
      : "";
    return {
      runId: recorded.installerRunId,
      artifact: recorded.installerArtifact,
      artifactId,
      sha256,
    };
  }
  return "the baseline names no installer to download";
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
          : timingRun.conclusion !== "success"
            ? `its timing run concluded ${timingRun.conclusion}`
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
const WAIT_MS = 90 * 60_000;
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
      "artifact-id": { type: "string" },
      "installer-url": { type: "string" },
      version: { type: "string" },
      "installer-name": { type: "string" },
      attempt: { type: "string" },
      context: { type: "string" },
      committed: { type: "string" },
      dir: { type: "string" },
      baseline: { type: "string" },
    },
  });
  const {
    GITHUB_REPOSITORY: repository,
    GITHUB_RUN_ID: runId,
    GITHUB_SERVER_URL: server,
  } = process.env;
  const log = (message) => console.log(message);
  if (positionals[0] === "wait") {
    const releaseRunId = values["run-id"] ?? "";
    const attempt = values.attempt ?? "";
    const artifact = values.artifact ?? RELEASE_ARTIFACT;
    if (!/^\d+$/u.test(releaseRunId) || !/^\d+$/u.test(attempt))
      throw new Error("The release run ID and attempt must be numeric");
    const pause = new Int32Array(new SharedArrayBuffer(4));
    const result = waitForInstaller({
      api,
      repository,
      runId: releaseRunId,
      attempt,
      artifact,
      now: () => performance.now(),
      sleep: (ms) => Atomics.wait(pause, 0, 0, ms),
      deadline: performance.now() + WAIT_MS,
      log,
    });
    const release = `release run [${releaseRunId}](${server}/${repository}/actions/runs/${releaseRunId}/attempts/${attempt}) (attempt ${attempt})`;
    if (result.skip) {
      log(`::notice title=Windows install timing::Not timed: ${result.skip}`);
    } else {
      log(`${artifact} of run ${releaseRunId}: artifact ${result.artifactId}`);
    }
    if (process.env.GITHUB_STEP_SUMMARY)
      NodeFS.appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        result.skip
          ? `Not timed: ${result.skip}, in ${release}. No timing record is kept.\n`
          : `Timing \`${artifact}\` (artifact ${result.artifactId}) of ${release}.\n`,
      );
    const output = `artifact_id=${result.artifactId ?? ""}\n`;
    if (process.env.GITHUB_OUTPUT) NodeFS.appendFileSync(process.env.GITHUB_OUTPUT, output);
    else process.stdout.write(output);
  } else if (positionals[0] === "source") {
    const runIdInput = values["run-id"] ?? "";
    const artifactId = values["artifact-id"] ?? "";
    const installerUrl = values["installer-url"] ?? "";
    if ((runIdInput === "") === (installerUrl === ""))
      throw new Error("Give either a run ID and artifact or an installer URL");
    if (runIdInput !== "" && (!/^\d+$/u.test(runIdInput) || !values.artifact))
      throw new Error("The run ID must be numeric and come with an artifact name");
    if (artifactId !== "" && (runIdInput === "" || !/^\d+$/u.test(artifactId)))
      throw new Error("An artifact ID must be numeric and come with its run ID");
    if (installerUrl !== "" && new URL(installerUrl).protocol !== "https:")
      throw new Error("The installer URL must use HTTPS");
    // Timed all the same when unreadable; only a verified release run's timing can become a baseline.
    const unverified = (what, error) => {
      console.log(
        `::warning title=Windows install timing source::Could not read ${what} (${String(error.message).split("\n")[0]}); recording this timing as manual`,
      );
      return { id: Number(runIdInput) };
    };
    let run = null;
    if (runIdInput !== "") {
      try {
        run = api(`repos/${repository}/actions/runs/${runIdInput}`);
      } catch (error) {
        run = unverified(`run ${runIdInput}`, error);
      }
    }
    if (artifactId !== "") {
      let artifact = null;
      try {
        artifact = api(`repos/${repository}/actions/artifacts/${artifactId}`);
      } catch (error) {
        run = unverified(`artifact ${artifactId}`, error);
      }
      const mismatch = artifact && artifactMismatch(artifact, runIdInput, values.artifact);
      if (mismatch) throw new Error(`Artifact ${artifactId} is not the one to time: ${mismatch}`);
    }
    const context = describeSource({
      run,
      artifact: values.artifact,
      artifactId,
      installerUrl,
      version: values.version || installerVersion(values["installer-name"]) || "",
      runId,
      runUrl: `${server}/${repository}/actions/runs/${runId}`,
    });
    NodeFS.writeFileSync(values.out, `${JSON.stringify(context, null, 2)}\n`);
    log(JSON.stringify(context, null, 2));
  } else if (positionals[0] === "installer") {
    const source = baselineInstaller(JSON.parse(NodeFS.readFileSync(values.baseline, "utf8")));
    if (typeof source === "string") throw new Error(`Cannot re-check: ${source}`);
    const output = `url=${source.url ?? ""}\nrun_id=${source.runId ?? ""}\nartifact=${source.artifact ?? ""}\nartifact_id=${source.artifactId ?? ""}\nsha256=${source.sha256}\n`;
    log(output.trim());
    if (process.env.GITHUB_OUTPUT) NodeFS.appendFileSync(process.env.GITHUB_OUTPUT, output);
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
    throw new Error("usage: wait | source | find | installer");
  }
}
