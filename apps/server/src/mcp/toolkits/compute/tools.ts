import {
  ComputeResultParameter,
  ComputeResultParameterValues,
  ComputeResultValue,
  ComputeResultsRerunInput,
  NotebookFreshRun,
  NotebookFreshRunStatusInput,
  NotebookFreshRunStopInput,
  ComputeRunHistoryInput,
  ComputeRunHistoryResult,
  ComputeResultsRerunResult,
  DataProfile,
  DataTableColumn,
  DataViewFilter,
  DataViewRevision,
  DataViewSaveInput,
  DataTableRow,
  ComputeResultRevisionId,
  ResultHandoffChoices,
  ResultHandoffExportInput,
  ResultHandoffExportResult,
  ResultHandoffVerifyInput,
  ResultHandoffVerifyResult,
  ComputeResultListedAttempt,
  ComputeResultOutputContent,
  ComputeResultRevision,
  ComputeResultSourceKind,
  ComputeResultSummary,
  ComputeResultsCompareInput,
  ComputeResultsCompareResult,
  ComputeResultsHistoryResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import { ScientOperation, type OperationDefinition } from "../../ScientOperationTool.ts";
import * as AgentInvocationContext from "../../../scient/operations/AgentInvocationContext.ts";
import { WorkspaceBindingResolver } from "../../../scient/projectScope/WorkspaceBindingResolver.ts";
import { ComputeMcpGateway } from "./ComputeMcpGateway.ts";

// MCP clients require an object schema even when a read operation has no
// arguments. This rejects arrays and scalar payloads instead of publishing a
// broad JSON schema that can cause a client to discard the tool catalog.
const EmptyToolInput = Schema.Record(Schema.String, Schema.Never);
const dependencies = [
  AgentInvocationContext.AgentInvocationContext,
  ComputeMcpGateway,
  WorkspaceBindingResolver,
];

export class ScientComputeToolError extends Schema.TaggedError<ScientComputeToolError>()(
  "ScientComputeToolError",
  {
    code: Schema.Literals([
      "project-required",
      "project-changed",
      "session-not-found",
      "compute-failed",
    ]),
    message: Schema.Trimmed.check(Schema.isNonEmpty()),
  },
) {}

const SessionId = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128)).annotate({
  description: "From scient_compute_sessions or an earlier run.",
});
const WaitSeconds = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1800 })).annotate({
  description: "Seconds to wait for the run to finish before returning (default 120).",
});
const OutputWaitSeconds = WaitSeconds.annotate({
  description: "Seconds to wait for a run still going before returning (default 0).",
});
const SetupWaitSeconds = WaitSeconds.annotate({
  description: "Seconds to wait for the install before returning (default 120).",
});
const IncludeImages = Schema.Boolean.annotate({
  description: "Attach figures as images (default true).",
});

export const ComputeToolSession = Schema.Struct({
  session: Schema.String,
  language: Schema.String,
  /** `file <path>`, `agent (this chat)`, `agent (another chat)`, or `user`. */
  owner: Schema.String,
  status: Schema.String,
  busy: Schema.Boolean,
});
export type ComputeToolSession = typeof ComputeToolSession.Type;

export const ComputeToolRun = Schema.Struct({
  run: Schema.String,
  status: Schema.String,
  /** `agent`, `you`, plus what ran (`cell lines 3–9 of analysis.py`). */
  source: Schema.String,
  submittedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
  output: Schema.String,
  figures: Schema.Int,
  parameters: Schema.optional(ComputeResultParameterValues),
  inputs: ComputeResultsRerunInput.fields.inputs,
});
export type ComputeToolRun = typeof ComputeToolRun.Type;

/** Lifted out of the JSON and sent as MCP image content by the Scient tool registration. */
export const ComputeToolImage = Schema.Struct({
  mediaType: Schema.Literals(["image/png", "image/jpeg", "image/gif"]),
  data: Schema.String,
});
export type ComputeToolImage = typeof ComputeToolImage.Type;

const RunResult = Schema.Struct({
  session: ComputeToolSession,
  run: ComputeToolRun,
  images: Schema.optional(Schema.Array(ComputeToolImage)),
  wrote: Schema.optional(Schema.Array(Schema.String)),
  changed: Schema.optional(Schema.Array(Schema.String)),
});

const operation = (id: string): OperationDefinition => ({
  id,
  scope: "workspace",
  requiredCapabilities: ["compute"],
});

