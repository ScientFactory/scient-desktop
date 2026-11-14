// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import { expect, it, vi } from "vite-plus/test";

import { makePosixProcessTreeController } from "./AcpSessionRuntime.ts";

const proc = vi.hoisted(() => ({ readdir: vi.fn(), readFile: vi.fn() }));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFS>()),
  readdirSync: proc.readdir,
  readFileSync: proc.readFile,
}));

it("snapshots surviving processes without requesting Dirent fallback stats from procfs", () => {
  proc.readdir.mockImplementation((_path, options) => {
    if (options?.withFileTypes)
      throw Object.assign(new Error("vanished /proc/200"), { code: "ENOENT" });
    return ["100", "200", "self"];
  });
  proc.readFile.mockImplementation((path) => {
    if (path !== "/proc/100/stat") throw Object.assign(new Error("vanished"), { code: "ENOENT" });
    return "100 (agent) S 1 100 100 " + Array(15).fill("0").join(" ") + " 99";
  });
  const snapshot = makePosixProcessTreeController("linux").snapshot();
  expect(snapshot).toMatchObject([{ pid: 100, startTime: "99" }]);
  expect(proc.readdir).toHaveBeenCalledWith("/proc");
  expect(proc.readFile).toHaveBeenCalledWith("/proc/200/stat", "utf8");
});
