const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  ADVISORY_JOBS,
  AFTER_FAILURE,
  CONSEQUENCES,
  WITNESSES,
  RUN_DESPITE_FAILURE,
  evaluate,
  isOpen,
  jobMatches,
  parseVitest,
  readRegister,
  stepLog,
  summary,
  validateRegister,
} = require("./ci-quarantine.cjs");

const ROOT = path.join(__dirname, "..", "..");
const T0 = "2026-11-17T00:20:00Z";
const T1 = "2026-11-17T00:25:00Z";
const at = (offsetSeconds) => new Date(Date.parse(T0) + offsetSeconds * 1000).toISOString();
// GitHub prefixes every log line with its time.
const log = (...lines) => lines.map((line, i) => `${at(10 + i * 0.01)} ${line}`).join("\n");
const NOW = new Date("2026-11-18T12:00:00Z");

const ROWS = {
  sources: {
    id: "sources-list-library-size",
    job: "Test Web *",
    step: "Test",
    test: "browser (chromium) src/scient/sources/SourcesList.browser.test.tsx > Sources list at Library size > keeps the project backend in the shared scroll area with every row mounted",
    signature: "Error: Test timed out in 30000ms.",
    owner: "Sources",
    quarantined: "2026-11-17",
    expires: "2026-11-24",
  },
  voice: {
    id: "windows-voice-transcription-timeout",
    job: "windows_packaging / Windows packaging / Installer and native runtime",
    step: "Transcribe with the installed voice runtime",
    test: null,
    signature: "Offline voice transcription timed out.",
    owner: "Voice runtime",
    quarantined: "2026-11-17",
    expires: "2026-11-24",
  },
};
const register = (...rows) => ({ schemaVersion: 1, rows });
const step = (name, conclusion = "success", start = T0, end = T1) => ({
  name,
  conclusion,
  started_at: start,
  completed_at: end,
});
const job = (id, name, steps, conclusion = "failure") => ({ id, name, conclusion, steps });
// The voice row's waiver also needs a passing WSL payload exercise (WITNESSES); fixtures give it
// one so that each case tests only its own rule.
const wslWitness = () => job(8, WITNESSES[0].witness, [step(WITNESSES[0].step)], "success");

// Web 1 of queue run 43985084936, trimmed: one failed browser test.
const SOURCES_LOG = log(
  " ✓  unit  src/components/pullRequest/pullRequestDetail.logic.test.ts (95 tests) 146ms",
  "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯",
  "",
  " FAIL   browser (chromium)  src/scient/sources/SourcesList.browser.test.tsx > Sources list at Library size > keeps the project backend in the shared scroll area with every row mounted",
  "Error: Test timed out in 30000ms.",
  'If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".',
  "⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯",
  "",
  " Test Files  1 failed | 266 passed (267)",
  "      Tests  1 failed | 2144 passed | 1 skipped (2146)",
  "   Start at  00:10:31",
  "##[error]Process completed with exit code 1.",
);
const webJob = (id = 1, name = "Test Web 1") =>
  job(id, name, [step("Checkout"), step("Test", "failure"), step("Upload test result")]);

test("the checked-in register is valid and every row is documented in ci-flakes.md", () => {
  const checked = readRegister(ROOT);
  assert.deepEqual(validateRegister(checked), []);
  const doc = fs.readFileSync(path.join(ROOT, "docs/operations/ci-flakes.md"), "utf8");
  for (const row of checked.rows) {
    assert.ok(doc.includes(`\`${row.id}\``), `${row.id} is missing from ci-flakes.md`);
    assert.ok(doc.includes(row.expires), `${row.id}'s expiry is missing from ci-flakes.md`);
  }
});

test("rows need an owner, an exact signature and an expiry within seven days", () => {
  assert.deepEqual(validateRegister(register(ROWS.sources, ROWS.voice)), []);
  const bad = (change) => validateRegister(register({ ...ROWS.sources, ...change }));
  assert.ok(bad({ owner: "" }).length);
  assert.ok(bad({ signature: "timed out" }).length);
  assert.ok(bad({ expires: "2026-11-25" }).length);
  assert.ok(bad({ expires: "2026-11-16" }).length);
  assert.ok(bad({ test: "" }).length);
  assert.ok(bad({ extra: true }).length);
  assert.ok(validateRegister(register(ROWS.sources, ROWS.sources)).length);
});

