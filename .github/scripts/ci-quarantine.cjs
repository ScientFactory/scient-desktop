// SCIENT-FORK:START — flaky-test quarantine for the required Check (docs/operations/ci-flakes.md).
// A failed job passes only when unexpired rows explain every failure in it: job, step, test id
// and signature. The job stays red; Check lists it. Anything unread or unexplained blocks.
const fs = require("node:fs");
const path = require("node:path");

const REGISTER = ".github/scripts/ci-quarantine.json";
const QUARANTINE_DAYS = 7;
const DAY = 24 * 60 * 60 * 1000;
// Never quarantinable, by job or step name (AGENTS.md: build, typecheck, format/lint,
// documentation and provenance failures always block).
const NEVER = /\b(build|typecheck|type check|lint|format|provenance|documentation)\b/i;
// These fail only because another failed job did. Each is accepted only when the job it waits
// for failed and was itself fully quarantined, only in this one step, only with this output, and
// only when every one of its earlier steps passed.
const CONSEQUENCES = [
  {
    job: "Qualification receipt",
    step: "Record complete qualification",
    after: null, // every other failed job of the run
    // The strict receipt check refused only failed needs (ci-queue-reuse.cjs writeReceipt).
    evidence: /^Error: CI qualification is missing: ([a-z_]+: failure)(, [a-z_]+: failure)*$/m,
  },
  {
    job: "windows_packaging / Windows packaging / Packaged WSL Linux runtime",
    // After it qualified the WSL payload, it waits for the installer job to finish.
    step: "Require the installer job to succeed",
    after: "windows_packaging / Windows packaging / Installer and native runtime",
    evidence:
      /^Windows packaging \/ Installer and native runtime ended without success \(failure\)\.$/m,
  },
];
// Steps that may be skipped after a quarantined failure: GitHub's post steps, cache saves and
// artifact uploads. Any other skipped step after it is a check that never ran, so it blocks.
const AFTER_FAILURE = /^(Post |Save |Upload |Run actions\/(upload-artifact|cache)@)/;
// Steps whose `if` starts with `!cancelled()` or `always()` in ci.yml: they run after an earlier
// failure, so when one is skipped its own condition (such as its matrix part) was false.
const RUN_DESPITE_FAILURE = [
  "Verify SVG and PNG exports in Chromium",
  "Explain Google's sign-in refusal in Electron's browser",
  "Publish transfer budget report",
];
const GATE = "Check";
// ci-check.cjs ADVISORY jobs: evidence and upkeep beside the gate, which never block.
const ADVISORY_JOBS = ["Overleaf macOS", "Shard weights", "Main dependency store"];