const ScientComputeRunTool = Tool.make("scient_compute_run", {
  description:
    "Run a code snippet in Scient Compute. Code from a project file must run with scient_compute_run_file. Variables persist in your chat's session unless you specify a session. Read a run still going with scient_compute_output.",
  parameters: Schema.Struct({
    code: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(1024 * 1024)),
    language: Schema.optional(
      Schema.String.check(Schema.isMaxLength(64)).annotate({
        description:
          "python (default), r, julia, sql, matlab, or a language with a kernel listed by scient_compute_inventory. Ignored with `session`.",
      }),
    ),
    session: Schema.optional(SessionId),
    waitSeconds: Schema.optional(WaitSeconds),
    includeImages: Schema.optional(IncludeImages),
  }),
  success: RunResult,
  failure: ScientComputeToolError,
  dependencies,
})
  .annotate(Tool.Title, "Run code in Scient Compute")
  .annotate(Tool.Meta, { "anthropic/alwaysLoad": true })
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true)
  .annotate(ScientOperation, operation("compute.run"));

const AgentFileParameters = Schema.Record(ComputeResultParameterValues.key, Schema.Json).check(
  Schema.isMaxProperties(200),
);
export type AgentFileParameters = typeof AgentFileParameters.Type;

const ScientComputeRunFileTool = Tool.make("scient_compute_run_file", {
  description:
    "Run a saved script (e.g. analysis.py) in the project environment and record it under the file. Sweep with one call per parameter set. For parameters or inputs, omit session. The script must read SCIENT_PARAMETERS. Publish with scient_results_run. Read with scient_compute_output, or pass run for a one-shot run.",
  parameters: Schema.Struct({
    path: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4096)).annotate({
      description: "The file, relative to the project root.",
    }),
    parameters: Schema.optional(AgentFileParameters).annotate({
      description: 'JSON values by name, for example {"threshold":0.7}.',
    }),
    inputs: ComputeResultsRerunInput.fields.inputs,
    session: Schema.optional(SessionId),
    run: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
    waitSeconds: Schema.optional(WaitSeconds),
    includeImages: Schema.optional(IncludeImages),
  }),
  success: Schema.Struct({
    runtime: Schema.String,
    session: Schema.optional(ComputeToolSession),
    images: Schema.optional(Schema.Array(ComputeToolImage)),
    run: ComputeToolRun,
    wrote: Schema.Array(Schema.String).annotate({
      description: "Project-relative files the run reported writing.",
    }),
    changed: Schema.optional(Schema.Array(Schema.String)).annotate({
      description:
        "Other project files seen changing during the run; another program may have written them.",
    }),
  }),
  failure: ScientComputeToolError,
  dependencies,
})
  .annotate(Tool.Title, "Run a project file in Scient Compute")
  .annotate(Tool.Meta, { "anthropic/alwaysLoad": true })
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true)
  .annotate(ScientOperation, operation("compute.runFile"));

const ScientComputeSessionsTool = Tool.make("scient_compute_sessions", {
  description:
    "List live Compute sessions. Set history to list project runs across sessions and chats. Filter by file or pass notebookBatchId to list a run's cells. Pass next as history.before to page.",
  parameters: Schema.Struct({
    history: Schema.optional(
      Schema.Struct({
        filter: ComputeRunHistoryInput.fields.filter,
        before: ComputeRunHistoryInput.fields.before,
        notebookBatchId: ComputeRunHistoryInput.fields.notebookBatchId,
      }),
    ),
  }),
  success: Schema.Struct({
    sessions: Schema.Array(
      Schema.Struct({
        ...ComputeToolSession.fields,
        recentRuns: Schema.Array(
          Schema.Struct({
            run: Schema.String,
            status: Schema.String,
            source: Schema.String,
            submittedAt: Schema.String,
          }),
        ),
      }),
    ),
    runs: Schema.optional(
      Schema.Array(
        Schema.Struct({
          run: Schema.String,
          session: Schema.optional(Schema.String),
          file: Schema.optional(Schema.String),
          language: Schema.String,
          status: Schema.String,
          submittedAt: Schema.String,
          agentThread: Schema.optional(Schema.String),
          notebookBatch: Schema.optional(Schema.Struct({ id: Schema.String, count: Schema.Int })),
        }),
      ),
    ),
    next: Schema.optional(ComputeRunHistoryResult.fields.next),
  }),
  failure: ScientComputeToolError,
  dependencies,
})
  .annotate(Tool.Title, "List Scient Compute sessions")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, operation("compute.sessions"));

