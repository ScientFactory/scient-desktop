import type {
  ComputeExecutionRecord,
  ComputeOutput,
  ComputeRuntimeVerification,
  ComputeSessionRecord,
} from "@scientfactory/compute";

import {
  COMPUTE_FIXTURE_FIGURE_BYTE_LENGTH,
  COMPUTE_FIXTURE_FIGURE_HASH,
} from "./computeFigureFixture";

/**
 * Browser-side compute fixtures, typed against the real contract.
 *
 * These deliberately do not use `createSimulatedComputeTransport`. That
 * simulator implements `ComputeTransport`, which is the server's side of the
 * boundary; it can drive a session service but it cannot drive a React tree,
 * and Phases 3 and 4 have not yet built the wire between them. Until they do,
 * the smallest honest external boundary for a UI design is the shape a client
 * actually reads: a session record, its executions, and their outputs.
 *
 * They are typed against `@scientfactory/compute` rather than against local
 * mirror types on purpose. Mirrors drift silently; imports fail the typecheck
 * the moment the contract moves, which is how the Zotero fixtures reported four
 * shipped contract changes at the last rebuild. The `as` casts below are only
 * for branded primitives -- the field names and shapes are checked.
 */

type Branded<T> = T;
const id = <T>(value: string): Branded<T> => value as unknown as T;
const generation = <T>(value: number): Branded<T> => value as unknown as T;

type SessionId = ComputeSessionRecord["sessionId"];
type ProjectId = ComputeSessionRecord["projectId"];
type LanguageId = ComputeSessionRecord["languageId"];
type TransportKind = ComputeSessionRecord["transportKind"];
type Generation = ComputeSessionRecord["generation"];
type ExecutionId = ComputeExecutionRecord["request"]["executionId"];

const PROJECT_ID = id<ProjectId>("scient-next-dev");
const SESSION_ID = id<SessionId>("cs_01J9QK3M4N5P6Q7R8S9T0V");
const PYTHON = id<LanguageId>("python");
const JUPYTER = id<TransportKind>("jupyter-stdio");
const WORKING_DIRECTORY = "/Users/yaacov/REPOs/ScientFactory/scient-next-dev";

const RUNTIME: NonNullable<ComputeSessionRecord["runtime"]> = {
  languageId: PYTHON,
  source: "project",
  executable: `${WORKING_DIRECTORY}/.venv/bin/python3`,
  languageVersion: "3.12.4",
  architecture: "arm64",
  displayName: "Project virtualenv (.venv)",
};

const IDENTITY: NonNullable<ComputeSessionRecord["identity"]> = {
  languageId: PYTHON,
  transportKind: JUPYTER,
  protocolVersion: 1,
  languageVersion: "3.12.4",
  platform: "darwin-arm64",
  transportProcessId: 68412,
  runtimeProcessId: 68415,
};

const FINGERPRINT: NonNullable<ComputeSessionRecord["environmentFingerprint"]> = {
  hash: "sha256:c1f0a9d7b48e2a5f6b3c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a",
  contributors: ["pyproject.toml", "uv.lock", ".venv/pyvenv.cfg", "PYTHONPATH"],
};

const T0 = Date.parse("2026-08-20T09:14:02.000Z");
const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

function session(overrides: Partial<ComputeSessionRecord> = {}): ComputeSessionRecord {
  return {
    sessionId: SESSION_ID,
    projectId: PROJECT_ID,
    label: "Cohort analysis",
    languageId: PYTHON,
    transportKind: JUPYTER,
    workingDirectory: WORKING_DIRECTORY,
    runtime: RUNTIME,
    identity: IDENTITY,
    environmentFingerprint: FINGERPRINT,
    generation: generation<Generation>(1),
    status: "ready",
    activity: "idle",
    activeExecutionId: null,
    pendingCount: 0,
    storage: {
      status: "retained",
      outputBytes: 18_432,
      imageBytes: COMPUTE_FIXTURE_FIGURE_BYTE_LENGTH,
      totalBytes: 18_432 + COMPUTE_FIXTURE_FIGURE_BYTE_LENGTH,
      removedAt: null,
    },
    createdAt: at(0),
    lastActivityAt: at(96_000),
    closedAt: null,
    lostReason: null,
    ...overrides,
  };
}