const ROW_KEYS = ["id", "job", "step", "test", "signature", "owner", "quarantined", "expires"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function validateRegister(register) {
  const errors = [];
  if (!register || register.schemaVersion !== 1 || !Array.isArray(register.rows))
    return ["Register must be { schemaVersion: 1, rows: [...] }"];
  const ids = new Set();
  for (const row of register.rows) {
    const name = row?.id ?? "(no id)";
    const keys = Object.keys(row ?? {});
    for (const key of ROW_KEYS) if (!keys.includes(key)) errors.push(`${name}: missing ${key}`);
    for (const key of keys) if (!ROW_KEYS.includes(key)) errors.push(`${name}: unknown ${key}`);
    if (typeof row?.id !== "string" || !/^[a-z0-9-]+$/.test(row.id))
      errors.push(`${name}: id must be kebab-case`);
    if (ids.has(row?.id)) errors.push(`${name}: duplicate id`);
    ids.add(row?.id);
    for (const key of ["job", "step", "signature", "owner"])
      if (typeof row?.[key] !== "string" || row[key].trim() === "")
        errors.push(`${name}: ${key} must be a non-empty string`);
    if (row?.test !== null && (typeof row?.test !== "string" || row.test.trim() === ""))
      errors.push(`${name}: test must be a test id or null for a script step`);
    if (typeof row?.signature === "string" && row.signature.trim().length < 12)
      errors.push(`${name}: signature is too short to be exact`);
    for (const key of ["quarantined", "expires"])
      if (!DATE.test(row?.[key] ?? "")) errors.push(`${name}: ${key} must be YYYY-MM-DD`);
    if (DATE.test(row?.quarantined ?? "") && DATE.test(row?.expires ?? "")) {
      const days = (Date.parse(row.expires) - Date.parse(row.quarantined)) / DAY;
      if (days < 0 || days > QUARANTINE_DAYS)
        errors.push(`${name}: expires must be within ${QUARANTINE_DAYS} days of quarantined`);
    }
    if (NEVER.test(row?.job ?? "") || NEVER.test(row?.step ?? ""))
      errors.push(`${name}: build, typecheck, lint, documentation and provenance never quarantine`);
    if (row?.job === GATE || CONSEQUENCES.some((c) => c.job === row?.job))
      errors.push(`${name}: ${row.job} is a gate, not a test`);
  }
  return errors;
}

/** A row is open through its expiry day (UTC); afterwards it blocks again. */
const isOpen = (row, now) => now.toISOString().slice(0, 10) <= row.expires;

/** `*` in a row's job matches one matrix value, such as a shard number. */
function jobMatches(pattern, name) {
  const escaped = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${escaped.join("[^ /]+")}$`).test(name);
}

// Terminal colour codes, which GitHub keeps in raw logs.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
// The `Test` job pipes output through Python's backslashreplace, so `⎯` arrives as `\u23af`.
const unescape = (line) =>
  line.replace(/\\(?:x([0-9a-f]{2})|u([0-9a-f]{4})|U([0-9a-f]{8}))/g, (_, x, u, U) =>
    String.fromCodePoint(Number.parseInt(x ?? u ?? U, 16)),
  );
const strip = (line) =>
  unescape(line)
    .replace(ANSI, "")
    .replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/, "")
    .replace(/\s+$/, "");
const stamp = (line) => {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/.exec(line);
  return match ? Date.parse(match[1]) : null;
};
// `⎯⎯⎯[1/3]⎯` ends one failed test's report; a bare rule ends a report section.
const COUNTER = /^⎯+\[\d+\/\d+\]⎯*$/;
const RULE = /^⎯{10,}$/;
const HEADING =
  /^⎯+ (Failed Tests|Failed Suites|Unhandled Errors?|Unhandled Rejections?) ?(\d+)? ?⎯+$/;
const FAIL = /^ FAIL\s+(.*)$/;
// A test id is the FAIL line as vitest prints it, spaces collapsed: the project label when there
// is one (`browser (chromium)`, `unit`), the file relative to its package, then the test's names.
const TEST_ID = /^(?:\S.*? )?\S+\.[cm]?[jt]sx?(?: > .+)?$/;
const testId = (text) => {
  const id = text.replace(/\s+/g, " ").trim();
  return TEST_ID.test(id) ? id : null;
};

/**
 * Reads vitest's default reporter output from a job log: every failed test, failed suite and
 * unhandled error, with the lines that belong to it, and whether the summary lines agree.
 */
function parseVitest(log) {
  const lines = log.split(/\r?\n/).map(strip);
  const entries = [];
  const totals = { tests: 0, suites: 0, errors: 0 };
  const reported = { tests: 0, suites: 0, errors: 0 };
  let section = null;
  let current = null;
  // Vitest lists tests that failed the same way as consecutive FAIL lines above one error.
  let group = [];
  const close = () => {
    if (current) {
      for (const member of group) member.lines = [...member.lines, ...current.lines.slice(1)];
      entries.push(...group, current);
    }
    current = null;
    group = [];
  };
  for (const line of lines) {
    const heading = HEADING.exec(line);
    if (heading) {
      close();
      const kind = heading[1];
      section = kind.startsWith("Failed Tests")
        ? "test"
        : kind.startsWith("Failed Suites")
          ? "suite"
          : "unhandled";
      // "Unhandled Errors" is a section header; each "Unhandled Error"/"Rejection" opens an entry.
      if (section === "unhandled" && !kind.endsWith("Errors")) {
        current = { kind: "unhandled", id: null, lines: [line], rules: 0 };
      } else if (heading[2] && section !== "unhandled") {
        reported[section === "test" ? "tests" : "suites"] += Number(heading[2]);
      }
      continue;
    }
    const caught = /^Vitest caught (\d+) unhandled errors?/.exec(line);
    if (caught) {
      reported.errors += Number(caught[1]);
      continue;
    }
    const fail = FAIL.exec(line);
    if (fail && (section === "test" || section === "suite")) {
      if (current && current.kind === section && current.lines.length === 1) {
        group.push(current);
        current = null;
      } else close();
      current = { kind: section, id: testId(fail[1]), lines: [line] };
      continue;
    }
    // Summary lines only count: on Windows they interleave with the failure report.
    const summary = /^\s*(Test Files|Tests|Errors)\s+(.*)$/.exec(line);
    if (summary) {
      const failed = /(\d+) failed/.exec(summary[2]);
      if (summary[1] === "Tests" && failed) totals.tests += Number(failed[1]);
      if (summary[1] === "Errors")
        totals.errors += Number(/(\d+) errors?/.exec(summary[2])?.[1] ?? 0);
      continue;
    }
    if (!current) continue;
    if (current.kind === "unhandled") {
      // An unhandled error ends at its second rule, after its serialized fields.
      current.lines.push(line);
      if (RULE.test(line) && ++current.rules === 2) close();
    } else if (COUNTER.test(line) || RULE.test(line)) close();
    else current.lines.push(line);
  }
  close();
  for (const entry of entries) {
    entry.block = entry.lines.join("\n");
    delete entry.lines;
    delete entry.rules;
  }
  const count = (kind) => entries.filter((entry) => entry.kind === kind).length;
  const found = { tests: count("test"), suites: count("suite"), errors: count("unhandled") };
  const problems = [];
  if (found.tests !== reported.tests || found.tests !== totals.tests)
    problems.push(
      `failed tests: ${found.tests} listed, ${reported.tests} in headings, ${totals.tests} in summaries`,
    );
  if (found.suites !== reported.suites)
    problems.push(`failed suites: ${found.suites} listed, ${reported.suites} in headings`);
  if (found.errors !== Math.max(reported.errors, totals.errors))
    problems.push(
      `unhandled errors: ${found.errors} listed, ${reported.errors} caught, ${totals.errors} in summaries`,
    );
  // An unhandled error has no test of its own; the last test vitest names may be innocent.
  if (found.errors) problems.push(`${found.errors} unhandled error(s), which never quarantine`);
  for (const entry of entries)
    if (entry.kind !== "unhandled" && !entry.id) problems.push(`a ${entry.kind} has no test id`);
  return { entries, problems };
}

/** The log lines written while one step ran, by the timestamps GitHub prefixes to each line. */
function stepLog(log, step) {
  const start = Date.parse(step.started_at);
  // Step times are whole seconds; keep the last second's lines.
  const end = Date.parse(step.completed_at) + 1000;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const kept = [];
  let inside = false;
  for (const line of log.split(/\r?\n/)) {
    const time = stamp(line);
    if (time !== null) inside = time >= start && time < end;
    if (inside) kept.push(line);
  }
  return kept.join("\n");
}

/** The lines a step printed before its exit, which say why it failed. */
const ENDING_LINES = 60;
function ending(text) {
  const lines = text.split(/\r?\n/).map(strip);
  const exit = lines.findLastIndex((line) =>
    line.startsWith("##[error]Process completed with exit code"),
  );
  return exit < 0 ? null : lines.slice(Math.max(0, exit - ENDING_LINES), exit).join("\n");
}

/** A failed job's steps must have run up to the failure, and only housekeeping skipped after. */
function unrunSteps(job) {
  const steps = job.steps ?? [];
  const first = steps.findIndex((step) => step.conclusion === "failure");
  return steps.filter(
    (step, index) =>
      (index < first && step.conclusion !== "success" && step.conclusion !== "skipped") ||
      (index > first &&
        step.conclusion === "skipped" &&
        !AFTER_FAILURE.test(step.name) &&
        !RUN_DESPITE_FAILURE.includes(step.name)) ||
      (step.conclusion !== "success" &&
        step.conclusion !== "skipped" &&
        step.conclusion !== "failure"),
  );
}

/** Explains one failed Actions API job with open rows: the rows it matched, or why it blocks. */
function explainJob(job, log, rows) {
  const candidates = rows.filter((row) => jobMatches(row.job, job.name));
  const failedSteps = (job.steps ?? []).filter((step) => step.conclusion === "failure");
  if (failedSteps.length === 0) return { blocked: `${job.name}: failed without a failed step` };
  if (typeof log !== "string" || log.length === 0) return { blocked: `${job.name}: no log` };
  const unrun = unrunSteps(job);
  if (unrun.length)
    return {
      blocked: `${job.name}: ${unrun.map((s) => `${s.name} (${s.conclusion})`).join(", ")} did not run`,
    };
  const matched = [];
  for (const step of failedSteps) {
    if (NEVER.test(step.name)) return { blocked: `${job.name} › ${step.name}: never quarantined` };
    const text = stepLog(log, step);
    if (text === null) return { blocked: `${job.name} › ${step.name}: no step times` };
    const stepRows = candidates.filter((row) => row.step === step.name);
    if (stepRows.length === 0)
      return { blocked: `${job.name} › ${step.name}: no open row for this step` };
    const { entries, problems } = parseVitest(text);
    if (problems.length) return { blocked: `${job.name} › ${step.name}: ${problems.join("; ")}` };
    if (entries.length === 0) {
      // A script step: the exact signature must be in what it printed just before it exited.
      const end = ending(text);
      const row = stepRows.find((r) => r.test === null && end?.includes(r.signature));
      if (!row)
        return { blocked: `${job.name} › ${step.name}: no row's signature ends its output` };
      matched.push({ row, job: job.name, step: step.name, test: null });
      continue;
    }
    for (const entry of entries) {
      const row = stepRows.find((r) => r.test === entry.id && entry.block.includes(r.signature));
      if (!row)
        return { blocked: `${job.name} › ${step.name}: ${entry.kind} ${entry.id} matches no row` };
      matched.push({ row, job: job.name, step: step.name, test: entry.id });
    }
  }
  return { matched };
}

