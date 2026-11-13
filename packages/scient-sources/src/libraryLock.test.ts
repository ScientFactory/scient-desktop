// @effect-diagnostics nodeBuiltinImport:off -- The lock is tested against a real second process.
// @effect-diagnostics globalTimers:off -- The holder process waits on a plain timer.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { afterEach, describe, expect, it } from "@effect/vitest";

import { ScientLibraryBusyError, withScientLibraryLock } from "./libraryLock.ts";

const fixtures: string[] = [];
const children: NodeChildProcess.ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

/** Another Node process that takes the lock through the same module and then never lets go. */
async function holdInAnotherProcess(root: string): Promise<NodeChildProcess.ChildProcess> {
  const lockModule = NodeURL.pathToFileURL(NodePath.join(import.meta.dirname, "libraryLock.ts"));
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { withScientLibraryLock } from ${JSON.stringify(lockModule.href)};
       await withScientLibraryLock(${JSON.stringify(root)}, async () => {
         process.stdout.write("held\\n");
         await new Promise((resolve) => setTimeout(resolve, 120_000));
       });`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.once("exit", (code) => reject(new Error(`The holder exited early (${code}).`)));
    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("held")) resolve();
    });
  });
  return child;
}

describe("withScientLibraryLock", () => {
  it("keeps a second process out and recovers once the holder is killed", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-library-lock-"));
    fixtures.push(root);
    const holder = await holdInAnotherProcess(root);

    await expect(
      withScientLibraryLock(root, async () => "mine", { timeoutMs: 200 }),
    ).rejects.toBeInstanceOf(ScientLibraryBusyError);

    const waiting = withScientLibraryLock(root, async () => "mine", { timeoutMs: 20_000 });
    const exited = new Promise((resolve) => holder.once("exit", resolve));
    holder.kill("SIGKILL");
    await exited;
    await expect(waiting).resolves.toBe("mine");
    expect(await NodeFSP.readdir(root)).toEqual(["library.lock"]);
  });

  it("lets a holder's own nested writes in and runs this process's writers one at a time", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-library-lock-"));
    fixtures.push(root);
    let holders = 0;
    let most = 0;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const write = () =>
      withScientLibraryLock(root, async () => {
        most = Math.max(most, ++holders);
        await withScientLibraryLock(root, async () => undefined);
        await gate;
        holders -= 1;
      });
    const writes = [write(), write(), write()];
    // A few filesystem round trips let the other writers reach the lock while the first holds it.
    for (let turn = 0; turn < 5; turn += 1) await NodeFSP.readdir(root);
    open();
    await Promise.all(writes);
    expect(most).toBe(1);
  });
});