const ScientComputeOutputTool = Tool.make("scient_compute_output", {
  description: "Read a run's output, errors and figures, by default the latest run in the session.",
  parameters: Schema.Struct({
    session: SessionId,
    run: Schema.optional(Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128))),
    waitSeconds: Schema.optional(OutputWaitSeconds),
    includeImages: Schema.optional(IncludeImages),
  }),
  success: RunResult,
  failure: ScientComputeToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read Scient Compute output")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, operation("compute.output"));

const ScientComputeVariablesTool = Tool.make("scient_compute_variables", {
  description:
    "List the variables in a live session with their types, shapes and short previews, without running code.",
  parameters: Schema.Struct({ session: SessionId }),
  success: Schema.Struct({
    session: ComputeToolSession,
    variables: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        type: Schema.String,
        shape: Schema.NullOr(Schema.String),
        preview: Schema.NullOr(Schema.String),
      }),
    ),
    truncated: Schema.Boolean,
  }),
  failure: ScientComputeToolError,
  dependencies,
})
  .annotate(Tool.Title, "List Scient Compute variables")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, operation("compute.variables"));

const ScientComputeControlTool = Tool.make("scient_compute_control", {
  description:
    "Interrupt the running code in a session, restart it (clears its variables), or stop it. Restart or stop the user's own session only when the user asks.",
  parameters: Schema.Struct({
    session: SessionId,
    action: Schema.Literals(["interrupt", "restart", "stop"]),
  }),
  success: Schema.Struct({ session: ComputeToolSession }),
  failure: ScientComputeToolError,
  dependencies,
})
  .annotate(Tool.Title, "Control a Scient Compute session")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, operation("compute.control"));

const ScientComputeSetupTool = Tool.make("scient_compute_setup", {
  description:
    "Add a missing Python package, or install Scient-managed scientific Python (NumPy, pandas, SciPy, Matplotlib, scikit-learn and more) and its Toolkits. When code fails with ModuleNotFoundError, pass `package` (the name pip installs, e.g. scikit-learn for sklearn) and the `session` that failed: Scient adds just that package beside the session's Python, never into it, and the session's next run finds it without a restart. Never pip install into the user's own Python. The first managed install takes a few minutes; call again to check progress.",
  parameters: Schema.Struct({
    package: Schema.optional(
      Schema.String.check(
        Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/u),
      ).annotate({ description: "A package name as pip installs it, without a version." }),
    ),
    session: Schema.optional(
      SessionId.annotate({
        description: "The Python session the package is for; default your own Python session.",
      }),
    ),
    toolkits: Schema.optional(
      Schema.Array(Schema.String.check(Schema.isMaxLength(64)))
        .check(Schema.isMaxLength(16))
        .annotate({
          description:
            "Toolkit ids to add: python-large-data (xarray, Arrow, HDF5, NetCDF, Zarr, Dask), python-image-analysis (scikit-image, TIFF), python-bioinformatics (Biopython).",
        }),
    ),
    waitSeconds: Schema.optional(SetupWaitSeconds),
  }),
  success: Schema.Struct({
    /** The package added for `session`, whose next run finds it. */
    added: Schema.optional(Schema.Struct({ package: Schema.String, session: Schema.String })),
    installed: Schema.Boolean,
    busy: Schema.Boolean,
    runtime: Schema.NullOr(Schema.String),
    toolkits: Schema.Array(Schema.String),
    failure: Schema.NullOr(Schema.String),
  }),
  failure: ScientComputeToolError,
  dependencies,
})
  .annotate(Tool.Title, "Set up Python packages")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true)
  .annotate(ScientOperation, { ...operation("compute.setup"), scope: "thread" });

export const ComputeToolRuntime = Schema.Struct({
  executable: Schema.String,
  version: Schema.NullOr(Schema.String),
  origin: Schema.NullOr(Schema.String),
  problem: Schema.optional(Schema.String),
});
export type ComputeToolRuntime = typeof ComputeToolRuntime.Type;

export const ComputeToolLanguage = Schema.Struct({
  language: Schema.String,
  name: Schema.String,
  /** What Settings shows under the name; empty when nothing is known to be missing. */
  status: Schema.String,
  /** `scient_compute_run`, `scient_compute_run_file`, or `shell` for a tool Compute cannot run. */
  use: Schema.String,
  /** The runtime this project uses by default. */
  default: Schema.NullOr(Schema.String),
  runtimes: Schema.Array(ComputeToolRuntime),
  toolkits: Schema.optional(Schema.Array(Schema.String)),
});
export type ComputeToolLanguage = typeof ComputeToolLanguage.Type;

