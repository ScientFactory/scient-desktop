import type { ScientLatexBuildFailureClass } from "@t3tools/contracts";
import type { FailureCategory, FailureOwner } from "@scientfactory/analytics";
import type { ComputeCaptureReason } from "../scient/compute/ComputeCaptureStatus.ts";

/**
 * Who a failure belongs to, decided where the typed failure is still in hand. Only these closed
 * values leave the computer: never code, messages, paths or error names.
 */
export interface FailureAttribution {
  readonly failureOwner: FailureOwner;
  readonly failureCategory: FailureCategory;
}

const PYTHON_ERRORS: Readonly<Record<string, FailureCategory>> = {
  ModuleNotFoundError: "missing-dependency",
  ImportError: "missing-dependency",
  MemoryError: "out-of-memory",
  RecursionError: "code-error",
  SyntaxError: "syntax",
  IndentationError: "syntax",
  TabError: "syntax",
  NameError: "code-error",
  UnboundLocalError: "code-error",
  TypeError: "code-error",
  ValueError: "code-error",
  KeyError: "code-error",
  IndexError: "code-error",
  AttributeError: "code-error",
  ZeroDivisionError: "code-error",
  ArithmeticError: "code-error",
  OverflowError: "code-error",
  FloatingPointError: "code-error",
  AssertionError: "assertion",
  NotImplementedError: "code-error",
  RuntimeError: "code-error",
  StopIteration: "code-error",
  LookupError: "code-error",
  UnicodeDecodeError: "data",
  UnicodeEncodeError: "data",
  UnicodeError: "data",
  EOFError: "data",
  FileNotFoundError: "filesystem",
  IsADirectoryError: "filesystem",
  NotADirectoryError: "filesystem",
  FileExistsError: "filesystem",
  PermissionError: "permission",
  OSError: "filesystem",
  IOError: "filesystem",
  TimeoutError: "network",
  ConnectionError: "network",
  ConnectionRefusedError: "network",
  ConnectionResetError: "network",
  ConnectionAbortedError: "network",
  BrokenPipeError: "network",
  KeyboardInterrupt: "interrupted",
  SystemExit: "exited",
  Exception: "code-error",
  // Common library failures whose names say what kind of problem they are.
  HTTPError: "network",
  URLError: "network",
  ParserError: "data",
  EmptyDataError: "data",
  LinAlgError: "code-error",
  ValidationError: "data",
};

const OWNER_OF_CATEGORY: Partial<Record<FailureCategory, FailureOwner>> = {
  "missing-dependency": "environment",
  "out-of-memory": "environment",
  permission: "environment",
  network: "external",
  interrupted: "code",
  exited: "code",
};

/** A runtime-reported error: the executed code failed, unless its name says otherwise. */
function runtimeErrorAttribution(
  errorName: string | undefined,
  managedRuntime = false,
): FailureAttribution {
  if (errorName === undefined) return { failureOwner: "code", failureCategory: "runtime-reported" };
  const name = errorName.split(".").at(-1) ?? errorName;
  const category = PYTHON_ERRORS[name] ?? "code-error";
  // Scient-managed Python promises its Toolkits, so a missing module there may be ours.
  const owner =
    category === "missing-dependency" && managedRuntime
      ? "unknown"
      : (OWNER_OF_CATEGORY[category] ?? "code");
  return { failureOwner: owner, failureCategory: category };
}

/** Why a compute runtime was lost, from Scient's own fixed loss reasons. */
export type ComputeLossReason =
  | "server-restart"
  | "transport-failed"
  | "admission-timeout"
  | "persistence-failed"
  | "kernel-exited"
  | "kernel-connection"
  | "protocol-error"
  | "missing-capability"
  | "exited";

export type ComputeRunFailureFacts =
  | { readonly kind: "runtime-reported"; readonly errorName: string | undefined }
  | { readonly kind: "not-admitted" }
  | { readonly kind: "lost"; readonly reason: ComputeLossReason }
  | { readonly kind: "runtime-start" };

