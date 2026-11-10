import type { ScientLatexBuildFailureClass } from "@t3tools/contracts";
import type { FailureOwner } from "@scientfactory/analytics";

/**
 * Who a failure belongs to, decided where the typed failure is still in hand. Only these closed
 * values leave the computer: never code, messages, paths or error names.
 */
export interface FailureAttribution {
  readonly failureOwner: FailureOwner;
  readonly failureCategory: string;
}

const PYTHON_ERRORS: Readonly<Record<string, string>> = {
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

const OWNER_OF_CATEGORY: Readonly<Record<string, FailureOwner>> = {
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

export type ComputeRunFailureFacts =
  | { readonly kind: "runtime-reported"; readonly errorName: string | undefined }
  | { readonly kind: "not-admitted" }
  | { readonly kind: "lost"; readonly reason: "server-restart" | "transport-failed" | "exited" }
  | { readonly kind: "runtime-start" };

export function computeRunAttribution(
  facts: ComputeRunFailureFacts,
  managedRuntime: boolean,
): FailureAttribution {
  switch (facts.kind) {
    case "runtime-reported":
      return runtimeErrorAttribution(facts.errorName, managedRuntime);
    case "not-admitted":
      return { failureOwner: "scient", failureCategory: "dispatch" };
    case "runtime-start":
      return {
        failureOwner: managedRuntime ? "scient" : "environment",
        failureCategory: "runtime-start",
      };
    case "lost":
      return facts.reason === "server-restart"
        ? { failureOwner: "scient", failureCategory: "app-restart" }
        : facts.reason === "transport-failed"
          ? { failureOwner: "scient", failureCategory: "runtime-connection" }
          : // A crashing extension, exhausted memory or Scient's bridge all end the process.
            { failureOwner: "unknown", failureCategory: "runtime-exited" };
  }
}

/**
 * A one-shot program run. A nonzero exit is the program's own result; an exit of 0 that still
 * failed (batch Stata reports errors that way) or a run that never started stays unknown.
 */
export function programRunAttribution(
  status: "failed" | "lost",
  exitCode: number | null,
): FailureAttribution {
  if (status === "lost") return { failureOwner: "unknown", failureCategory: "runtime-exited" };
  if (exitCode === null) return { failureOwner: "unknown", failureCategory: "not-started" };
  return exitCode === 0
    ? { failureOwner: "unknown", failureCategory: "failed-after-exit" }
    : { failureOwner: "code", failureCategory: "nonzero-exit" };
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

const CAPTURE_OWNERS: Readonly<Record<string, FailureOwner>> = {
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
export function captureRejectionAttribution(reason: string | undefined): FailureAttribution {
  return reason === undefined
    ? { failureOwner: "unknown", failureCategory: "unknown" }
    : { failureOwner: CAPTURE_OWNERS[reason] ?? "unknown", failureCategory: reason };
}

const TOOL_CANCELLED = /(^|_)(interrupt|interrupted|cancel|cancelled|canceled|aborted)($|_)/u;
const TOOL_INPUT =
  /(^|_)(invalid|validation|bad_request|not_found|unknown_session|session_not_found|selector|missing_argument|unsupported|conflict|stale)($|_)/u;
const TOOL_ENVIRONMENT =
  /(^|_)(permission|denied|forbidden|not_installed|missing_runtime|unauthorized|auth)($|_)/u;
const TOOL_EXTERNAL = /(^|_)(network|http|fetch|dns|offline|remote|upstream|page)($|_)/u;
const TOOL_SCIENT =
  /(^|_)(exception|internal|defect|persistence|no_host|unavailable|storage)($|_)/u;

/**
 * A Scient tool call's error code. A caller passing a bad selector or session is the caller's
 * input, not a Scient failure; a timeout stays unknown because the page or Scient can cause it.
 */
export function toolFailureAttribution(errorCode: string | undefined): FailureAttribution {
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
  return { failureOwner: owner, failureCategory: code };
}