export const ComputeToolInventory = Schema.Struct({
  languages: Schema.Array(ComputeToolLanguage),
  /** Named by Scient, with nothing found here. */
  notFound: Schema.Array(Schema.String),
  /** Some places could not be read, so `notFound` may be missing something. */
  incomplete: Schema.optional(Schema.Boolean),
});
export type ComputeToolInventory = typeof ComputeToolInventory.Type;

const ScientComputeInventoryTool = Tool.make("scient_compute_inventory", {
  description:
    "List what this computer has for each language: the default runtime, every program found, this project's environments, and how to use each, including tools Scient Compute cannot run yet. Use scient_compute_run_file for saved scripts. Starts nothing.",
  parameters: EmptyToolInput,
  success: ComputeToolInventory,
  failure: ScientComputeToolError,
  dependencies,
})
  .annotate(Tool.Title, "List Scient Compute runtimes")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, {
    ...operation("compute.inventory"),
    // Knowing what is installed needs no permission to run anything.
    requiredCapabilities: [],
    scope: "thread",
  });

const NotebookPath = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(1024)).annotate({
  description: "The .ipynb file, project-relative.",
});
const NotebookCellId = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256)).annotate({
  description: "A cell id from scient_notebook_read.",
});

export const ComputeToolNotebookCell = Schema.Struct({
  cell: Schema.String,
  type: Schema.String,
  source: Schema.String,
  /** What `replace` passes back, so a change made since this read is not overwritten. */
  version: Schema.String,
  /** `never run`, `ran`, `failed`, `running`, `edited since it ran`, or `a cell above changed`. */
  state: Schema.String,
  count: Schema.NullOr(Schema.Number),
  folded: Schema.optional(Schema.Array(Schema.Literals(["source", "outputs", "section"]))),
  parameterRole: Schema.optional(Schema.Literal("scient-injected-parameters")),
  output: Schema.String,
  figures: Schema.Int,
});
export type ComputeToolNotebookCell = typeof ComputeToolNotebookCell.Type;

const NotebookResult = Schema.Struct({
  language: Schema.String,
  /** Cells in the notebook, whether or not all are listed here. */
  total: Schema.Int,
  cells: Schema.Array(ComputeToolNotebookCell),
  outline: Schema.optional(
    Schema.Array(
      Schema.Struct({
        cell: Schema.String,
        line: Schema.Int,
        text: Schema.String,
        level: Schema.Int,
      }),
    ),
  ),
  parameterCell: Schema.optional(Schema.String),
  parameters: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        value: Schema.NullOr(Schema.String),
        saved: Schema.NullOr(Schema.String),
      }),
    ),
  ),
  publication: Schema.optional(ComputeResultsRerunResult),
  freshRun: Schema.optional(Schema.NullOr(NotebookFreshRun)),
  publishedRevision: Schema.optional(Schema.NullOr(Schema.String)),
  alternatives: Schema.optional(
    Schema.Array(
      Schema.Struct({
        revision: Schema.String,
        codeSha256: Schema.optional(Schema.String),
        sourceStatus: Schema.Literals(["current", "earlier", "unconfirmed"]),
        parameters: Schema.Array(ComputeResultParameter),
        outputs: Schema.Array(
          Schema.Struct({
            name: Schema.String,
            rows: Schema.optional(Schema.Array(Schema.Array(Schema.String))),
            partial: Schema.optional(Schema.Boolean),
          }),
        ),
        values: Schema.optional(Schema.Array(ComputeResultValue)),
      }),
    ),
  ),
  omittedAlternatives: Schema.optional(Schema.Int),
  images: Schema.optional(Schema.Array(ComputeToolImage)),
  /** Cells left as they were because someone changed them after the read. */
  refused: Schema.optional(Schema.Array(Schema.String)),
  /** Why the edits are not on disk yet. They are kept, and saving is tried again. */
  saveProblem: Schema.optional(Schema.String),
});