/** The fixed starts of the bridge's own fatal reasons (scient_compute_bridge.py `_fail_fatal`). */
export const COMPUTE_BRIDGE_LOSS_PREFIXES: ReadonlyArray<readonly [string, ComputeLossReason]> = [
  ["The kernel process exited", "kernel-exited"],
  ["Kernel communication failed", "kernel-connection"],
  ["Protocol error:", "protocol-error"],
  ["Missing capabilities:", "missing-capability"],
];

/** Scient's bridge refuses a run whose source changed under it; no native code ran. */
const SOURCE_CONFLICT_ERROR = "Scient:SourceConflict";

const LOSS_ATTRIBUTION: Readonly<Record<ComputeLossReason, FailureAttribution>> = {
  "server-restart": { failureOwner: "scient", failureCategory: "app-restart" },
  "transport-failed": { failureOwner: "scient", failureCategory: "runtime-connection" },
  "admission-timeout": { failureOwner: "scient", failureCategory: "admission-timeout" },
  "persistence-failed": { failureOwner: "scient", failureCategory: "persistence-failed" },
  "protocol-error": { failureOwner: "scient", failureCategory: "protocol-error" },
  "missing-capability": { failureOwner: "scient", failureCategory: "missing-capability" },
  // A crashing extension, exhausted memory or a kernel bug all end the kernel.
  "kernel-exited": { failureOwner: "unknown", failureCategory: "kernel-exited" },
  "kernel-connection": { failureOwner: "unknown", failureCategory: "kernel-connection" },
  exited: { failureOwner: "unknown", failureCategory: "runtime-exited" },
};

export function computeRunAttribution(
  facts: ComputeRunFailureFacts,
  managedRuntime: boolean,
): FailureAttribution {
  switch (facts.kind) {
    case "runtime-reported":
      return facts.errorName === SOURCE_CONFLICT_ERROR
        ? { failureOwner: "input", failureCategory: "source-conflict" }
        : runtimeErrorAttribution(facts.errorName, managedRuntime);
    case "not-admitted":
      return { failureOwner: "scient", failureCategory: "dispatch" };
    case "runtime-start":
      return {
        failureOwner: managedRuntime ? "scient" : "environment",
        failureCategory: "runtime-start",
      };
    case "lost":
      return LOSS_ATTRIBUTION[facts.reason];
  }
}

/**
 * A one-shot program run. A nonzero exit is the program's own result; an exit of 0 that still
 * failed (batch Stata reports errors that way) or a run that never started stays unknown.
 */
export function programRunAttribution(
  status: "failed" | "lost",
  exitCode: number | null,
  notStarted?: "source-changed" | "runtime-missing",
): FailureAttribution {
  if (status === "lost") return { failureOwner: "unknown", failureCategory: "runtime-exited" };
  // The file changed before it ran, or its runtime is not installed.
  if (notStarted === "source-changed")
    return { failureOwner: "input", failureCategory: "source-changed" };
  if (notStarted === "runtime-missing")
    return { failureOwner: "environment", failureCategory: "runtime-missing" };
  if (exitCode === null) return { failureOwner: "unknown", failureCategory: "not-started" };
  return exitCode === 0
    ? { failureOwner: "unknown", failureCategory: "failed-after-exit" }
    : { failureOwner: "code", failureCategory: "nonzero-exit" };
}

const PDF_EXPORT_OWNERS = {
  "project-required": "input",
  "project-changed": "input",
  "invalid-source-path": "input",
  "invalid-output-path": "input",
  "unsupported-format": "input",
  "source-not-found": "input",
  "source-changed": "input",
  "too-large": "input",
  // Scient's own renderer and publication.
  "renderer-unavailable": "scient",
  "publication-failed": "scient",
  "partial-publication": "scient",
  "output-write-failed": "environment",
  "render-failed": "unknown",
} as const satisfies Partial<Record<FailureCategory, FailureOwner>>;

