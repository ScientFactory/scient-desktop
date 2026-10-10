// @effect-diagnostics nodeBuiltinImport:off -- Synthetic files exercise publication during an interrupted write.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { writeAcpReplayStatus } from "./acpReplayStatus.ts";

vi.mock("node:fs", { spy: true });

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  const actual = await vi.importActual<typeof NodeFS>("node:fs");
  for (const directory of directories.splice(0)) actual.rmSync(directory, { recursive: true });
});

it("keeps the previous complete status readable while publishing the next snapshot", async () => {
  const actual = await vi.importActual<typeof NodeFS>("node:fs");
  const directory = actual.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "acp-replay-status-"));
  directories.push(directory);
  const statusPath = NodePath.join(directory, "status.json");
  const previous = { cursor: 1, total: 2 };
  actual.writeFileSync(statusPath, JSON.stringify(previous));
  vi.spyOn(NodeFS, "writeFileSync").mockImplementationOnce((file, contents) => {
    actual.writeFileSync(file, "{");
    expect(JSON.parse(actual.readFileSync(statusPath, "utf8"))).toEqual(previous);
    actual.writeFileSync(file, contents);
  });

  writeAcpReplayStatus(statusPath, JSON.stringify({ cursor: 2, total: 2 }));

  expect(JSON.parse(actual.readFileSync(statusPath, "utf8"))).toEqual({ cursor: 2, total: 2 });
});

it("preserves the previous status when the next write fails", async () => {
  const actual = await vi.importActual<typeof NodeFS>("node:fs");
  const directory = actual.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), "acp-replay-status-failure-"),
  );
  directories.push(directory);
  const statusPath = NodePath.join(directory, "status.json");
  const previous = { cursor: 1, total: 2 };
  actual.writeFileSync(statusPath, JSON.stringify(previous));
  vi.spyOn(NodeFS, "writeFileSync").mockImplementationOnce((file) => {
    actual.writeFileSync(file, "{");
    throw new Error("synthetic write failure");
  });

  expect(() => writeAcpReplayStatus(statusPath, '{"cursor":2,"total":2}')).toThrow(
    "synthetic write failure",
  );
  expect(JSON.parse(actual.readFileSync(statusPath, "utf8"))).toEqual(previous);
});