const NotebookEditOperation = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("replace"),
    cell: NotebookCellId,
    source: Schema.String,
    version: Schema.String.annotate({ description: "The cell's version from your last read." }),
  }),
  Schema.Struct({
    op: Schema.Literal("insert"),
    after: Schema.NullOr(NotebookCellId).annotate({ description: "Null inserts at the top." }),
    type: Schema.Literals(["code", "markdown"]),
    source: Schema.String,
  }),
  Schema.Struct({ op: Schema.Literal("delete"), cell: NotebookCellId }),
  Schema.Struct({
    op: Schema.Literal("move"),
    cell: NotebookCellId,
    offset: Schema.Literals([-1, 1]),
  }),
  Schema.Struct({
    op: Schema.Literal("parameters"),
    cell: NotebookCellId,
    enabled: Schema.Boolean,
  }),
  Schema.Struct({
    op: Schema.Literal("fold"),
    cell: NotebookCellId,
    part: Schema.Literals(["source", "outputs", "section"]),
    folded: Schema.Boolean,
  }),
  Schema.Struct({ op: Schema.Literal("clear-outputs") }),
]);

const ScientNotebookReadTool = Tool.make("scient_notebook_read", {
  description:
    "Read a Jupyter notebook as cells. Use this instead of reading the .ipynb file directly. Pass cells for their full source, version, freshness and output. A cell labelled scient-injected-parameters is managed by Scient and records the overrides from the last fresh run. Use includeAlternatives for saved settings or savedRevision for one setting's values, tables and figures, without a kernel. Pass freshRunId or includeFreshRun to check a fresh run.",
  parameters: Schema.Struct({
    path: NotebookPath,
    cells: Schema.optional(Schema.Array(NotebookCellId)),
    includeAlternatives: Schema.optional(Schema.Boolean),
    savedRevision: Schema.optional(Schema.String),
    freshRunId: NotebookFreshRunStatusInput.fields.runId,
    includeFreshRun: Schema.optional(Schema.Boolean),
  }),
  success: NotebookResult,
  failure: ScientComputeToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read a notebook")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, operation("notebook.read"));

const ScientNotebookEditTool = Tool.make("scient_notebook_edit", {
  description:
    "Use this instead of editing the .ipynb file directly. Replace needs cell, source and the version from the last read. Insert needs after, type and source. Delete needs cell. Move needs cell and offset. A stale replace is refused and returns the current source and version. Decide again before retrying. Parameters needs cell and enabled. Fold needs cell, part and folded.",
  parameters: Schema.Struct({
    path: NotebookPath,
    edits: Schema.Array(NotebookEditOperation).check(Schema.isMaxLength(256)),
  }),
  success: NotebookResult,
  failure: ScientComputeToolError,
  dependencies,
})
  .annotate(Tool.Title, "Edit a notebook")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, operation("notebook.edit"));

const AgentNotebookParameters = Schema.Record(ComputeResultParameterValues.key, Schema.Json).check(
  Schema.isMaxProperties(200),
);

const ScientNotebookRunTool = Tool.make("scient_notebook_run", {
  description:
    'Run cells in the notebook session. By default run all code cells in order, stopping at the first failure. Returns each cell\'s output and figures for interactive runs. Set fresh to run the entire saved notebook in a new kernel; it publishes the outputs written to SCIENT_RESULTS_DIR. Pass ordinary JSON overrides such as {"threshold": 0.7, "plot": true}; inputs are project-relative. Omit cells for a fresh run. It continues after waitSeconds and returns a run ID for scient_notebook_read or scient_notebook_stop. Use sweep with one to twenty override objects to save alternatives while keeping the published setting.',
  parameters: Schema.Struct({
    path: NotebookPath,
    cells: Schema.optional(Schema.Array(NotebookCellId)),
    waitSeconds: Schema.optional(WaitSeconds),
    includeImages: Schema.optional(IncludeImages),
    fresh: Schema.optional(Schema.Boolean),
    parameters: Schema.optional(AgentNotebookParameters),
    inputs: ComputeResultsRerunInput.fields.inputs,
    sweep: Schema.optional(
      Schema.Array(AgentNotebookParameters).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
    ),
  }),
  success: NotebookResult,
  failure: ScientComputeToolError,
  dependencies,
})
  .annotate(Tool.Title, "Run notebook cells")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true)
  .annotate(ScientOperation, operation("notebook.run"));

const ScientNotebookStopTool = Tool.make("scient_notebook_stop", {
  description:
    "Stop a fresh notebook run or sweep by its path and run ID. Completed sweep settings stay saved.",
  parameters: Schema.Struct({
    path: NotebookPath,
    runId: NotebookFreshRunStopInput.fields.runId,
  }),
  success: Schema.Struct({
    status: Schema.Literals(["stopped", "saving", "finished"]),
    completedSettings: Schema.Int,
    freshRun: NotebookFreshRun,
  }),
  failure: ScientComputeToolError,
  dependencies,
})
  .annotate(Tool.Title, "Stop a fresh notebook run")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, operation("notebook.stop"));

