// @effect-diagnostics nodeBuiltinImport:off -- the attempt journal shares the on-disk result store.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  ComputeExecutionId,
  ComputeProjectId,
  ComputeResultLastAttempt,
  ComputeResultParameter,
  ComputeSessionId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { computeResultsStagingFolder } from "../compute/LocalComputeStore.ts";
import type { ResultsLayout } from "./resultRevisions.ts";

const RunIdentity = Schema.Struct({
  projectId: ComputeProjectId,
  sessionId: ComputeSessionId,
  executionId: ComputeExecutionId,
  scriptPath: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
});
type RunIdentity = typeof RunIdentity.Type;

const AttemptReceipt = Schema.Struct({
  ...RunIdentity.fields,
  ...ComputeResultLastAttempt.fields,
  /** Startup failures have only session output. */
  hasExecution: Schema.Boolean,
  parameters: Schema.optional(Schema.Array(ComputeResultParameter).check(Schema.isMaxLength(200))),
});

export type ResultAttemptReceipt = typeof AttemptReceipt.Type;

const decodeIdentity = Schema.decodeUnknownSync(RunIdentity);
const decodeReceipt = Schema.decodeUnknownSync(AttemptReceipt);

const key = (...parts: ReadonlyArray<string>) =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex");

const pendingFolder = (layout: ResultsLayout) =>
  NodePath.join(layout.computeDir, "results-pending");

const attemptFile = (
  layout: ResultsLayout,
  run: { readonly projectId: string; readonly sessionId: string; readonly executionId: string },
) =>
  NodePath.join(
    pendingFolder(layout),
    `${key(run.projectId, run.sessionId, run.executionId)}.json`,
  );

const failuresFolder = (layout: ResultsLayout, projectId: string, scriptPath: string) =>
  NodePath.join(layout.computeDir, "results", projectId, "attempts", key(scriptPath));

async function writeJson(path: string, content: unknown) {
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
  const temporary = `${path}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    await NodeFSP.writeFile(temporary, JSON.stringify(content), { mode: 0o600, flush: true });
    await NodeFSP.rename(temporary, path);
  } finally {
    await NodeFSP.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export function beginResultAttempt(layout: ResultsLayout, run: RunIdentity) {
  return writeJson(attemptFile(layout, run), run);
}

export async function isResultAttemptPending(
  layout: ResultsLayout,
  projectId: string,
  run: Omit<RunIdentity, "projectId">,
) {
  try {
    const saved = decodeIdentity(
      JSON.parse(await NodeFSP.readFile(attemptFile(layout, { ...run, projectId }), "utf8")),
    );
    return saved.scriptPath === run.scriptPath;
  } catch {
    return false;
  }
}

export async function forgetResultAttempt(layout: ResultsLayout, run: RunIdentity) {
  const staging = computeResultsStagingFolder(
    layout.computeDir,
    run.projectId,
    run.sessionId,
    run.executionId,
  );
  if (staging !== null) {
    await NodeFSP.rm(staging, { recursive: true, force: true });
    await NodeFSP.rm(`${staging}.json`, { force: true });
  }
  await NodeFSP.rm(attemptFile(layout, run), { force: true });
}

export async function recordFailedResultAttempt(
  layout: ResultsLayout,
  run: RunIdentity,
  failure: Omit<ResultAttemptReceipt, keyof RunIdentity>,
) {
  const folder = failuresFolder(layout, run.projectId, run.scriptPath);
  const name = `${failure.finishedAt.replace(/[^0-9]/gu, "")}-${key(run.sessionId, run.executionId)}.json`;
  await writeJson(NodePath.join(folder, name), { ...run, ...failure });
  await forgetResultAttempt(layout, run);
  // Concurrent writers only remove receipts that finished earlier than theirs.
  const names = await NodeFSP.readdir(folder).catch(() => []);
  await Promise.all(
    names
      .filter((candidate) => candidate.endsWith(".json") && candidate < name)
      .map((older) =>
        NodeFSP.rm(NodePath.join(folder, older), { force: true }).catch(() => undefined),
      ),
  );
}

export async function readLastResultAttempt(
  layout: ResultsLayout,
  projectId: string,
  scriptPath: string,
  latestFinishedAt: string | undefined,
) {
  const folder = failuresFolder(layout, projectId, scriptPath);
  const names = await NodeFSP.readdir(folder).catch(() => []);
  for (const name of names
    .filter((name) => name.endsWith(".json"))
    .toSorted()
    .reverse()) {
    try {
      const receipt = decodeReceipt(
        JSON.parse(await NodeFSP.readFile(NodePath.join(folder, name), "utf8")),
      );
      if (receipt.finishedAt <= (latestFinishedAt ?? "")) return null;
      return receipt;
    } catch {
      // A concurrent failure may have replaced this receipt.
    }
  }
  return null;
}

export async function recoverResultAttempts(
  layout: ResultsLayout,
  finishedAt: string,
  published: (run: RunIdentity) => Promise<boolean>,
) {
  const folder = pendingFolder(layout);
  const projects = new Set<string>();
  for (const entry of await NodeFSP.readdir(folder).catch(() => [])) {
    const file = NodePath.join(folder, entry);
    if (entry.endsWith(".tmp")) {
      await NodeFSP.rm(file, { force: true });
      continue;
    }
    if (!entry.endsWith(".json")) continue;
    const text = await NodeFSP.readFile(file, "utf8").catch(() => null);
    if (text === null) continue;
    let run: RunIdentity;
    try {
      run = decodeIdentity(JSON.parse(text));
    } catch {
      continue;
    }
    if (
      attemptFile(layout, run) !== file ||
      computeResultsStagingFolder(
        layout.computeDir,
        run.projectId,
        run.sessionId,
        run.executionId,
      ) === null
    )
      continue;
    projects.add(run.projectId);
    if (await published(run)) {
      await forgetResultAttempt(layout, run);
    } else {
      await recordFailedResultAttempt(layout, run, {
        status: "cancelled",
        finishedAt,
        message: "Scient restarted before this run's results were saved.",
        hasExecution: true,
      });
    }
  }
  for (const projectId of projects) {
    const revisions = NodePath.join(layout.computeDir, "results", projectId, "revisions");
    for (const entry of await NodeFSP.readdir(revisions).catch(() => [])) {
      if (/^\.r[0-9a-z]{12}$/u.test(entry))
        await NodeFSP.rm(NodePath.join(revisions, entry), { recursive: true, force: true });
    }
  }
}
