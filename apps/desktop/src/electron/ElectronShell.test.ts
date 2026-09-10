import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { beforeEach, vi } from "vite-plus/test";

const { createFromBufferMock, imageIsEmptyMock, openExternalMock, writeMock, writeTextMock } =
  vi.hoisted(() => ({
    createFromBufferMock: vi.fn(),
    imageIsEmptyMock: vi.fn(),
    openExternalMock: vi.fn(),
    writeMock: vi.fn(),
    writeTextMock: vi.fn(),
  }));

vi.mock("electron", () => ({
  ClipboardItem: class {
    readonly data: Record<string, Blob>;
    constructor(data: Record<string, Blob>) {
      this.data = data;
    }
  },
  shell: {
    openExternal: openExternalMock,
  },
  nativeImage: {
    createFromBuffer: createFromBufferMock,
  },
  clipboard: {
    write: writeMock,
    writeText: writeTextMock,
  },
}));

import * as ElectronShell from "./ElectronShell.ts";

describe("ElectronShell", () => {
  beforeEach(() => {
    createFromBufferMock.mockReset();
    imageIsEmptyMock.mockReset();
    openExternalMock.mockReset();
    writeMock.mockReset();
    writeMock.mockResolvedValue(undefined);
    writeTextMock.mockReset();
    imageIsEmptyMock.mockReturnValue(false);
    createFromBufferMock.mockReturnValue({
      isEmpty: imageIsEmptyMock,
      toPNG: () => Buffer.from([137, 80, 78, 71]),
    });
  });

  it.effect("opens safe external URLs", () =>
    Effect.gen(function* () {
      openExternalMock.mockResolvedValue(undefined);

      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.openExternal("https://example.com/path");

      assert.equal(result, true);
      assert.deepEqual(openExternalMock.mock.calls, [["https://example.com/path"]]);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("copies text to the system clipboard", () =>
    Effect.gen(function* () {
      writeTextMock.mockResolvedValue(undefined);

      const electronShell = yield* ElectronShell.ElectronShell;
      yield* electronShell.copyText("https://example.com/path");

      assert.deepEqual(writeTextMock.mock.calls, [["https://example.com/path"]]);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("does not fail when the clipboard write rejects", () =>
    Effect.gen(function* () {
      writeTextMock.mockRejectedValue(new Error("write failed"));

      const electronShell = yield* ElectronShell.ElectronShell;
      yield* electronShell.copyText("https://example.com/path");

      assert.deepEqual(writeTextMock.mock.calls, [["https://example.com/path"]]);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("opens the Full Disk Access settings anchor", () =>
    Effect.gen(function* () {
      openExternalMock.mockResolvedValue(undefined);

      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.openSystemSettings("full-disk-access");

      assert.equal(result, true);
      assert.deepEqual(openExternalMock.mock.calls, [
        ["x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles"],
      ]);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("opens remote SSH editor URLs", () =>
    Effect.gen(function* () {
      openExternalMock.mockResolvedValue(undefined);

      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.openExternal(
        "vscode://vscode-remote/ssh-remote+example.com/home/user/project",
      );

      assert.equal(result, true);
      assert.deepEqual(openExternalMock.mock.calls, [
        ["vscode://vscode-remote/ssh-remote+example.com/home/user/project"],
      ]);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("does not open remote editor URLs with userinfo", () =>
    Effect.gen(function* () {
      openExternalMock.mockResolvedValue(undefined);

      const electronShell = yield* ElectronShell.ElectronShell;
      const results = yield* Effect.all([
        electronShell.openExternal(
          "vscode://user@vscode-remote/ssh-remote+example.com/home/user/project",
        ),
        electronShell.openExternal(
          "vscode://:secret@vscode-remote/ssh-remote+example.com/home/user/project",
        ),
      ]);

      assert.deepEqual(results, [false, false]);
      assert.equal(openExternalMock.mock.calls.length, 0);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("does not open unsafe external URLs", () =>
    Effect.gen(function* () {
      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.openExternal("file:///etc/passwd");

      assert.equal(result, false);
      assert.equal(openExternalMock.mock.calls.length, 0);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("does not open non-remote editor URLs", () =>
    Effect.gen(function* () {
      openExternalMock.mockResolvedValue(undefined);

      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.openExternal(
        "vscode://ms-python.python/some-command?argument=attacker",
      );

      assert.equal(result, false);
      assert.equal(openExternalMock.mock.calls.length, 0);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("returns false when Electron rejects openExternal", () =>
    Effect.gen(function* () {
      openExternalMock.mockRejectedValue(new Error("open failed"));

      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.openExternal("https://example.com/path");

      assert.equal(result, false);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("copies decoded PNG bytes through Electron's native clipboard", () =>
    Effect.gen(function* () {
      const png = new Uint8Array([137, 80, 78, 71]);
      const electronShell = yield* ElectronShell.ElectronShell;

      assert.isTrue(yield* electronShell.copyPng(png));

      assert.deepEqual([...createFromBufferMock.mock.calls[0]![0]], [...png]);
      assert.equal(writeMock.mock.calls.length, 1);
      const blob = writeMock.mock.calls[0]![0][0].data["image/png"] as Blob;
      assert.equal(blob.type, "image/png");
      const copied = yield* Effect.promise(() => blob.arrayBuffer());
      assert.deepEqual([...new Uint8Array(copied)], [...png]);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("reports a rejected image clipboard write without failing the caller", () =>
    Effect.gen(function* () {
      writeMock.mockRejectedValue(new Error("clipboard unavailable"));
      const shell = yield* ElectronShell.ElectronShell;
      assert.isFalse(yield* shell.copyPng(new Uint8Array([137, 80, 78, 71])));
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("does not write an image Electron cannot decode", () =>
    Effect.gen(function* () {
      imageIsEmptyMock.mockReturnValue(true);
      const electronShell = yield* ElectronShell.ElectronShell;

      assert.isFalse(yield* electronShell.copyPng(new Uint8Array([1, 2, 3])));
      assert.equal(writeMock.mock.calls.length, 0);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );
});
