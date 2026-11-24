// @effect-diagnostics-next-line nodeBuiltinImport:off - observes the PowerShell launch the Recycle Bin uses.
import type * as NodeChildProcess from "node:child_process";

import { describe, expect, it, vi } from "vite-plus/test";

import { moveToTrash } from "./WorkspaceTrash.ts";

const launched = vi.hoisted(() => ({ commands: [] as string[] }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>();
  const execFile = (command: string, _args: unknown, _options: unknown, callback: Function) => {
    launched.commands.push(command);
    callback(null, '[{"ok":true}]', "");
    return { stdin: { end: () => {} } };
  };
  return { ...actual, execFile };
});

describe("moveToTrash", () => {
  it("runs Windows PowerShell by its System32 path for the Recycle Bin", async () => {
    launched.commands = [];
    const outcomes = await moveToTrash(
      {
        platform: "win32",
        homeDirectory: String.raw`D:\Users\someone`,
        environment: { SYSTEMROOT: String.raw`D:\Windows`, PATH: String.raw`D:\planted` },
        userId: undefined,
      },
      [String.raw`D:\project\notes.txt`],
    );
    expect(outcomes).toEqual([{ ok: true }]);
    expect(launched.commands).toEqual([
      String.raw`D:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
    ]);
  });
});