const ResultPath = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4096));

export const ComputeToolResultSummary = Schema.Struct({
  revision: Schema.String,
  script: Schema.String,
  finishedAt: Schema.String,
  /** `observed` (Python) lists the project files the script was seen reading. */
  inputTracking: Schema.String,
  inputs: Schema.Array(Schema.String),
  declaredInputs: Schema.Array(Schema.String),
  observedDirectories: Schema.optional(Schema.Array(Schema.String)),
  readsOutsideProject: Schema.optional(Schema.Int),
  outsideDataPaths: ComputeResultSummary.fields.outsideDataPaths,
  parameters: Schema.Array(ComputeResultParameter),
  inputCoverageIncomplete: Schema.Boolean,
  kind: ComputeResultSourceKind,
  /** What changed since this revision ran, e.g. `input changed: data/cohort.csv`. Empty if nothing Scient checks has. */
  outOfDate: Schema.Array(Schema.String),
  sourceUnconfirmed: Schema.optional(Schema.Boolean),
  environmentMayDiffer: Schema.optional(Schema.Array(Schema.String)),
});

export const ComputeToolResultValue = Schema.Struct({
  output: Schema.String,
  pointer: Schema.String,
  value: Schema.String,
  /** Paste this into a Markdown manuscript as is. */
  markdown: Schema.String,
});

const ScientResultsRunTool = Tool.make("scient_results_run", {
  description:
    "Run a saved analysis from scratch. Write outputs to SCIENT_RESULTS_DIR (JSON object of numbers or strings, PNG/SVG/PDF figures, CSV tables). Overrides arrive as one JSON object in SCIENT_PARAMETERS and take effect only if the script reads it. Inputs declares the project files it reads.",
  parameters: Schema.Struct({
    path: ResultPath.annotate({
      description: "The script or notebook, relative to the project root.",
    }),
    parameters: Schema.optional(
      Schema.Record(
        Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
        Schema.Union([
          Schema.Number,
          Schema.String,
          Schema.Boolean,
          Schema.Array(Schema.Json),
          Schema.Null,
        ]),
      ).check(Schema.isMaxProperties(200)),
    ).annotate({
      description:
        'Overrides by name as JSON values, such as {"threshold":0.7}. Omit to reuse or pass {} to clear.',
    }),
    inputs: ComputeResultsRerunInput.fields.inputs.annotate({
      description: "Declared project files. Omit to reuse or pass [] to clear.",
    }),
    waitSeconds: Schema.optional(WaitSeconds),
  }),
  success: Schema.Struct({
    status: Schema.Literals(["published", "completed", "failed", "running"]),
    message: Schema.optional(Schema.String),
    notebookSaved: Schema.optional(Schema.Boolean),
    revision: Schema.optional(ComputeToolResultSummary),
    values: Schema.optional(Schema.Array(ComputeToolResultValue)),
    figures: Schema.optional(Schema.Array(Schema.String)),
    tables: Schema.optional(Schema.Array(Schema.String)),
  }),
  failure: ScientComputeToolError,
  dependencies,
})
  .annotate(Tool.Title, "Run a script and publish its results")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true)
  .annotate(ScientOperation, operation("compute.results.run"));

const ScientResultsListTool = Tool.make("scient_results_list", {
  description:
    "List saved linked results, setup, and last failed or stopped attempts. Pass a path for revision history, the latest record, and input suggestions. Pass revision and output to read up to 16 KiB of a saved file.",
  parameters: Schema.Struct({
    path: Schema.optional(ResultPath),
    revision: Schema.optional(ComputeResultRevisionId),
    output: Schema.optional(ResultPath),
    includePackages: Schema.optional(Schema.Boolean).annotate({
      description: "Include the package list for the requested path.",
    }),
  }),
  success: Schema.Struct({
    scripts: Schema.Array(
      Schema.Struct({
        latest: ComputeToolResultSummary,
        revisions: Schema.Int,
        lastAttempt: Schema.NullOr(ComputeResultListedAttempt).annotate({
          description: "Use sessionId and executionId as session and run in scient_compute_output.",
        }),
        values: Schema.Array(ComputeToolResultValue),
        figures: Schema.Array(Schema.String),
        tables: Schema.Array(Schema.String),
      }),
    ),
    history: Schema.optional(ComputeResultsHistoryResult.fields.revisions),
    suggestedInputs: Schema.optional(Schema.Array(ResultPath)),
    latestRecord: Schema.optional(ComputeResultRevision),
    packageCount: Schema.optional(Schema.Int),
    outputContent: Schema.optional(ComputeResultOutputContent),
  }),
  failure: ScientComputeToolError,
  dependencies,
})
  .annotate(Tool.Title, "List linked results")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, operation("compute.results.list"));