type ExecutionSeed = {
  readonly key: string;
  readonly gen: number;
  readonly code: string;
  readonly source: ComputeExecutionRecord["request"]["source"];
  readonly submittedAt: number;
  readonly result: ComputeExecutionRecord["result"];
};

function execution(seed: ExecutionSeed): ComputeExecutionRecord {
  return {
    request: {
      executionId: id<ExecutionId>(seed.key),
      sessionId: SESSION_ID,
      generation: generation<Generation>(seed.gen),
      code: seed.code,
      codeHash: `sha256:${seed.key}`,
      source: seed.source,
      submittedAt: at(seed.submittedAt),
      environmentFingerprint: FINGERPRINT,
    },
    result: seed.result,
  };
}

const consoleSource = {
  _tag: "console",
} as const satisfies ComputeExecutionRecord["request"]["source"];

const fileSource = (
  path: string,
  origin: "file" | "selection" | "cell",
  bufferState: "saved" | "dirty",
  range: { startLine: number; startColumn: number; endLine: number; endColumn: number } | null,
  revision: string | null = "a1b2c3d",
) =>
  ({
    _tag: "document",
    origin,
    path,
    bufferState,
    revision,
    range,
  }) as const satisfies ComputeExecutionRecord["request"]["source"];

/** The imports execution: succeeded, plain stdout. */
const EXEC_IMPORTS = execution({
  key: "ce_0001_imports",
  gen: 1,
  code: "import numpy as np\nimport pandas as pd\nfrom pathlib import Path\n\nprint(f'pandas {pd.__version__}')",
  source: fileSource("analysis/cohort.py", "cell", "saved", {
    startLine: 0,
    startColumn: 0,
    endLine: 4,
    endColumn: 38,
  }),
  submittedAt: 4_000,
  result: {
    executionId: id<ExecutionId>("ce_0001_imports"),
    status: "succeeded",
    outcome: "succeeded",
    queuePosition: null,
    startedAt: at(4_120),
    finishedAt: at(5_890),
    diagnostics: [],
    outputCount: 1,
    outputBytes: 16,
    truncated: false,
    failureReason: null,
  },
});

/** The load execution: succeeded, stdout plus a stderr warning. */
const EXEC_LOAD = execution({
  key: "ce_0002_load",
  gen: 1,
  code: "cohort = pd.read_parquet('data/cohort_2026.parquet')\ncohort.shape",
  source: fileSource("analysis/cohort.py", "selection", "dirty", {
    startLine: 12,
    startColumn: 0,
    endLine: 13,
    endColumn: 12,
  }),
  submittedAt: 22_000,
  result: {
    executionId: id<ExecutionId>("ce_0002_load"),
    status: "succeeded",
    outcome: "succeeded",
    queuePosition: null,
    startedAt: at(22_140),
    finishedAt: at(31_402),
    diagnostics: [],
    outputCount: 3,
    outputBytes: 412,
    truncated: false,
    failureReason: null,
  },
});

/** The figure execution: succeeded, produces a matplotlib PNG. */
const EXEC_FIGURE = execution({
  key: "ce_0003_figure",
  gen: 1,
  code: "fig, ax = plt.subplots(figsize=(6.4, 4))\nax.plot(t, response, label='damped')\nax.plot(t, baseline, label='baseline')\nax.legend()\nfig",
  source: consoleSource,
  submittedAt: 74_000,
  result: {
    executionId: id<ExecutionId>("ce_0003_figure"),
    status: "succeeded",
    outcome: "succeeded",
    queuePosition: null,
    startedAt: at(74_180),
    finishedAt: at(76_050),
    diagnostics: [],
    outputCount: 2,
    outputBytes: COMPUTE_FIXTURE_FIGURE_BYTE_LENGTH,
    truncated: false,
    failureReason: null,
  },
});

const OUTPUTS_IMPORTS: readonly ComputeOutput[] = [
  { _tag: "stream", sequence: 1, observedAt: at(5_800), stream: "stdout", text: "pandas 2.2.2\n" },
];