/**
 * Decides whether a run's failed jobs are all quarantined. `jobs` are the latest attempt's jobs;
 * `logs` maps job id to its log text.
 */
function evaluate({ jobs, logs, register, now = new Date() }) {
  const registerErrors = validateRegister(register);
  if (registerErrors.length)
    return { ok: false, blocked: registerErrors.map((e) => `register: ${e}`) };
  const open = register.rows.filter((row) => isOpen(row, now));
  const expired = register.rows.filter((row) => !isOpen(row, now));
  const failed = jobs.filter(
    (job) =>
      job.name !== GATE &&
      !ADVISORY_JOBS.includes(job.name) &&
      job.conclusion !== "success" &&
      job.conclusion !== "skipped",
  );
  const blocked = [];
  const matched = [];
  const consequences = [];
  for (const job of failed) {
    if (job.conclusion !== "failure") {
      blocked.push(`${job.name}: ${job.conclusion ?? job.status}`);
      continue;
    }
    const consequence = CONSEQUENCES.find((c) => c.job === job.name);
    if (consequence) {
      consequences.push({ job, consequence });
      continue;
    }
    const result = explainJob(job, logs[job.id], open);
    if (result.blocked) {
      const lapsed = expired.find((row) => jobMatches(row.job, job.name));
      blocked.push(
        lapsed ? `${result.blocked} (row ${lapsed.id} expired ${lapsed.expires})` : result.blocked,
      );
    } else matched.push(...result.matched);
  }
  const explained = new Set(matched.map((m) => m.job));
  for (const { job, consequence } of consequences) {
    const steps = (job.steps ?? []).filter((step) => step.conclusion === "failure");
    const waited = consequence.after ? [consequence.after] : [...explained];
    const text = steps.length === 1 ? stepLog(logs[job.id] ?? "", steps[0]) : null;
    const all = job.steps ?? [];
    const earlier = all.slice(
      0,
      all.findIndex((step) => step.conclusion === "failure"),
    );
    if (
      steps.length !== 1 ||
      steps[0].name !== consequence.step ||
      // Its own checks all ran and passed: only the wait for the other job failed.
      earlier.some((step) => step.conclusion !== "success") ||
      unrunSteps(job).length ||
      !consequence.evidence.test((text ?? "").split(/\r?\n/).map(strip).join("\n")) ||
      waited.length === 0 ||
      !waited.every((name) => explained.has(name))
    )
      blocked.push(`${job.name}: not only a consequence of quarantined failures`);
  }
  if (failed.length === 0) blocked.push("No failed job explains the gate's failure");
  return { ok: blocked.length === 0, blocked, matched };
}