test("build, typecheck, lint, documentation, provenance and gate jobs are never quarantinable", () => {
  for (const change of [
    { job: "Build" },
    { job: "Lint" },
    { step: "Typecheck" },
    { step: "Format" },
    { job: "Scient upstream provenance" },
    { job: "Check" },
    { job: "Qualification receipt" },
  ])
    assert.ok(
      validateRegister(register({ ...ROWS.sources, ...change })).length,
      JSON.stringify(change),
    );
});

test("a row is open through its expiry day and blocks after it", () => {
  assert.equal(isOpen(ROWS.sources, new Date("2026-11-24T23:59:59Z")), true);
  assert.equal(isOpen(ROWS.sources, new Date("2026-11-25T00:00:00Z")), false);
});

test("job patterns match one matrix value only", () => {
  assert.ok(jobMatches("Test Web *", "Test Web 12"));
  assert.ok(!jobMatches("Test Web *", "Test Web Performance 1"));
  assert.ok(!jobMatches("Test Web *", "Test Server 1"));
  assert.ok(jobMatches("Test Server 5", "Test Server 5"));
  assert.ok(!jobMatches("Test Server 5", "Test Server 51"));
});

test("vitest output yields each failed test id with its own lines", () => {
  const { entries, problems } = parseVitest(SOURCES_LOG);
  assert.deepEqual(problems, []);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "test");
  assert.equal(entries[0].id, ROWS.sources.test);
  assert.match(entries[0].block, /Test timed out in 30000ms/);
});

test("server shard output without a project label yields the same id form", () => {
  const { entries, problems } = parseVitest(
    log(
      "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯",
      " FAIL  src/orchestration-v2/Adapters/ClaudeProcessGroup.scient.test.ts > stops the CLI's detached descendants when the server goes away",
      "AssertionError: the CLI stopped too: expected true to be false",
      "⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯",
      " Test Files  1 failed | 112 passed (113)",
      "      Tests  1 failed | 1403 passed | 65 skipped (1469)",
    ),
  );
  assert.deepEqual(problems, []);
  assert.equal(
    entries[0].id,
    "src/orchestration-v2/Adapters/ClaudeProcessGroup.scient.test.ts > stops the CLI's detached descendants when the server goes away",
  );
});

test("a run whose listed failures disagree with its summary is unreadable", () => {
  const { problems } = parseVitest(
    log(
      "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯",
      " FAIL  src/a.test.ts > one",
      "Error: Test timed out in 30000ms.",
      " Test Files  2 failed | 1 passed (3)",
      "      Tests  2 failed | 1 passed (3)",
    ),
  );
  assert.ok(problems.length);
});

test("an unhandled error without a summary, as when the browser connection drops, is unreadable", () => {
  // Web 5 of queue run 43986372349: the shard ended inside the unhandled rejection.
  const { entries, problems } = parseVitest(
    log(
      "⎯⎯⎯⎯ Unhandled Rejection ⎯⎯⎯⎯⎯",
      "Error: [vitest] There was an error when mocking a module.",
      "Caused by: Error: [vitest] Browser connection was closed while running tests. Was the page closed unexpectedly?",
      "⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯",
      "Serialized Error: { code: 'VITEST_BROWSER_CONNECTION_CLOSED' }",
      "##[error]Process completed with exit code 1.",
    ),
  );
  assert.equal(entries.length, 1);
  assert.ok(problems.length);
});

test("a fully quarantined failure passes the gate and is reported", () => {
  const result = evaluate({
    jobs: [webJob(), job(2, "Lint", [step("Lint")], "success")],
    logs: { 1: SOURCES_LOG },
    register: register(ROWS.sources),
    now: NOW,
  });
  assert.deepEqual(result.blocked, []);
  assert.equal(result.ok, true);
  assert.equal(result.matched[0].row.id, ROWS.sources.id);
  assert.match(summary(result), /sources-list-library-size/);
});

test("the same test with another error blocks", () => {
  const other = SOURCES_LOG.replace(
    "Error: Test timed out in 30000ms.",
    "AssertionError: expected 3 to be 4",
  );
  const result = evaluate({
    jobs: [webJob()],
    logs: { 1: other },
    register: register(ROWS.sources),
    now: NOW,
  });
  assert.equal(result.ok, false);
});