const OUTPUTS_LOAD: readonly ComputeOutput[] = [
  {
    _tag: "stream",
    sequence: 2,
    observedAt: at(24_500),
    stream: "stderr",
    text: "/Users/yaacov/REPOs/ScientFactory/scient-next-dev/.venv/lib/python3.12/site-packages/pyarrow/pandas_compat.py:373: FutureWarning: is_sparse is deprecated and will be removed in a future version.\n  if is_sparse(col):\n",
  },
  {
    _tag: "stream",
    sequence: 3,
    observedAt: at(31_200),
    stream: "stdout",
    text: "(48210, 37)\n",
  },
];

const OUTPUTS_FIGURE: readonly ComputeOutput[] = [
  {
    _tag: "image",
    sequence: 4,
    observedAt: at(75_900),
    mediaType: "image/png",
    contentHash: COMPUTE_FIXTURE_FIGURE_HASH,
    byteLength: COMPUTE_FIXTURE_FIGURE_BYTE_LENGTH,
    width: 640,
    height: 400,
  },
];

/** What a client reads to render the surface. */
export type ComputeLabFixture = {
  /** Null before any session exists: the environment-selection surface. */
  readonly session: ComputeSessionRecord | null;
  /** Oldest first, exactly as a transcript is read. */
  readonly executions: readonly ComputeExecutionRecord[];
  /** Keyed by execution id; session-scoped output uses the empty key. */
  readonly outputs: Readonly<Record<string, readonly ComputeOutput[]>>;
  /** Discovery results, in the contract's precedence order. */
  readonly discovered: readonly ComputeRuntimeVerification[];
  /** What the lab is trying to show, stated for the design's own sake. */
  readonly note: string;
};

const DISCOVERED: readonly ComputeRuntimeVerification[] = [
  {
    profile: RUNTIME,
    readiness: "ready",
    missingRequirements: [],
    message: null,
  },
  {
    profile: {
      languageId: PYTHON,
      source: "configured",
      executable: "/opt/homebrew/bin/python3.13",
      languageVersion: "3.13.1",
      architecture: "arm64",
      displayName: "Homebrew Python 3.13",
    },
    readiness: "missing-requirement",
    missingRequirements: ["ipykernel", "matplotlib"],
    message: "Install ipykernel and matplotlib to run a session in this interpreter.",
  },
  {
    profile: {
      languageId: PYTHON,
      source: "path",
      executable: "/usr/bin/python3",
      languageVersion: "3.9.6",
      architecture: "arm64",
      displayName: "System Python (Command Line Tools)",
    },
    readiness: "unsupported-version",
    missingRequirements: [],
    message: "Scient compute sessions require Python 3.10 or newer.",
  },
  {
    profile: {
      languageId: PYTHON,
      source: "conventional",
      executable: "/Users/yaacov/.pyenv/shims/python",
      languageVersion: "unknown",
      architecture: null,
      displayName: "pyenv shim",
    },
    readiness: "unusable",
    missingRequirements: [],
    message: "The interpreter exited before reporting its version.",
  },
];

const HEALTHY_TRANSCRIPT = [EXEC_IMPORTS, EXEC_LOAD, EXEC_FIGURE];
const HEALTHY_OUTPUTS = {
  ce_0001_imports: OUTPUTS_IMPORTS,
  ce_0002_load: OUTPUTS_LOAD,
  ce_0003_figure: OUTPUTS_FIGURE,
};

export const computeLabScenarios = [
  { value: "ready-idle", label: "Ready · idle" },
  { value: "running-queue", label: "Running · queue behind it" },
  { value: "traceback", label: "Failed · Python traceback" },
  { value: "restarted", label: "Restarted · namespace lost" },
  { value: "unresponsive", label: "Ready but not responding" },
  { value: "session-lost", label: "Session lost mid-run" },
  { value: "truncated", label: "Output truncated" },
  { value: "no-session", label: "No session · choose interpreter" },
] as const;

export type ComputeLabScenario = (typeof computeLabScenarios)[number]["value"];

export const DEFAULT_COMPUTE_LAB_SCENARIO: ComputeLabScenario = "ready-idle";

export function normalizeComputeLabScenario(value: string | null): ComputeLabScenario {
  return computeLabScenarios.some((scenario) => scenario.value === value)
    ? (value as ComputeLabScenario)
    : DEFAULT_COMPUTE_LAB_SCENARIO;
}

