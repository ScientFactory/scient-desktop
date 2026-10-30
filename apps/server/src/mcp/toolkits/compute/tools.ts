import { ComputeRuntimeInventory } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import { ScientOperation, type OperationMetadata } from "../../ScientOperationTool.ts";
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
      "capability-unavailable",
      "project-required",
      "project-changed",
      "session-not-found",
      "compute-failed",
    ]),
    message: Schema.Trimmed.check(Schema.isNonEmpty()),
  },
) {}

const SessionId = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128)).annotate({
  description: "A session id from scient_compute_sessions or an earlier run.",
});
const WaitSeconds = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1800 })).annotate({
  description: "How long to wait for the run to finish before returning (default 120).",
});
const IncludeImages = Schema.Boolean.annotate({
  description: "Attach the run's figures as images (default true).",
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
});

const operation = (id: string): OperationMetadata => ({
  id,
  family: "compute",
  scope: "workspace",
  requiredCapabilities: ["compute"],
  approval: "session-grant",
  documentation: "docs/user/scientific-computing.md",
});

const ScientComputeRunTool = Tool.make("scient_compute_run", {
  description:
    "Run code in a Scient Compute session and return its output, errors and figures. Without `session`, the code runs in your own session for this chat and language, started on first use; variables persist between runs. With `session` (from scient_compute_sessions), it runs in that session, such as the user's open file, where the user sees it live. The working directory is the project folder. Long runs keep going after the wait; read them later with scient_compute_output.",
  parameters: Schema.Struct({
    code: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(1024 * 1024)),
    language: Schema.optional(
      Schema.String.check(Schema.isMaxLength(64)).annotate({
        description: "python (default), r, julia, sql or matlab. Ignored with `session`.",
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
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true)
  .annotate(ScientOperation, operation("compute.run"));

const ScientComputeSessionsTool = Tool.make("scient_compute_sessions", {
  description:
    "List the live Scient Compute sessions in this project: the user's file sessions and agent sessions, with their latest runs.",
  parameters: EmptyToolInput,
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
  description:
    "Read a run's output, errors and figures, by default the latest run in the session. Waits for a running run up to `waitSeconds` (default 0).",
  parameters: Schema.Struct({
    session: SessionId,
    run: Schema.optional(Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128))),
    waitSeconds: Schema.optional(WaitSeconds),
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
    "Install Scient-managed Python, a private scientific Python (NumPy, pandas, SciPy, Matplotlib, seaborn, statsmodels, scikit-learn, SymPy, Plotly and more), or add its Toolkits: python-large-data (Arrow/Parquet, HDF5, NetCDF, Zarr, Dask, xarray), python-image-analysis, python-bioinformatics. Use it when a package is missing instead of installing into the user's own Python. The first install takes a few minutes; call again to check progress.",
  parameters: Schema.Struct({
    toolkits: Schema.optional(
      Schema.Array(Schema.String.check(Schema.isMaxLength(64))).check(Schema.isMaxLength(16)),
    ),
    waitSeconds: Schema.optional(WaitSeconds),
  }),
  success: Schema.Struct({
    installed: Schema.Boolean,
    busy: Schema.Boolean,
    runtime: Schema.NullOr(Schema.String),
    toolkits: Schema.Array(Schema.String),
    failure: Schema.NullOr(Schema.String),
  }),
  failure: ScientComputeToolError,
  dependencies,
})
  .annotate(Tool.Title, "Set up Scient-managed Python")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true)
  .annotate(ScientOperation, { ...operation("compute.setup"), scope: "thread" });

const ScientComputeInventoryTool = Tool.make("scient_compute_inventory", {
  description:
    "List the languages and runtimes Scient Compute has configured or found on this server, including Scient-managed Python and its Toolkits.",
  parameters: EmptyToolInput,
  success: ComputeRuntimeInventory,
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
    scope: "thread",
  });

const NotebookPath = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(1024)).annotate({
  description: "The .ipynb file, relative to the project root.",
});
const NotebookCellId = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256)).annotate({
  description: "A cell id from scient_notebook_read.",
});

export const ComputeToolNotebookCell = Schema.Struct({
  cell: Schema.String,
  type: Schema.String,
  source: Schema.String,
  /** `never run`, `ran`, `failed`, `running`, `edited since it ran`, or `a cell above changed`. */
  state: Schema.String,
  count: Schema.NullOr(Schema.Number),
  output: Schema.String,
  figures: Schema.Int,
});
export type ComputeToolNotebookCell = typeof ComputeToolNotebookCell.Type;

const NotebookResult = Schema.Struct({
  language: Schema.String,
  cells: Schema.Array(ComputeToolNotebookCell),
  images: Schema.optional(Schema.Array(ComputeToolImage)),
});

const NotebookEditOperation = Schema.Union([
  Schema.Struct({ op: Schema.Literal("replace"), cell: NotebookCellId, source: Schema.String }),
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
  Schema.Struct({ op: Schema.Literal("clear-outputs") }),
]);

const ScientNotebookReadTool = Tool.make("scient_notebook_read", {
  description:
    "Read a Jupyter notebook as cells: source, whether each cell is current, and its output as text. Use this instead of reading the .ipynb file, which is JSON with embedded figures.",
  parameters: Schema.Struct({
    path: NotebookPath,
    cells: Schema.optional(Schema.Array(NotebookCellId)),
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
    "Change a notebook by cell: replace a cell's source, insert, delete or move cells, or clear outputs. The change shows at once in the notebook the user has open. Use this instead of editing the .ipynb file.",
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

const ScientNotebookRunTool = Tool.make("scient_notebook_run", {
  description:
    "Run notebook cells in the notebook's own session, the one the user sees, and save the results into the file. Runs every code cell by default, in order, and stops at the first failure. Returns each cell's output and figures.",
  parameters: Schema.Struct({
    path: NotebookPath,
    cells: Schema.optional(Schema.Array(NotebookCellId)),
    waitSeconds: Schema.optional(WaitSeconds),
    includeImages: Schema.optional(IncludeImages),
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

export const ScientComputeToolkit = Toolkit.make(
  ScientComputeRunTool,
  ScientComputeOutputTool,
  ScientComputeSessionsTool,
  ScientComputeVariablesTool,
  ScientComputeControlTool,
  ScientComputeSetupTool,
  ScientComputeInventoryTool,
  ScientNotebookReadTool,
  ScientNotebookEditTool,
  ScientNotebookRunTool,
);