test("another failed test beside a quarantined one blocks", () => {
  const two = SOURCES_LOG.replace("Failed Tests 1", "Failed Tests 2")
    .replace(/Tests {2}1 failed/, "Tests  2 failed")
    .replace(
      "⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯",
      `⎯⎯⎯[1/2]⎯\n${at(10.5)}  FAIL   browser (chromium)  src/other.browser.test.tsx > breaks\n${at(10.5)} Error: Test timed out in 30000ms.\n${at(10.5)} ⎯⎯⎯[2/2]⎯`,
    );
  const result = evaluate({
    jobs: [webJob()],
    logs: { 1: two },
    register: register(ROWS.sources),
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.match(result.blocked.join("\n"), /src\/other\.browser\.test\.tsx > breaks matches no row/);
});

test("an expired row blocks and says it expired", () => {
  const result = evaluate({
    jobs: [webJob()],
    logs: { 1: SOURCES_LOG },
    register: register(ROWS.sources),
    now: new Date("2026-11-25T08:00:00Z"),
  });
  assert.equal(result.ok, false);
  assert.match(result.blocked.join("\n"), /expired 2026-11-24/);
});

test("a row for another step, a missing log or a cancelled job blocks", () => {
  const failingSetup = job(1, "Test Web 1", [
    step("Setup Vite+", "failure"),
    step("Test", "skipped"),
  ]);
  for (const [jobs, logs] of [
    [[failingSetup], { 1: SOURCES_LOG }],
    [[webJob()], {}],
    [[{ ...webJob(), conclusion: "cancelled" }], { 1: SOURCES_LOG }],
    [[job(1, "Test Web 1", [step("Test", "success")])], { 1: SOURCES_LOG }],
  ]) {
    const result = evaluate({ jobs, logs, register: register(ROWS.sources), now: NOW });
    assert.equal(result.ok, false, JSON.stringify(jobs));
  }
});

test("a script step matches by its signature inside that step's own output", () => {
  const installer = (start, end) =>
    job(3, ROWS.voice.job, [
      step("Build the installer", "success", T0, at(5)),
      step(ROWS.voice.step, "failure", start, end),
    ]);
  const voiceLog = log(
    "Transcribing the reference recording",
    "Offline voice transcription timed out.",
    "##[error]Process completed with exit code 1.",
  );
  const inside = evaluate({
    jobs: [installer(at(9), at(11)), wslWitness()],
    logs: { 3: voiceLog },
    register: register(ROWS.voice),
    now: NOW,
  });
  assert.equal(inside.ok, true, inside.blocked.join("\n"));
  // The same text printed by an earlier step does not explain this step's failure.
  const earlier = evaluate({
    jobs: [installer(at(20), at(30)), wslWitness()],
    logs: { 3: voiceLog },
    register: register(ROWS.voice),
    now: NOW,
  });
  assert.equal(earlier.ok, false);
  assert.match(earlier.blocked.join("\n"), /no step times|no row's signature ends its output/);
});

test("vitest failures in a script row's step block", () => {
  const result = evaluate({
    jobs: [job(3, ROWS.voice.job, [step(ROWS.voice.step, "failure")]), wslWitness()],
    logs: { 3: `${SOURCES_LOG}\n${at(11)} Offline voice transcription timed out.` },
    register: register(ROWS.voice),
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.blocked.join("\n"), /quarantined only beside/);
});

test("the receipt passes only as a consequence of quarantined jobs", () => {
  const [receiptRule] = CONSEQUENCES;
  const receipt = job(9, receiptRule.job, [step(receiptRule.step, "failure")]);
  const installer = job(3, ROWS.voice.job, [step(ROWS.voice.step, "failure", at(9), at(11))]);
  const logs = {
    1: SOURCES_LOG,
    3: log(
      "Offline voice transcription timed out.",
      "##[error]Process completed with exit code 1.",
    ),
    9: log("Error: CI qualification is missing: test_web: failure, windows_packaging: failure"),
  };
  const registered = register(ROWS.sources, ROWS.voice);
  const decide = (jobs, override = {}) =>
    evaluate({ jobs, logs: { ...logs, ...override }, register: registered, now: NOW });
  const [wslRule] = WITNESSES;
  const wsl = (conclusion, exercised = conclusion) =>
    job(8, wslRule.witness, [step(wslRule.step, exercised)], conclusion);
  const pass = decide([webJob(), installer, wsl("success"), receipt]);
  assert.equal(pass.ok, true, pass.blocked.join("\n"));
  // The waived installer failure needs its WSL payload exercised: a skipped, cancelled, failed
  // or absent WSL job blocks.
  for (const jobs of [
    [webJob(), installer, wsl("skipped"), receipt],
    [webJob(), installer, wsl("cancelled"), receipt],
    [webJob(), installer, wsl("success", "skipped"), receipt],
    [webJob(), installer, receipt],
  ])
    assert.equal(decide(jobs).ok, false);
  // Alone, the receipt's failure explains nothing.
  assert.equal(decide([receipt]).ok, false);
  // The receipt refusing anything but failed needs blocks.
  assert.equal(
    decide([webJob(), receipt], { 9: log("Error: CI qualification is missing: lint: cancelled") })
      .ok,
    false,
  );
  assert.equal(
    decide([webJob(), receipt], { 9: log("Error: Invalid queue comparison") }).ok,
    false,
  );
  // The receipt failing in another step blocks.
  const other = job(9, receipt.name, [step("Download evidence", "failure")]);
  assert.equal(decide([webJob(), other]).ok, false);
  // A WSL qualification that failed, here because the installer reported no payload, is not a
  // consequence: it blocks even when the installer's own failure is quarantined.
  const noPayload = job(8, wslRule.witness, [
    step("Require the installer's own WSL payload", "failure"),
    step(wslRule.step, "skipped"),
  ]);
  assert.equal(
    decide([webJob(), installer, noPayload, receipt], {
      8: log("The installer job reported no WSL payload."),
    }).ok,
    false,
  );
});

test("a quarantined failure that skipped a later check blocks", () => {
  const google = {
    id: "google",
    job: "Test 6",
    step: "Explain Google's sign-in refusal in Electron's browser",
    test: null,
    signature: "Error: Failed during Google refusing that site's Continue with Google",
    owner: "Browser access",
    quarantined: "2026-11-17",
    expires: "2026-11-24",
  };
  const googleLog = log(google.signature, "##[error]Process completed with exit code 1.");
  const testJob = (later) =>
    job(4, "Test 6", [step("Test"), step(google.step, "failure", at(9), at(11)), ...later]);
  const decide = (later) =>
    evaluate({
      jobs: [testJob(later)],
      logs: { 4: googleLog },
      register: register(google),
      now: NOW,
    });
  assert.equal(decide([step("Post Setup Vite+", "skipped"), step("Post Checkout")]).ok, true);
  assert.equal(decide([step("Run actions/upload-artifact@043fb46d1a93", "skipped")]).ok, true);
  const skipped = decide([step("Test release checks", "skipped")]);
  assert.equal(skipped.ok, false);
  assert.match(skipped.blocked.join("\n"), /Test release checks \(skipped\) did not run/);
  assert.equal(decide([step("Test release checks", "cancelled")]).ok, false);
});

// A step condition runs after a failure only if `always()` or `!cancelled()` opens it or one of
// its `||` branches; `success() && !cancelled()` still skips.
const runsAfterFailure = (condition) =>
  /(?:^(?:\$\{\{ )?|\|\| \(?)(?:always\(\)|!cancelled\(\))/.test(condition);

// The steps listed after each `- name: <step>` in the workflows, as GitHub names them.
function stepsAfter(workflow, name) {
  const lines = workflow.split("\n");
  const found = [];
  lines.forEach((line, index) => {
    const own = /^(\s*)- name: (.+)$/.exec(line);
    if (!own || own[2].trim() !== name) return;
    const indent = own[1].length;
    const later = [];
    for (const next of lines.slice(index + 1)) {
      if (/^\s*(#.*)?$/.test(next)) continue;
      const lead = /^\s*/.exec(next)[0].length;
      if (lead < indent || (lead === indent && !next.slice(indent).startsWith("- "))) break;
      if (lead === indent) later.push({});
      // Fields of the row's own step come before any later step; deeper lines are values.
      if (later.length === 0 || (lead !== indent && lead !== indent + 2)) continue;
      const field = /^(?:- )?(name|uses|if): ?(.*)$/.exec(
        next.slice(lead === indent ? indent : indent + 2),
      );
      if (field) later.at(-1)[field[1]] = field[2];
    }
    found.push(
      later.map((step) => ({
        name: step.name ?? `Run ${(step.uses ?? "").split(" ")[0]}`,
        if: step.if ?? "",
      })),
    );
  });
  return found;
}

test("every checked-in row's step is followed only by steps its waiver lets skip or that still run", () => {
  // A later check skipped after the waived step blocks the row (previous test), so a step added
  // after a row's step without `always()` or `!cancelled()` silently switches the row off.
  const workflows = fs
    .readdirSync(path.join(ROOT, ".github/workflows"))
    .filter((file) => file.endsWith(".yml"))
    .map((file) => fs.readFileSync(path.join(ROOT, ".github/workflows", file), "utf8"));
  for (const row of readRegister(ROOT).rows) {
    const jobs = workflows.flatMap((workflow) => stepsAfter(workflow, row.step));
    assert.ok(jobs.length > 0, `${row.id}: no workflow step is named ${row.step}`);
    for (const later of jobs)
      for (const step of later)
        assert.ok(
          AFTER_FAILURE.test(step.name) ||
            RUN_DESPITE_FAILURE.includes(step.name) ||
            runsAfterFailure(step.if),
          `${row.id}: ${step.name} after ${row.step} would be skipped by its failure`,
        );
  }
});

test("the step-order check accepts only conditions that run after a failure", () => {
  for (const condition of [
    "always()",
    "${{ !cancelled() && matrix.part == 6 }}",
    "${{ success() || (!cancelled() && steps.voice_transcription.outcome == 'failure') }}",
  ])
    assert.equal(runsAfterFailure(condition), true, condition);
  for (const condition of ["", "${{ success() && !cancelled() }}", "${{ matrix.part == 6 }}"])
    assert.equal(runsAfterFailure(condition), false, condition);
});

test("the step-order check reads GitHub's step names and conditions", () => {
  const workflow = [
    "jobs:",
    "  one:",
    "    steps:",
    "      - name: Flaky",
    "        run: exit 1",
    "      # A comment",
    "      - uses: actions/upload-artifact@043fb46d1a93 # v7",
    "        with:",
    "          name: not-a-step-name",
    "      - name: Later check",
    "        if: ${{ !cancelled() && steps.flaky.outcome == 'failure' }}",
    "        run: exit 0",
    "  two:",
    "    steps:",
    "      - name: Other",
  ].join("\n");
  assert.deepEqual(stepsAfter(workflow, "Flaky"), [
    [
      { name: "Run actions/upload-artifact@043fb46d1a93", if: "" },
      { name: "Later check", if: "${{ !cancelled() && steps.flaky.outcome == 'failure' }}" },
    ],
  ]);
});

test("a script row's signature must be in the output that ended its step", () => {
  const installer = job(3, ROWS.voice.job, [step(ROWS.voice.step, "failure", at(9), at(30))]);
  const filler = Array.from({ length: 80 }, (_, i) => `transcribing chunk ${i}`);
  const early = log(
    ROWS.voice.signature,
    ...filler,
    "Error: the server exited",
    "##[error]Process completed with exit code 1.",
  );
  const result = evaluate({
    jobs: [installer, wslWitness()],
    logs: { 3: early },
    register: register(ROWS.voice),
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.match(result.blocked.join("\n"), /no row's signature ends its output/);
});

test("unhandled errors never quarantine, even beside a matching test", () => {
  const unhandled = SOURCES_LOG.replace(
    "##[error]Process completed with exit code 1.",
    [
      "⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯",
      "Vitest caught 1 unhandled error during the test run.",
      "⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯",
      "Error: Test timed out in 30000ms.",
      'This error originated in "src/scient/sources/SourcesList.browser.test.tsx" test file.',
      "⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯",
      "⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯",
      "     Errors  1 error",
      "##[error]Process completed with exit code 1.",
    ].join(`\n${at(10.4)} `),
  );
  const result = evaluate({
    jobs: [webJob()],
    logs: { 1: unhandled },
    register: register(ROWS.sources),
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.match(result.blocked.join("\n"), /never quarantine/);
});

test("tests that failed the same way share the error vitest prints once below them", () => {
  const { entries, problems } = parseVitest(
    log(
      "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯",
      " FAIL   unit  src/a.real.test.ts > window > reads nothing when Chrome's window is cancelled",
      " FAIL   unit  src/a.real.test.ts > window > reads nothing when Edge's window is cancelled",
      "",
      "Error: Test timed out in 120000ms.",
      // Windows interleaves the summary with the report.
      " Test Files  1 failed (1)",
      "      Tests  2 failed | 2 passed (4)",
      "⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯",
    ),
  );
  assert.deepEqual(problems, []);
  assert.deepEqual(
    entries.map((e) => e.id),
    [
      "unit src/a.real.test.ts > window > reads nothing when Chrome's window is cancelled",
      "unit src/a.real.test.ts > window > reads nothing when Edge's window is cancelled",
    ],
  );
  for (const entry of entries) assert.match(entry.block, /Test timed out in 120000ms/);
});

test("step logs keep the lines written between the step's start and end", () => {
  const text = log("first", "second");
  assert.match(stepLog(text, step("x", "failure", at(9), at(10))), /first/);
  assert.equal(stepLog(text, step("x", "failure", at(20), at(30))), "");
});

test("advisory jobs never block or count, and an unfinished job blocks", () => {
  const advisory = job(5, "Overleaf macOS", [step("Test", "failure")]);
  const result = evaluate({
    jobs: [webJob(), advisory],
    logs: { 1: SOURCES_LOG },
    register: register(ROWS.sources),
    now: NOW,
  });
  assert.equal(result.ok, true, result.blocked.join("\n"));
  const running = {
    ...job(6, "Test Server 2", [step("Test", null)]),
    conclusion: null,
    status: "in_progress",
  };
  assert.equal(
    evaluate({
      jobs: [webJob(), running],
      logs: { 1: SOURCES_LOG },
      register: register(ROWS.sources),
      now: NOW,
    }).ok,
    false,
  );
});

test("the advisory job names are the ones ci.yml gives ci-check's advisory jobs", () => {
  const { ADVISORY } = require("./ci-check.cjs");
  const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const names = ADVISORY.map(
    (key) => new RegExp(`^  ${key}:\\n(?:    .*\\n)*?    name: (.+)$`, "m").exec(workflow)?.[1],
  );
  assert.deepEqual(names.toSorted(), [...ADVISORY_JOBS].toSorted());
});

test("the witness jobs and steps exist under these names", () => {
  const workflow = fs.readFileSync(
    path.join(ROOT, ".github/workflows/windows-packaging.yml"),
    "utf8",
  );
  for (const { job: name, witness, step: s } of WITNESSES) {
    for (const each of [name, witness])
      assert.ok(workflow.includes(`name: ${each.split(" / ").slice(1).join(" / ")}`), each);
    assert.ok(workflow.includes(`- name: ${s}`), s);
  }
});

test("the consequence jobs and steps exist under these names", () => {
  const workflows = [".github/workflows/ci.yml", ".github/workflows/windows-packaging.yml"]
    .map((file) => fs.readFileSync(path.join(ROOT, file), "utf8"))
    .join("\n");
  for (const { job: name, step: s } of CONSEQUENCES) {
    // A reusable workflow's jobs are named `<caller job id> / <its own name>`.
    const own = name.includes(" / ") ? name.split(" / ").slice(1).join(" / ") : name;
    assert.ok(workflows.includes(`name: ${own}`), name);
    assert.ok(workflows.includes(`- name: ${s}`), s);
  }
});

test("steps that run despite an earlier failure say so in ci.yml, wherever they are", () => {
  const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  for (const name of RUN_DESPITE_FAILURE) {
    const conditions = [
      ...workflow.matchAll(
        new RegExp(`- name: ${name.replace(/[()]/g, "\\$&")}\\n\\s+if: (.+)`, "g"),
      ),
    ];
    assert.ok(conditions.length > 0, name);
    for (const [, condition] of conditions)
      assert.match(condition, /^(\$\{\{ !cancelled\(\) && |always\(\) && )/, name);
  }
  // In the parts where they do not apply they are skipped by their own condition, which does
  // not block a quarantined failure of the package tests before them.
  const row = {
    ...readRegister(ROOT).rows[0],
    id: "part-1-test",
    job: "Test",
    step: "Test",
    test: "src/a.test.ts > one",
    signature: "Error: Test timed out in 30000ms.",
  };
  const failure = log(
    "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯",
    " FAIL  src/a.test.ts > one",
    "Error: Test timed out in 30000ms.",
    "⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯",
    "      Tests  1 failed | 3 passed (4)",
  );
  const part1 = job(7, "Test", [
    step("Test", "failure"),
    ...RUN_DESPITE_FAILURE.map((name) => step(name, "skipped")),
    step("Post Checkout"),
  ]);
  const result = evaluate({
    jobs: [part1],
    logs: { 7: failure },
    register: register(row),
    now: NOW,
  });
  assert.equal(result.ok, true, result.blocked.join("\n"));
});