export function computeLabFixture(scenario: ComputeLabScenario): ComputeLabFixture {
  switch (scenario) {
    case "ready-idle":
      return {
        session: session(),
        executions: HEALTHY_TRANSCRIPT,
        outputs: HEALTHY_OUTPUTS,
        discovered: DISCOVERED,
        note: "The ordinary case. Everything else is a deviation from this.",
      };

    case "running-queue": {
      const running = execution({
        key: "ce_0004_fit",
        gen: 1,
        code: "model = fit_hierarchical(cohort, draws=4000, chains=4)\nmodel.summary()",
        source: fileSource("analysis/cohort.py", "cell", "saved", {
          startLine: 40,
          startColumn: 0,
          endLine: 41,
          endColumn: 16,
        }),
        submittedAt: 96_000,
        result: {
          executionId: id<ExecutionId>("ce_0004_fit"),
          status: "running",
          outcome: null,
          queuePosition: null,
          startedAt: at(96_240),
          finishedAt: null,
          diagnostics: [],
          outputCount: 2,
          outputBytes: 128,
          truncated: false,
          failureReason: null,
        },
      });
      const queuedFirst = execution({
        key: "ce_0005_plot",
        gen: 1,
        code: "plot_posterior(model)",
        source: consoleSource,
        submittedAt: 101_000,
        result: {
          executionId: id<ExecutionId>("ce_0005_plot"),
          status: "queued",
          outcome: null,
          queuePosition: 1,
          startedAt: null,
          finishedAt: null,
          diagnostics: [],
          outputCount: 0,
          outputBytes: 0,
          truncated: false,
          failureReason: null,
        },
      });
      const queuedSecond = execution({
        key: "ce_0006_export",
        gen: 1,
        code: "export_summary(model, 'out/summary.csv')",
        source: fileSource("analysis/export.py", "file", "saved", null),
        submittedAt: 103_000,
        result: {
          executionId: id<ExecutionId>("ce_0006_export"),
          status: "queued",
          outcome: null,
          queuePosition: 2,
          startedAt: null,
          finishedAt: null,
          diagnostics: [],
          outputCount: 0,
          outputBytes: 0,
          truncated: false,
          failureReason: null,
        },
      });
      return {
        session: session({
          status: "ready",
          activity: "busy",
          activeExecutionId: id<ExecutionId>("ce_0004_fit"),
          pendingCount: 2,
          lastActivityAt: at(103_000),
        }),
        executions: [...HEALTHY_TRANSCRIPT, running, queuedFirst, queuedSecond],
        outputs: {
          ...HEALTHY_OUTPUTS,
          ce_0004_fit: [
            {
              _tag: "stream",
              sequence: 5,
              observedAt: at(97_100),
              stream: "stderr",
              text: "Auto-assigning NUTS sampler...\nInitializing NUTS using jitter+adapt_diag...\n",
            },
            {
              _tag: "stream",
              sequence: 6,
              observedAt: at(118_000),
              stream: "stdout",
              text: "Sampling 4 chains:  38%|███▊      | 1520/4000 [00:21<00:34, 71.9draws/s]",
            },
          ],
        },
        discovered: DISCOVERED,
        note: "Interrupt has to be reachable, and the queue behind the running cell has to be legible and cancellable.",
      };
    }

    case "traceback": {
      const failed = execution({
        key: "ce_0004_merge",
        gen: 1,
        code: "merged = cohort.merge(labels, on='subject_id', validate='one_to_one')",
        source: fileSource("analysis/cohort.py", "cell", "dirty", {
          startLine: 52,
          startColumn: 0,
          endLine: 52,
          endColumn: 68,
        }),
        submittedAt: 96_000,
        result: {
          executionId: id<ExecutionId>("ce_0004_merge"),
          status: "failed",
          outcome: "failed",
          queuePosition: null,
          startedAt: at(96_180),
          finishedAt: at(98_540),
          diagnostics: [
            {
              errorName: "MergeError",
              message: "Merge keys are not unique in left dataset; not a one-to-one merge",
              traceback: [
                "Traceback (most recent call last):",
                '  File "<scient-session>", line 1, in <module>',
                "    merged = cohort.merge(labels, on='subject_id', validate='one_to_one')",
                '  File ".venv/lib/python3.12/site-packages/pandas/core/frame.py", line 10832, in merge',
                "    return merge(",
                '  File ".venv/lib/python3.12/site-packages/pandas/core/reshape/merge.py", line 170, in merge',
                "    op = _MergeOperation(",
                '  File ".venv/lib/python3.12/site-packages/pandas/core/reshape/merge.py", line 813, in __init__',
                "    self._validate_validate_kwd(validate)",
                '  File ".venv/lib/python3.12/site-packages/pandas/core/reshape/merge.py", line 1657, in _validate_validate_kwd',
                "    raise MergeError(",
                "pandas.errors.MergeError: Merge keys are not unique in left dataset; not a one-to-one merge",
              ],
            },
          ],
          outputCount: 1,
          outputBytes: 1_204,
          truncated: false,
          failureReason: null,
        },
      });
      return {
        session: session({ lastActivityAt: at(98_540) }),
        executions: [...HEALTHY_TRANSCRIPT, failed],
        outputs: {
          ...HEALTHY_OUTPUTS,
          ce_0004_merge: [
            {
              _tag: "diagnostic",
              sequence: 5,
              observedAt: at(98_500),
              diagnostic: {
                errorName: "MergeError",
                message: "Merge keys are not unique in left dataset; not a one-to-one merge",
                traceback: [
                  "Traceback (most recent call last):",
                  '  File "<scient-session>", line 1, in <module>',
                  "    merged = cohort.merge(labels, on='subject_id', validate='one_to_one')",
                  '  File ".venv/lib/python3.12/site-packages/pandas/core/frame.py", line 10832, in merge',
                  "    return merge(",
                  '  File ".venv/lib/python3.12/site-packages/pandas/core/reshape/merge.py", line 170, in merge',
                  "    op = _MergeOperation(",
                  '  File ".venv/lib/python3.12/site-packages/pandas/core/reshape/merge.py", line 813, in __init__',
                  "    self._validate_validate_kwd(validate)",
                  '  File ".venv/lib/python3.12/site-packages/pandas/core/reshape/merge.py", line 1657, in _validate_validate_kwd',
                  "    raise MergeError(",
                  "pandas.errors.MergeError: Merge keys are not unique in left dataset; not a one-to-one merge",
                ],
              },
            },
          ],
        },
        discovered: DISCOVERED,
        note: "A failure is still a normal result. The user's own frame matters; ten library frames do not, until asked for.",
      };
    }

    case "restarted": {
      const afterRestart = execution({
        key: "ce_0007_reload",
        gen: 2,
        code: "cohort = pd.read_parquet('data/cohort_2026.parquet')",
        source: consoleSource,
        submittedAt: 190_000,
        result: {
          executionId: id<ExecutionId>("ce_0007_reload"),
          status: "succeeded",
          outcome: "succeeded",
          queuePosition: null,
          startedAt: at(190_200),
          finishedAt: at(198_900),
          diagnostics: [],
          outputCount: 0,
          outputBytes: 0,
          truncated: false,
          failureReason: null,
        },
      });
      return {
        session: session({
          generation: generation<Generation>(2),
          lastActivityAt: at(198_900),
          storage: {
            status: "retained",
            outputBytes: 18_432,
            imageBytes: COMPUTE_FIXTURE_FIGURE_BYTE_LENGTH,
            totalBytes: 18_432 + COMPUTE_FIXTURE_FIGURE_BYTE_LENGTH,
            removedAt: null,
          },
        }),
        executions: [...HEALTHY_TRANSCRIPT, afterRestart],
        outputs: {
          ...HEALTHY_OUTPUTS,
          "": [
            {
              _tag: "system",
              sequence: 5,
              observedAt: at(180_000),
              event: "session-restarted",
              detail: "Restarted at your request. Variables from the previous generation are gone.",
            },
          ],
        },
        discovered: DISCOVERED,
        note: "The hardest state to render honestly: the transcript above the restart is true history about a namespace that no longer exists.",
      };
    }

    case "unresponsive":
      return {
        session: session({
          status: "ready",
          activity: "unresponsive",
          activeExecutionId: id<ExecutionId>("ce_0004_fit"),
          pendingCount: 1,
          lastActivityAt: at(96_240),
        }),
        executions: [
          ...HEALTHY_TRANSCRIPT,
          execution({
            key: "ce_0004_fit",
            gen: 1,
            code: "model = fit_hierarchical(cohort, draws=4000, chains=4)",
            source: consoleSource,
            submittedAt: 96_000,
            result: {
              executionId: id<ExecutionId>("ce_0004_fit"),
              status: "running",
              outcome: null,
              queuePosition: null,
              startedAt: at(96_240),
              finishedAt: null,
              diagnostics: [],
              outputCount: 0,
              outputBytes: 0,
              truncated: false,
              failureReason: null,
            },
          }),
        ],
        outputs: {
          ...HEALTHY_OUTPUTS,
          "": [
            {
              _tag: "system",
              sequence: 5,
              observedAt: at(126_240),
              event: "runtime-warning",
              detail:
                "No heartbeat for 30s. The interpreter may be in a tight loop or blocked on I/O.",
            },
          ],
        },
        discovered: DISCOVERED,
        note: "Lifecycle says ready; activity says the runtime is not answering. This combination must never look like 'Ready'.",
      };

    case "session-lost":
      return {
        session: session({
          status: "lost",
          activity: "idle",
          activeExecutionId: null,
          pendingCount: 0,
          lastActivityAt: at(96_240),
          lostReason: "The interpreter process exited with signal SIGKILL (out of memory).",
        }),
        executions: [
          ...HEALTHY_TRANSCRIPT,
          execution({
            key: "ce_0004_fit",
            gen: 1,
            code: "model = fit_hierarchical(cohort, draws=40000, chains=8)",
            source: consoleSource,
            submittedAt: 96_000,
            result: {
              executionId: id<ExecutionId>("ce_0004_fit"),
              status: "lost",
              outcome: null,
              queuePosition: null,
              startedAt: at(96_240),
              finishedAt: at(154_010),
              diagnostics: [],
              outputCount: 1,
              outputBytes: 64,
              truncated: false,
              failureReason: "The session was lost while this execution was running.",
            },
          }),
        ],
        outputs: {
          ...HEALTHY_OUTPUTS,
          "": [
            {
              _tag: "system",
              sequence: 5,
              observedAt: at(154_010),
              event: "session-lost",
              detail: "The interpreter process exited with signal SIGKILL (out of memory).",
            },
          ],
        },
        discovered: DISCOVERED,
        note: "`lost` is not `failed`: nothing was wrong with the code, and the result of the running cell is unknown rather than bad.",
      };

    case "truncated": {
      const noisy = execution({
        key: "ce_0004_loop",
        gen: 1,
        code: "for row in cohort.itertuples():\n    print(row)",
        source: consoleSource,
        submittedAt: 96_000,
        result: {
          executionId: id<ExecutionId>("ce_0004_loop"),
          status: "succeeded",
          outcome: "succeeded",
          queuePosition: null,
          startedAt: at(96_180),
          finishedAt: at(140_400),
          diagnostics: [],
          outputCount: 4_096,
          outputBytes: 1024 * 1024,
          truncated: true,
          failureReason: null,
        },
      });
      return {
        session: session({ lastActivityAt: at(140_400) }),
        executions: [...HEALTHY_TRANSCRIPT, noisy],
        outputs: {
          ...HEALTHY_OUTPUTS,
          ce_0004_loop: [
            {
              _tag: "stream",
              sequence: 5,
              observedAt: at(96_400),
              stream: "stdout",
              text: Array.from(
                { length: 24 },
                (_unused, index) =>
                  `Pandas(Index=${index}, subject_id='S-${String(10_000 + index)}', arm='treatment', baseline=${(3.14 + index * 0.07).toFixed(4)}, week12=${(2.71 + index * 0.05).toFixed(4)})`,
              ).join("\n"),
            },
            {
              _tag: "system",
              sequence: 6,
              observedAt: at(140_300),
              event: "output-truncated",
              detail:
                "Stopped storing output for this execution after 1.0 MB (48,186 further lines discarded).",
            },
          ],
        },
        discovered: DISCOVERED,
        note: "Truncation is a fact about the record, not a rendering detail. It has to be visible where the output stops.",
      };
    }

    case "no-session":
      return {
        session: null,
        executions: [],
        outputs: {},
        discovered: DISCOVERED,
        note: "Before anything runs. Discovery has already happened; the user is choosing, and three of four candidates are unusable.",
      };
  }
}