/** Markdown for the Check summary: every quarantined failure with its row. */
function summary({ ok, blocked, matched }, { runUrl } = {}) {
  const lines = [];
  if (matched.length) {
    lines.push("### Quarantined failures", "");
    lines.push("These failed and still need their cause fixed; each matches an open row in");
    lines.push("[ci-flakes.md](../blob/main/docs/operations/ci-flakes.md).", "");
    lines.push("| Row | Job | Test or step | Owner | Expires |", "| --- | --- | --- | --- | --- |");
    for (const m of matched)
      lines.push(
        `| \`${m.row.id}\` | ${m.job} | ${m.test ?? m.step} | ${m.row.owner} | ${m.row.expires} |`,
      );
    lines.push("");
  }
  if (!ok) {
    lines.push("### Blocking failures", "");
    for (const reason of blocked) lines.push(`- ${reason}`);
    lines.push("");
  }
  if (runUrl) lines.push(`Run: ${runUrl}`);
  return lines.join("\n");
}

function readRegister(root = process.cwd()) {
  return JSON.parse(fs.readFileSync(path.join(root, REGISTER), "utf8"));
}

/** github-script entry: reads the register as the base branch has it, never the tested head's. */
async function run({ github, context, core, registerText }) {
  const register = JSON.parse(registerText);
  const { owner, repo } = context.repo;
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    owner,
    repo,
    run_id: context.runId,
    filter: "latest",
    per_page: 100,
  });
  const logs = {};
  for (const job of jobs) {
    if (job.name === GATE || ADVISORY_JOBS.includes(job.name) || job.conclusion !== "failure")
      continue;
    try {
      const response = await github.rest.actions.downloadJobLogsForWorkflowRun({
        owner,
        repo,
        job_id: job.id,
      });
      logs[job.id] =
        typeof response.data === "string"
          ? response.data
          : Buffer.from(response.data).toString("utf8");
    } catch (error) {
      core.warning(`Could not read the log of ${job.name}: ${error.message}`);
    }
  }
  const result = evaluate({ jobs, logs, register });
  const runUrl = `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`;
  await core.summary.addRaw(summary(result, { runUrl })).write();
  for (const m of result.matched)
    core.warning(
      `Quarantined (${m.row.id}, expires ${m.row.expires}): ${m.job} › ${m.test ?? m.step}`,
    );
  return result.ok;
}

module.exports = {
  ADVISORY_JOBS,
  CONSEQUENCES,
  RUN_DESPITE_FAILURE,
  QUARANTINE_DAYS,
  REGISTER,
  evaluate,
  explainJob,
  isOpen,
  jobMatches,
  parseVitest,
  readRegister,
  run,
  stepLog,
  summary,
  validateRegister,
};
// SCIENT-FORK:END
