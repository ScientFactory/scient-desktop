import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";

const IMMUTABLE_ACTION_REF = /@[0-9a-f]{40}$/;
const IMMUTABLE_CONTAINER_REF = /^docker:\/\/.+@sha256:[0-9a-f]{64}$/i;

export interface WorkflowActionFile {
  readonly path: string;
  readonly contents: string;
}

export interface WorkflowActionViolation {
  readonly path: string;
  readonly message: string;
}

interface ActionUse {
  readonly reference: string;
  readonly localRoot: ".github/actions" | ".github/workflows";
}

export function findWorkflowActionViolations(
  files: readonly WorkflowActionFile[],
): WorkflowActionViolation[] {
  const violations: WorkflowActionViolation[] = [];
  for (const file of files) {
    let document: unknown;
    try {
      document = parse(file.contents);
    } catch (error) {
      violations.push({ path: file.path, message: `YAML is invalid: ${String(error)}` });
      continue;
    }
    for (const { reference: use, localRoot } of actionUses(document)) {
      if (use.startsWith("./")) {
        if (isScannedLocalReference(use, localRoot)) continue;
        violations.push({
          path: file.path,
          message: `local reference must live under the recursively scanned ${localRoot} directory: ${use}`,
        });
        continue;
      }
      if (use.toLowerCase().startsWith("docker://")) {
        if (IMMUTABLE_CONTAINER_REF.test(use)) continue;
        violations.push({
          path: file.path,
          message: `container action is not pinned to a sha256 digest: ${use}`,
        });
        continue;
      }
      if (IMMUTABLE_ACTION_REF.test(use)) continue;
      violations.push({
        path: file.path,
        message: `external action is not pinned to a full commit SHA: ${use}`,
      });
    }
  }
  return violations;
}

function isScannedLocalReference(use: string, localRoot: ActionUse["localRoot"]): boolean {
  const prefix = `./${localRoot}/`;
  if (!use.startsWith(prefix)) return false;
  const segments = use.slice(prefix.length).split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function actionUses(document: unknown): ActionUse[] {
  if (!isRecord(document)) return [];
  const result: ActionUse[] = [];
  if (isRecord(document.jobs)) {
    for (const job of Object.values(document.jobs)) {
      if (!isRecord(job)) continue;
      if (typeof job.uses === "string") {
        result.push({ reference: job.uses, localRoot: ".github/workflows" });
      }
      result.push(...stepUses(job.steps));
    }
  }
  if (isRecord(document.runs)) {
    result.push(...stepUses(document.runs.steps));
    if (
      typeof document.runs.using === "string" &&
      document.runs.using.toLowerCase() === "docker" &&
      typeof document.runs.image === "string" &&
      document.runs.image.toLowerCase().startsWith("docker://")
    ) {
      result.push({ reference: document.runs.image, localRoot: ".github/actions" });
    }
  }
  return result;
}

function stepUses(steps: unknown): ActionUse[] {
  if (!Array.isArray(steps)) return [];
  return steps.flatMap((step) =>
    isRecord(step) && typeof step.uses === "string"
      ? [{ reference: step.uses, localRoot: ".github/actions" as const }]
      : [],
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function yamlFiles(root: string): WorkflowActionFile[] {
  const result: WorkflowActionFile[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`Symbolic links are not allowed in scanned workflow trees: ${absolute}`);
    if (entry.isDirectory()) {
      result.push(...yamlFiles(absolute));
      continue;
    }
    if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue;
    result.push({
      path: absolute.replaceAll(path.sep, "/"),
      contents: readFileSync(absolute, "utf8"),
    });
  }
  return result;
}

function main(): void {
  const violations = findWorkflowActionViolations(yamlFiles(".github"));
  if (!violations.length) {
    console.log("Immutable GitHub Actions check passed.");
    return;
  }
  for (const violation of violations) console.error(`${violation.path}: ${violation.message}`);
  process.exitCode = 1;
}

if (import.meta.main) main();