/** A PDF export's typed error code, when it is one of the closed export codes. */
export function pdfExportAttribution(code: unknown): FailureAttribution | undefined {
  return typeof code === "string" && Object.hasOwn(PDF_EXPORT_OWNERS, code)
    ? {
        failureOwner: PDF_EXPORT_OWNERS[code as keyof typeof PDF_EXPORT_OWNERS],
        failureCategory: code as keyof typeof PDF_EXPORT_OWNERS,
      }
    : undefined;
}

const LATEX_OWNERS: Readonly<Record<ScientLatexBuildFailureClass, FailureOwner>> = {
  compile_error: "code",
  missing_package: "environment",
  missing_engine: "environment",
  no_output: "code",
  timeout: "unknown",
  sources_changed: "code",
  publish: "scient",
  workspace: "scient",
  internal: "scient",
};

export function latexBuildAttribution(
  failureClass: ScientLatexBuildFailureClass | undefined,
): FailureAttribution {
  return failureClass === undefined
    ? { failureOwner: "unknown", failureCategory: "unknown" }
    : { failureOwner: LATEX_OWNERS[failureClass], failureCategory: failureClass };
}

const CAPTURE_OWNERS: Readonly<Record<ComputeCaptureReason, FailureOwner>> = {
  "scan-timeout": "scient",
  "scan-entry-limit": "scient",
  "scan-depth-limit": "scient",
  "scan-unreadable": "environment",
  "watch-unavailable": "scient",
  "watch-overflow": "environment",
  "watch-unverifiable": "environment",
  "observation-unavailable": "scient",
  "output-limit": "scient",
  "image-limit": "scient",
  "unsafe-image": "code",
  "invalid-image": "code",
  "image-changed": "code",
  "missing-resource": "scient",
  "resource-mismatch": "scient",
  "persistence-failed": "scient",
  "artifact-collection-failed": "scient",
};

/** A rejected figure or table: Scient's limits and storage, or a file the code made. */
export function captureRejectionAttribution(
  reason: ComputeCaptureReason | undefined,
): FailureAttribution {
  return reason === undefined
    ? { failureOwner: "unknown", failureCategory: "unknown" }
    : { failureOwner: CAPTURE_OWNERS[reason], failureCategory: reason };
}

const TOOL_CANCELLED = /(^|_)(interrupt|interrupted|cancel|cancelled|canceled|aborted)($|_)/u;
const TOOL_INPUT =
  /(^|_)(invalid|validation|bad_request|not_found|unknown_session|session_not_found|selector|missing_argument|unsupported|conflict|stale|name_taken)($|_)/u;
const TOOL_ENVIRONMENT =
  /(^|_)(permission|denied|forbidden|not_installed|missing_runtime|unauthorized|auth)($|_)/u;
const TOOL_EXTERNAL =
  /(^|_)(network|http|fetch|dns|offline|remote|upstream|unreachable|page)($|_)/u;
const TOOL_SCIENT =
  /(^|_)(exception|internal|defect|persistence|no_host|unavailable|storage)($|_)/u;

/**
 * A Scient tool call's error code. A caller passing a bad selector or session is the caller's
 * input, not a Scient failure; a timeout stays unknown because the page or Scient can cause it.
 */
export function toolFailureAttribution(errorCode: string | undefined): {
  readonly failureOwner: FailureOwner;
} {
  const code = errorCode ?? "unknown";
  const owner: FailureOwner = TOOL_CANCELLED.test(code)
    ? "cancelled"
    : TOOL_INPUT.test(code)
      ? "input"
      : TOOL_ENVIRONMENT.test(code)
        ? "environment"
        : TOOL_EXTERNAL.test(code)
          ? "external"
          : TOOL_SCIENT.test(code)
            ? "scient"
            : "unknown";
  return { failureOwner: owner };
}
