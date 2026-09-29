// @effect-diagnostics nodeBuiltinImport:off -- pre-runtime local dev bootstrap.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Electron from "electron";

import {
  processStartToken,
  takeApprovedHandoff,
  writeColdHandoff,
} from "../../../scripts/dev-cold-handoff.mjs";
import type { ReviewedFileIdentity } from "./reviewOpenedConversation.ts";

export interface ApprovedColdFile {
  readonly path: string;
  readonly identity: ReviewedFileIdentity;
  readonly readOnly: false;
}

export function isColdDevelopmentBootstrap(): boolean {
  return process.env.SCIENT_DEV_BOOTSTRAP === "1" && process.env.SCIENT_DEV_COLD_BOOTSTRAP === "1";
}

function bootstrapIdentity() {
  const root = process.env.SCIENT_DEV_BOOTSTRAP_ROOT;
  const stateRoot = process.env.SCIENT_DEV_BOOTSTRAP_STATE_ROOT;
  const role = process.env.SCIENT_DEV_BOOTSTRAP_ROLE;
  if (
    !root ||
    !NodePath.isAbsolute(root) ||
    !stateRoot ||
    !NodePath.isAbsolute(stateRoot) ||
    (role !== "stable" && role !== "candidate")
  ) {
    throw new Error("Development app bootstrap identity is missing.");
  }
  return { root, stateRoot, role: role as "stable" | "candidate" };
}

/** Finder cold launch cannot start the managed stack until local review accepts. */
function yieldColdDevelopmentApp(files: readonly ApprovedColdFile[]): void {
  const { root, stateRoot, role } = bootstrapIdentity();
  const nodePath = process.env.SCIENT_DEV_BOOTSTRAP_NODE;
  if (!nodePath || !NodePath.isAbsolute(nodePath)) {
    throw new Error("Development app bootstrap Node runtime is missing.");
  }
  const coldStart = processStartToken(process.pid);
  if (!coldStart) throw new Error("Could not identify the cold development app process.");
  const receipt = writeColdHandoff({
    stateRoot,
    root,
    role,
    coldPid: process.pid,
    coldStart,
    files: [...files],
  });
  const args = [
    NodePath.join(root, "scripts", "local-dev-app.mjs"),
    "start",
    `--cold-handoff=${receipt.path}`,
  ];
  if (role === "stable") args.push("--stable");
  const result = NodeChildProcess.spawnSync(nodePath, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 45_000,
    env: {
      ...process.env,
      SCIENT_DEV_APP_ROLE: role,
      SCIENT_NEXT_HOME: stateRoot,
    },
  });
  if (result.status !== 0 || result.error) {
    NodeFS.rmSync(receipt.path, { force: true });
    throw new Error(
      `Could not hand the reviewed conversation to the managed dev app: ${
        result.error?.message ?? result.stderr?.trim() ?? "launcher failed"
      }`,
    );
  }
  Electron.app.quit();
}

export function yieldColdDevelopmentAppOrShowError(
  files: readonly ApprovedColdFile[],
  unsupportedReadOnly: boolean,
): void {
  try {
    if (unsupportedReadOnly) {
      throw new Error(
        "Read-only conversation preview is not available from a cold managed development app.",
      );
    }
    yieldColdDevelopmentApp(files);
  } catch (error) {
    Electron.dialog.showErrorBox(
      "Could not open conversation in development",
      error instanceof Error ? error.message : String(error),
    );
    Electron.app.quit();
  }
}

/** Consumed once by the supervised Electron process, before workspace startup. */
function takeSupervisedDevelopmentHandoff(): readonly ApprovedColdFile[] {
  const path = process.env.SCIENT_DEV_APPROVED_HANDOFF_PATH;
  delete process.env.SCIENT_DEV_APPROVED_HANDOFF_PATH;
  if (!path) return [];
  if (
    process.env.SCIENT_DEV_BOOTSTRAP !== "1" ||
    process.env.SCIENT_NEXT_DEV_RUNNER_ACTIVE !== "1"
  ) {
    throw new Error("Approved file handoff requires the supervised dev app.");
  }
  const { root, stateRoot, role } = bootstrapIdentity();
  return takeApprovedHandoff({ path, stateRoot, root, role }) as ApprovedColdFile[];
}

export async function installSupervisedDevelopmentHandoff(
  install: (files: readonly ApprovedColdFile[]) => Promise<void>,
  options: {
    readonly take?: () => readonly ApprovedColdFile[];
    readonly reportFailure?: (message: string) => void;
  } = {},
): Promise<boolean> {
  try {
    const files = (options.take ?? takeSupervisedDevelopmentHandoff)();
    if (files.length > 0) await install(files);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    (
      options.reportFailure ??
      ((detail) => {
        Electron.dialog.showErrorBox("Could not open reviewed conversation", detail);
        Electron.app.quit();
      })
    )(message);
    return false;
  }
}