const ScientResultsCompareTool = Tool.make("scient_results_compare", {
  description: "Compare the code, setup, environment and outputs of two saved result revisions.",
  parameters: Schema.Struct({
    from: ComputeResultsCompareInput.fields.from,
    to: ComputeResultsCompareInput.fields.to,
  }),
  success: ComputeResultsCompareResult,
  failure: ScientComputeToolError,
  dependencies,
})
  .annotate(Tool.Title, "Compare result revisions")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, operation("compute.results.compare"));

const ScientResultsMarkdownTool = Tool.make("scient_results_markdown", {
  description:
    "Text that cites one result: a value by JSON Pointer, a figure or a CSV table. For a .tex paper Scient writes results/<script>/ files and also returns preamble lines. Insert it with your file tools.",
  parameters: Schema.Struct({
    document: ResultPath.annotate({ description: "The manuscript, relative to the project root." }),
    revision: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
    output: ResultPath.annotate({ description: "The file in the revision, e.g. values.json." }),
    pointer: Schema.optional(
      Schema.String.check(Schema.isMaxLength(4096)).annotate({
        description: "JSON Pointer of a value, e.g. /cohort/n. Omit for a figure.",
      }),
    ),
    alt: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))),
  }),
  success: Schema.Struct({
    markdown: Schema.String,
    preamble: Schema.optional(Schema.Array(Schema.String)),
  }),
  failure: ScientComputeToolError,
  dependencies,
})
  .annotate(Tool.Title, "Markdown for a linked result")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, operation("compute.results.markdown"));

const ScientResultsCheckTool = Tool.make("scient_results_check", {
  description:
    "Check the linked results in a manuscript, or the result files a .tex paper includes: out of date, a newer run, or edited.",
  parameters: Schema.Struct({
    document: ResultPath.annotate({ description: "The manuscript, relative to the project root." }),
  }),
  success: Schema.Struct({
    results: Schema.Array(
      Schema.Struct({
        line: Schema.Int,
        kind: Schema.Literals(["value", "figure", "table", "file"]),
        shown: Schema.String,
        /** current, freshness-partly-unknown, newer-run, out-of-date, edited, missing or no-record. */
        state: Schema.String,
        revision: Schema.String,
        value: Schema.NullOr(Schema.String),
        newerRevision: Schema.NullOr(Schema.String),
        newerValue: Schema.NullOr(Schema.String),
        outOfDate: Schema.Array(Schema.String),
        environmentMayDiffer: Schema.optional(Schema.Array(Schema.String)),
      }),
    ),
  }),
  failure: ScientComputeToolError,
  dependencies,
})
  .annotate(Tool.Title, "Check linked results in a manuscript")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, operation("compute.results.check"));

const ScientDataProfileTool = Tool.make("scient_data_profile", {
  description:
    "Profile a project dataset or DuckDB SQL view. Reports types, missingness, distinct values, ranges or top values, and row coverage. Optionally name columns, a zero-based workbook sheet, or the revision from scient_data_preview_view.",
  parameters: Schema.Struct({
    path: ResultPath,
    columns: Schema.optional(Schema.Array(Schema.NonEmptyString).check(Schema.isMaxLength(32))),
    sheet: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    revision: Schema.optional(DataViewRevision),
  }),
  success: Schema.Struct({ ...DataProfile.fields, cappedColumns: Schema.Boolean }),
  failure: ScientComputeToolError,
  dependencies,
})
  .annotate(Tool.Title, "Profile a dataset or SQL view")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, operation("compute.data.profile"));

