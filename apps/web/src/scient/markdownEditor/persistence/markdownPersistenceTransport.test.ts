import { ConnectionTransientError } from "@t3tools/client-runtime/connection";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { EnvironmentId, ProjectWriteFileError } from "@t3tools/contracts";
import { MarkdownPersistenceCoordinator } from "@scientfactory/scient-markdown";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { RpcClientError } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  project: vi.fn(),
  confirm: vi.fn(),
  registry: { subscribe: vi.fn() },
  write: Symbol("write"),
  read: Symbol("ordered-read"),
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({ runAtomCommand: mocks.run }));
vi.mock("~/components/files/projectFilesQueryState", () => ({
  confirmProjectFileQueryData: mocks.confirm,
  setProjectFileQueryData: mocks.project,
}));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: mocks.registry }));
vi.mock("~/state/projects", () => ({
  projectEnvironment: {
    writeFile: mocks.write,
    readFileOrdered: mocks.read,
    fileChanges: vi.fn(),
  },
}));
vi.mock("~/connection/catalog", () => ({ environmentCatalog: { stateAtom: vi.fn() } }));

import {
  classifyMarkdownPersistenceFailure,
  createMarkdownPersistenceTransport,
} from "./markdownPersistenceTransport";
import { MarkdownReadSnapshotError } from "./markdownReadSnapshot";

const target = {
  environmentId: EnvironmentId.make("synthetic-env"),
  cwd: "/synthetic",
  relativePath: "file.md",
};
const conflict = new ProjectWriteFileError({
  cwd: target.cwd,
  relativePath: target.relativePath,
  failure: "revision_conflict",
  currentRevision: "newer",
});
const transient = new ConnectionTransientError({ reason: "transport", detail: "Disconnected" });

describe("Markdown persistence transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("preserves the entire raw cause for write and ordered-read failure", async () => {
    const cause = Cause.combine(Cause.fail(transient), Cause.die(new Error("protocol failure")));
    mocks.run.mockResolvedValue(AsyncResult.failure(cause));
    const transport = createMarkdownPersistenceTransport(target);
    await expect(
      transport.write({ source: "B", expectedRevision: "rA", editVersion: 1 }),
    ).rejects.toBe(cause);
    await expect(transport.read()).rejects.toBe(cause);
    expect(mocks.run.mock.calls.map((call) => call[1])).toEqual([mocks.write, mocks.read]);
    expect(classifyMarkdownPersistenceFailure(cause)).toBe("terminal");
  });

  it("never confirms decoded-equal text whose raw bytes differ from the requested save", async () => {
    const malformedBytes = Uint8Array.from([0xff]);
    mocks.run
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(conflict)))
      .mockResolvedValueOnce(
        AsyncResult.success({
          relativePath: target.relativePath,
          contents: "�",
          revision: `sha256:${bytesToHex(sha256(malformedBytes))}`,
          byteLength: 1,
          truncated: false,
        }),
      );
    const transport = createMarkdownPersistenceTransport(target);
    const coordinator = new MarkdownPersistenceCoordinator({
      source: "Before",
      revision: "rBefore",
      write: transport.write,
      read: transport.read,
      classifyFailure: transport.classifyFailure,
    });
    coordinator.change("�");

    expect(await coordinator.flushNow()).toBe(false);
    expect(coordinator.getSnapshot()).toMatchObject({
      baselineSource: "Before",
      draftSource: "�",
      pending: true,
      conflict: null,
    });
    expect(coordinator.getSnapshot().error).toBeInstanceOf(MarkdownReadSnapshotError);
    expect(classifyMarkdownPersistenceFailure(coordinator.getSnapshot().error)).toBe("terminal");
  });

  it("restores a proven decoder-stripped BOM before an ordered snapshot becomes document truth", async () => {
    const source = "\uFEFF# שלום\r\n";
    const bytes = new TextEncoder().encode(source);
    const revision = `sha256:${bytesToHex(sha256(bytes))}`;
    mocks.run.mockResolvedValueOnce(
      AsyncResult.success({
        relativePath: target.relativePath,
        contents: source.slice(1),
        revision,
        byteLength: bytes.byteLength,
        truncated: false,
      }),
    );
    const transport = createMarkdownPersistenceTransport(target);
    expect(await transport.read()).toMatchObject({ source, revision });
  });

  it("classifies typed conflicts and transport interruptions without error-message heuristics", () => {
    expect(classifyMarkdownPersistenceFailure(Cause.fail(conflict))).toBe("conflict");
    expect(classifyMarkdownPersistenceFailure(Cause.interrupt())).toBe("transient");
    expect(classifyMarkdownPersistenceFailure(Cause.fail(transient))).toBe("transient");
    expect(
      classifyMarkdownPersistenceFailure(Cause.combine(Cause.fail(transient), Cause.interrupt())),
    ).toBe("transient");
    expect(
      classifyMarkdownPersistenceFailure(new Error("revision_conflict disconnected network")),
    ).toBe("terminal");
    expect(
      classifyMarkdownPersistenceFailure(Cause.combine(Cause.fail(conflict), Cause.interrupt())),
    ).toBe("terminal");
  });

  it("retries socket RPC failures, not decoding defects or authorization failures", () => {
    const socket = new RpcClientError.RpcClientError({
      reason: new Socket.SocketCloseError({ code: 1006, closeReason: "lost" }),
    });
    const defect = new RpcClientError.RpcClientError({
      reason: new RpcClientError.RpcClientDefect({
        message: "Invalid protocol",
        cause: "bad payload",
      }),
    });
    expect(classifyMarkdownPersistenceFailure(Cause.fail(socket))).toBe("transient");
    expect(classifyMarkdownPersistenceFailure(Cause.fail(defect))).toBe("terminal");
    const policy = new ProjectWriteFileError({
      cwd: target.cwd,
      relativePath: target.relativePath,
      failure: "read_only_in_files",
    });
    expect(classifyMarkdownPersistenceFailure(Cause.fail(policy))).toBe("terminal");
    const operation = new ProjectWriteFileError({
      cwd: target.cwd,
      relativePath: target.relativePath,
      failure: "operation_failed",
    });
    expect(classifyMarkdownPersistenceFailure(Cause.fail(operation))).toBe("operation");
  });

  it("reconfirms the cache after undo returns to the same baseline revision without writing", () => {
    const transport = createMarkdownPersistenceTransport(target);
    const coordinator = new MarkdownPersistenceCoordinator({
      source: "A",
      revision: "rA",
      write: transport.write,
      read: transport.read,
      classifyFailure: transport.classifyFailure,
    });
    transport.project(coordinator.getSnapshot());
    coordinator.change("B", 0);
    transport.project(coordinator.getSnapshot());
    coordinator.change("A", 1);
    transport.project(coordinator.getSnapshot());
    expect(mocks.confirm).toHaveBeenCalledTimes(2);
    expect(mocks.confirm).toHaveBeenLastCalledWith(
      target.environmentId,
      target.cwd,
      target.relativePath,
      "A",
      "rA",
    );
    expect(mocks.run).not.toHaveBeenCalled();
    expect(coordinator.dispose()).toBe(true);
  });
});
