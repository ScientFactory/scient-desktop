import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import {
  EnvironmentId,
  ProjectId,
  type ProjectCloneSnapshot,
  type ProjectReadFileResult,
  type ProjectWriteFileInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

const transport = vi.hoisted(() => ({
  query: vi.fn(),
  command: vi.fn(),
  clonesAtom: vi.fn(),
  silence: vi.fn(),
}));

vi.mock(import("@t3tools/client-runtime/state/runtime"), async (original) => ({
  ...(await original()),
  executeAtomQuery: transport.query as never,
  runAtomCommand: transport.command as never,
}));
vi.mock(import("../state/projectClones"), async (original) => ({
  ...(await original()),
  environmentProjectClonesAtom: transport.clonesAtom as never,
  silenceProjectCloneToasts: transport.silence,
}));

import { appAtomRegistry } from "../rpc/atomRegistry";
import { projectEnvironment } from "../state/projects";
import { sourceControlEnvironment } from "../state/sourceControl";
import {
  addProjectToMachine,
  COPYABLE_FILE_MAX_BYTES,
  dismissProjectFileCopy,
  isDefaultCopiedFile,
  type AddProjectToMachineInput,
} from "./addProjectToMachine";

function readBytes(bytes: Uint8Array, overrides: Partial<ProjectReadFileResult> = {}) {
  return {
    relativePath: ".env",
    contents: new TextDecoder().decode(bytes),
    byteLength: bytes.byteLength,
    truncated: false,
    revision: `sha256:${bytesToHex(sha256(bytes))}`,
    ...overrides,
  } satisfies ProjectReadFileResult;
}

function readText(contents = "SYNTHETIC=value\n", overrides: Partial<ProjectReadFileResult> = {}) {
  return readBytes(new TextEncoder().encode(contents), overrides);
}

function setup(snapshot = readText()) {
  vi.clearAllMocks();
  const input: AddProjectToMachineInput = {
    source: { environmentId: EnvironmentId.make("source"), cwd: "/source/project" },
    subdirectory: "",
    target: { environmentId: EnvironmentId.make("target"), label: "Target" },
    projectId: ProjectId.make("transfer-test"),
    title: "Synthetic project",
    remoteUrl: "https://example.test/repo.git",
    destinationPath: "/target/requested",
    files: [".env"],
  };
  const clones = Atom.make<ReadonlyArray<ProjectCloneSnapshot>>([]);
  transport.clonesAtom.mockReturnValue(clones);
  transport.query.mockReset().mockResolvedValue(AsyncResult.success(snapshot));
  const writes: Array<{ environmentId: EnvironmentId; input: ProjectWriteFileInput }> = [];
  const writeReceipt = Promise.withResolvers<void>();
  transport.command.mockReset().mockImplementation(async (_registry, command, payload) => {
    if (command === sourceControlEnvironment.startProjectClone)
      return AsyncResult.success({ cwd: "/target/actual-clone" });
    if (command !== projectEnvironment.writeFile) throw new Error("Unexpected command");
    writes.push(payload);
    writeReceipt.resolve();
    return AsyncResult.success({ relativePath: payload.input.relativePath, revision: "written" });
  });
  const publishClone = (phase: ProjectCloneSnapshot["phase"]) =>
    appAtomRegistry.set(clones, [
      {
        projectId: input.projectId,
        remoteUrl: input.remoteUrl,
        destinationPath: "/target/actual-clone",
        repository: null,
        phase,
        stage: "checkout",
        percent: phase === "done" ? 100 : 0,
        detail: null,
        error: null,
        startedAt: "2026-10-20T00:00:00.000Z",
        endedAt: phase === "done" ? "2026-10-20T00:00:01.000Z" : null,
        sequence: phase === "done" ? 2 : 1,
      },
    ]);
  return {
    input,
    writes,
    writeReceipt: writeReceipt.promise,
    publishClone,
    removeClone: () => appAtomRegistry.set(clones, []),
    [Symbol.dispose]() {
      // Settle a waiting clone even if an assertion fails.
      publishClone("running");
      appAtomRegistry.set(clones, []);
      dismissProjectFileCopy({
        environmentId: input.target.environmentId,
        projectId: input.projectId,
      });
    },
  };
}

async function expectRefused(input: AddProjectToMachineInput, message: string) {
  await expect(addProjectToMachine(input)).rejects.toThrow(message);
  // Both clone and write use this boundary; neither may run on preflight refusal.
  expect(transport.command).not.toHaveBeenCalled();
  expect(transport.silence).not.toHaveBeenCalled();
}

describe("ignored-file transfer preflight", () => {
  // Ignored files can hold credentials, so none is preselected for a cross-machine copy.
  it("requires explicit selection for every cross-machine file copy", () => {
    expect(
      [".env", "apps/web/.env.local", ".envrc", ".dev.vars", "README.md"].filter(
        isDefaultCopiedFile,
      ),
    ).toEqual([]);
  });

  it.each([
    ["non-NUL Latin-1", new Uint8Array([0x63, 0x61, 0x66, 0xe9])],
    ["incomplete equal-byte-count UTF-8", new Uint8Array([0xf0, 0x90, 0x80])],
    ["UTF-8 BOM stripped by the read decoder", new Uint8Array([0xef, 0xbb, 0xbf, 0x61])],
    ["NUL bytes", new Uint8Array([0x61, 0, 0x62])],
  ] as const)("refuses %s before clone or write", async (_label, bytes) => {
    const snapshot = readBytes(bytes);
    if (bytes[0] === 0xf0)
      expect(new TextEncoder().encode(snapshot.contents).byteLength).toBe(bytes.byteLength);
    using fixture = setup(snapshot);
    await expectRefused(fixture.input, "original bytes");
  });

  it.each([
    ["valid multilingual UTF-8", "שלום café 🧪\r\n"],
    ["a literal replacement character", "valid \uFFFD text"],
    ["an interior BOM character", "before\uFEFFafter"],
    ["an empty file", ""],
    ["exactly 1 MiB", "x".repeat(COPYABLE_FILE_MAX_BYTES)],
  ])("copies %s unchanged only after clone completion", async (_label, contents) => {
    using fixture = setup(readText(contents));
    await addProjectToMachine(fixture.input);
    expect(transport.command).toHaveBeenCalledOnce();
    expect(fixture.writes).toEqual([]);
    fixture.publishClone("done");
    await fixture.writeReceipt;
    expect(fixture.writes).toEqual([
      {
        environmentId: fixture.input.target.environmentId,
        input: {
          cwd: "/target/actual-clone",
          relativePath: ".env",
          contents,
          createOnly: true,
        },
      },
    ]);
    expect(transport.query.mock.calls[0]?.[2]).toMatchObject({ refresh: true });
  });

  it.each([
    ["truncated", { truncated: true }, "Too large"],
    ["over 1 MiB", { byteLength: COPYABLE_FILE_MAX_BYTES + 1 }, "Too large"],
    ["outside-workspace symlink", { outsideWorkspace: true }, "outside"],
    ["disappeared source", { exists: false, revision: "missing" }, "no longer exists"],
    ["changed path", { relativePath: "other.env" }, "path changed"],
    ["short read during a size race", { byteLength: 999 }, "original bytes"],
    ["same-sized changed source revision", { revision: readText("X").revision }, "original bytes"],
    ["unverifiable revision", { revision: "" }, "original bytes"],
  ] satisfies Array<[string, Partial<ProjectReadFileResult>, string]>)(
    "refuses %s before clone or write",
    async (_label, overrides, message) => {
      using fixture = setup(readText(undefined, overrides));
      await expectRefused(fixture.input, message);
    },
  );

  it("refuses a failed read before clone or write", async () => {
    using fixture = setup();
    transport.query.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("Source changed"))));
    await expectRefused(fixture.input, "Source changed");
  });

  it("refuses the entire transfer when one selected file is unsafe", async () => {
    using fixture = setup();
    transport.query
      .mockResolvedValueOnce(AsyncResult.success(readText()))
      .mockResolvedValueOnce(
        AsyncResult.success(readBytes(new Uint8Array([0xe9]), { relativePath: "bad.env" })),
      );
    await expectRefused({ ...fixture.input, files: [".env", "bad.env"] }, "original bytes");
  });

  it("does not trust read-only metadata to establish a lossless encoding", async () => {
    using fixture = setup(readBytes(new Uint8Array([0xe9]), { readOnly: true }));
    await expectRefused(fixture.input, "original bytes");
  });

  it.each([
    "",
    "../secret",
    "/etc/secret",
    "C:/secret",
    "\\\\host\\secret",
    "a/../b",
    "./a",
    "a//b",
    "a/",
    "a\0b",
  ])("refuses unsafe selected path %j before reading", async (path) => {
    using fixture = setup();
    await expectRefused({ ...fixture.input, files: [path] }, "inside");
    expect(transport.query).not.toHaveBeenCalled();
  });

  it.each(["../other", "/absolute", "C:\\other", "a/../other"])(
    "refuses unsafe repository subdirectory %j before reading",
    async (subdirectory) => {
      using fixture = setup();
      await expectRefused({ ...fixture.input, subdirectory }, "inside");
      expect(transport.query).not.toHaveBeenCalled();
    },
  );

  it("refuses a destination path exceeding the write contract before reading", async () => {
    using fixture = setup();
    await expectRefused({ ...fixture.input, subdirectory: "x".repeat(510) }, "inside");
    expect(transport.query).not.toHaveBeenCalled();
  });

  it("copies when clone completion arrives before the start reply", async () => {
    using fixture = setup();
    fixture.publishClone("done");
    await addProjectToMachine(fixture.input);
    await fixture.writeReceipt;
    expect(fixture.writes).toHaveLength(1);
  });

  it("keeps the verified source snapshot and repository prefix while the clone runs", async () => {
    const snapshot = readText("original");
    using fixture = setup(snapshot);
    const files = [".env"];
    const input = { ...fixture.input, files, subdirectory: "apps/web" };
    await addProjectToMachine(input);
    snapshot.contents = "changed after read";
    files[0] = "../elsewhere";
    input.subdirectory = "../elsewhere";
    fixture.publishClone("done");
    await fixture.writeReceipt;
    expect(fixture.writes[0]?.input).toMatchObject({
      relativePath: "apps/web/.env",
      contents: "original",
      createOnly: true,
    });
  });

  it("does not copy into a removed clone", async () => {
    using fixture = setup();
    await addProjectToMachine(fixture.input);
    fixture.publishClone("running");
    fixture.removeClone();
    expect(fixture.writes).toEqual([]);
    expect(transport.command).toHaveBeenCalledOnce();
  });

  it("can clone with no ignored files selected", async () => {
    using fixture = setup();
    await addProjectToMachine({ ...fixture.input, files: [] });
    expect(transport.query).not.toHaveBeenCalled();
    expect(transport.command).toHaveBeenCalledOnce();
  });
});