const ScientDataPreviewViewTool = Tool.make("scient_data_preview_view", {
  description:
    "Preview up to 50 rows of a saved DuckDB SELECT, with optional search, minimum and sort, and return the view revision. Use scient_data_save_view to save a dataset selection as a view.",
  parameters: Schema.Struct({
    path: ResultPath,
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
    filter: Schema.optional(DataViewFilter),
  }),
  success: Schema.Struct({
    revision: DataViewRevision,
    columns: Schema.Array(DataTableColumn),
    rows: Schema.Array(DataTableRow),
    rowCount: Schema.Int,
    matchCount: Schema.Int,
    columnCount: Schema.Int,
    cappedRows: Schema.Boolean,
    cappedColumns: Schema.Boolean,
  }),
  failure: ScientComputeToolError,
  dependencies,
})
  .annotate(Tool.Title, "Preview a saved SQL view")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, operation("compute.data.previewView"));

const ScientDataSaveViewTool = Tool.make("scient_data_save_view", {
  description:
    "Save a CSV, TSV or Parquet grid selection as a new DuckDB .sql view. Supply project-relative source and destination paths, zero-based column indices, search, optional numeric minimum, and a sort or null. Use an empty search string for no search. A search that cannot be preserved is refused. Refuses an existing destination.",
  parameters: Schema.Struct({
    path: ResultPath,
    destination: ResultPath,
    columns: DataViewSaveInput.fields.columns,
    ...DataViewFilter.fields,
  }),
  success: Schema.Struct({ path: ResultPath }),
  failure: ScientComputeToolError,
  dependencies,
})
  .annotate(Tool.Title, "Save a dataset selection as a SQL view")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, operation("compute.data.saveView"));

const ScientDataMaterializeViewTool = Tool.make("scient_data_materialize_view", {
  description:
    "Export a saved DuckDB SELECT to a new CSV or Parquet file. Pass the same filter and revision from scient_data_preview_view to export the matching rows in the same order. Both paths are relative to the project. Refuses an existing destination.",
  parameters: Schema.Struct({
    path: ResultPath,
    destination: ResultPath,
    revision: Schema.optional(DataViewRevision),
    filter: Schema.optional(DataViewFilter),
  }),
  success: Schema.Struct({ path: ResultPath }),
  failure: ScientComputeToolError,
  dependencies,
})
  .annotate(Tool.Title, "Export a saved SQL view")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, operation("compute.data.materializeView"));

const ScientResultsExportTool = Tool.make("scient_results_export", {
  description:
    "Export a saved result. Pass a revision ID from scient_results_list or a script/notebook path for its newest revision. Use previewOnly to inspect inputs before choosing includeInputs.",
  parameters: Schema.Struct({
    revision: Schema.optional(Schema.Union([ComputeResultRevisionId, Schema.Literal("")])),
    path: Schema.optional(ResultPath),
    destination: Schema.optional(
      ResultPath.annotate({ description: "Existing project folder (default project root)." }),
    ),
    includeInputs: Schema.optional(ResultHandoffExportInput.fields.includeInputs),
    excludeLockfiles: ResultHandoffExportInput.fields.excludeLockfiles,
    previewOnly: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Union([ResultHandoffChoices, ResultHandoffExportResult]),
  failure: ScientComputeToolError,
  dependencies,
})
  .annotate(Tool.Title, "Export a result package")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, operation("compute.results.export"));

const ScientResultsVerifyTool = Tool.make("scient_results_verify", {
  description:
    "Verify a result package inside this project. This runs someone else’s code on the Compute computer. Set allowExecution only when the user agrees. The full report is saved beside the package.",
  parameters: ResultHandoffVerifyInput,
  success: ResultHandoffVerifyResult,
  failure: ScientComputeToolError,
  dependencies,
})
  .annotate(Tool.Title, "Verify a result package")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true)
  .annotate(ScientOperation, operation("compute.results.verify"));

export const ScientComputeToolkit = Toolkit.make(
  ScientComputeRunTool,
  ScientComputeOutputTool,
  ScientComputeRunFileTool,
  ScientComputeSessionsTool,
  ScientComputeVariablesTool,
  ScientComputeControlTool,
  ScientComputeSetupTool,
  ScientComputeInventoryTool,
  ScientNotebookReadTool,
  ScientNotebookEditTool,
  ScientNotebookRunTool,
  ScientNotebookStopTool,
  ScientResultsRunTool,
  ScientResultsListTool,
  ScientResultsCompareTool,
  ScientResultsMarkdownTool,
  ScientResultsCheckTool,
  ScientDataProfileTool,
  ScientDataPreviewViewTool,
  ScientDataSaveViewTool,
  ScientDataMaterializeViewTool,
  ScientResultsExportTool,
  ScientResultsVerifyTool,
);
