// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";
import { fileMutationFixture } from "../scient/workspace/fileExchange.testkit.ts";
import {
  bytesRevision,
  directoryIdentity,
  durableJson,
  fileIdentity,
  mutateRetainedFile,
  readRetainedRecord,
} from "../scient/workspace/RetainedFileMutation.ts";
import { WorkspaceFileSystemOperationError } from "./WorkspaceFileSystem.ts";
const revision = (text: string) => bytesRevision(Buffer.from(text));
const deferred = () => Promise.withResolvers<void>();
describe("native workspace publication admission", () => {
  it.live.skipIf(process.platform !== "darwin")(
    "saves changed bytes, preserves permissions, and replays the receipt without overwriting outside edits",
    () =>
      fileMutationFixture(async (h) => {
        const target = NodePath.join(h.cwd, "main.tex");
        await NodeFSP.writeFile(target, "A", { mode: 0o640 });
        const identity = await fileIdentity(target);
        const input = {
          cwd: h.cwd,
          relativePath: "main.tex",
          contents: "C",
          expectedRevision: revision("A"),
          mutationId: "save",
        };
        const saved = await h.run(h.methods.writeFile(input));
        expect(saved).toMatchObject({ relativePath: "main.tex", revision: revision("C") });
        expect(await fileIdentity(target)).not.toEqual(identity);
        expect(await NodeFSP.readFile(target, "utf8")).toBe("C");
        expect((await NodeFSP.stat(target)).mode & 0o777).toBe(0o640);
        const history = await h.run(
          h.methods.listFileVersions({ cwd: h.cwd, relativePath: "main.tex" }),
        );
        expect(history.versions.length).toBeGreaterThan(0);
        await NodeFSP.writeFile(target, "outside D");
        const restarted = await h.restart();
        expect(await h.run(restarted.writeFile(input))).toEqual(saved);
        expect(await NodeFSP.readFile(target, "utf8")).toBe("outside D");
        await expect(
          h.run(restarted.writeFile({ ...input, mutationId: "stale" })),
        ).rejects.toMatchObject({
          _tag: "WorkspaceFileRevisionConflictError",
          publicationOutcome: "unchanged",
        });
        expect(await NodeFSP.readFile(target, "utf8")).toBe("outside D");
      }),
  );
  if (process.platform === "darwin") {
    it.live.each([false, true])(
      "retains post-check B during guarded removal, replacement=%s",
      (replace) => {
        let target = "",
          outside = "";
        return fileMutationFixture(
          async (h) => {
            target = NodePath.join(h.cwd, "main.tex");
            outside = NodePath.join(h.root, "writer");
            await NodeFSP.writeFile(target, "A");
            await expect(
              h.run(
                h.methods.deleteFile({
                  cwd: h.cwd,
                  relativePath: "main.tex",
                  expectedRevision: revision("A"),
                  mutationId: "remove",
                }),
              ),
            ).rejects.toMatchObject({
              _tag: "WorkspaceFileRecoveryRequiredError",
              recoveryId: "remove",
              publicationOutcome: "retained-attention",
            });
            expect(await NodeFSP.readFile(target, "utf8")).toBe("B");
            const history = await h.run(
              h.methods.listFileVersions({ cwd: h.cwd, relativePath: "main.tex" }),
            );
            expect(
              await Promise.all(
                history.versions.map((v) => NodeFSP.readFile(v.retainedPath, "utf8")),
              ),
            ).toEqual(expect.arrayContaining(["B"]));
          },
          {
            at: async (point) => {
              if (point !== "checked") return;
              if (replace) {
                await NodeFSP.writeFile(outside, "B");
                await NodeFSP.rename(outside, target);
              } else await NodeFSP.writeFile(target, "B");
            },
          },
        );
      },
    );
    it.live(
      "uses captured rename objects and never overwrites a newly occupied destination",
      () => {
        let destination = "";
        return fileMutationFixture(
          async (h) => {
            const target = NodePath.join(h.cwd, "old.tex");
            destination = NodePath.join(h.cwd, "new.tex");
            await NodeFSP.writeFile(target, "A", { mode: 0o640 });
            await expect(
              h.run(
                h.methods.renameFile({
                  cwd: h.cwd,
                  relativePath: "old.tex",
                  destinationRelativePath: "new.tex",
                  expectedRevision: revision("A"),
                  mutationId: "rename",
                }),
              ),
            ).rejects.toMatchObject({
              _tag: "WorkspaceFileRecoveryRequiredError",
              recoveryId: "rename",
              publicationOutcome: "retained-attention",
            });
            expect(await NodeFSP.readFile(target, "utf8")).toBe("A");
            expect(await NodeFSP.readFile(destination, "utf8")).toBe("outside destination");
            expect((await NodeFSP.stat(target)).mode & 0o777).toBe(0o640);
          },
          {
            at: async (point) => {
              if (point === "install-intent")
                await NodeFSP.writeFile(destination, "outside destination");
            },
          },
        );
      },
    );
    it.live("keeps an occupied rename destination as an immutable unchanged refusal", () =>
      fileMutationFixture(async (h) => {
        const source = NodePath.join(h.cwd, "old.tex"),
          destination = NodePath.join(h.cwd, "new.tex");
        await NodeFSP.writeFile(source, "A");
        await NodeFSP.writeFile(destination, "D");
        const sourceIdentity = await fileIdentity(source),
          destinationIdentity = await fileIdentity(destination);
        const input = {
          cwd: h.cwd,
          relativePath: "old.tex",
          destinationRelativePath: "new.tex",
          expectedRevision: revision("A"),
          mutationId: "occupied-rename",
        };
        await expect(h.run(h.methods.renameFile(input))).rejects.toMatchObject({
          _tag: "WorkspaceFileExistsError",
          publicationOutcome: "unchanged",
        });
        expect(await fileIdentity(source)).toEqual(sourceIdentity);
        expect(await fileIdentity(destination)).toEqual(destinationIdentity);
        await NodeFSP.unlink(destination);
        const methods = await h.restart();
        await expect(h.run(methods.renameFile(input))).rejects.toMatchObject({
          _tag: "WorkspaceFileExistsError",
          publicationOutcome: "unchanged",
        });
        expect(await fileIdentity(source)).toEqual(sourceIdentity);
        expect(await NodeFSP.readFile(source, "utf8")).toBe("A");
        await expect(NodeFSP.lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
      }),
    );
    it.live("creates nested binary objects and moves their actual inode without a text guard", () =>
      fileMutationFixture(async (h) => {
        const bytes = Buffer.from([0, 1, 2, 255]);
        await h.run(
          h.methods.createBinaryFile({
            cwd: h.cwd,
            relativePath: "assets/nested/figure.pdf",
            bytes,
            mutationId: "binary",
          }),
        );
        const identity = await fileIdentity(NodePath.join(h.cwd, "assets/nested/figure.pdf"));
        await h.run(
          h.methods.renameFile({
            cwd: h.cwd,
            relativePath: "assets/nested/figure.pdf",
            destinationRelativePath: "figures/figure.pdf",
            mutationId: "move",
            removeEmptyFolders: true,
          }),
        );
        expect(await fileIdentity(NodePath.join(h.cwd, "figures/figure.pdf"))).toEqual(identity);
        expect(await NodeFSP.readFile(NodePath.join(h.cwd, "figures/figure.pdf"))).toEqual(bytes);
        await expect(NodeFSP.lstat(NodePath.join(h.cwd, "assets"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }),
    );
    it.live.each(["file", "workspace"] as const)(
      "permits an external parent alias through a settled %s read",
      (kind) =>
        fileMutationFixture(async (h) => {
          const outside = NodePath.join(h.root, "external");
          await NodeFSP.mkdir(outside);
          await NodeFSP.writeFile(NodePath.join(outside, "main.tex"), "outside manuscript");
          await NodeFSP.symlink(outside, NodePath.join(h.cwd, "alias"));
          const read = (_attention: unknown, settlement: { readonly currentMissing: boolean }) =>
            Effect.promise(async () => {
              expect(settlement.currentMissing).toBe(false);
              return NodeFSP.readFile(NodePath.join(h.cwd, "alias/main.tex"), "utf8");
            });
          const effect =
            kind === "file"
              ? h.methods.withSettledFileRead({ cwd: h.cwd, relativePath: "alias/main.tex" }, read)
              : h.methods.withSettledWorkspaceRead(
                  { cwd: h.cwd, relativePath: "alias/main.tex" },
                  read,
                );
          expect(await h.run(effect)).toBe("outside manuscript");
          await expect(NodeFSP.lstat(h.retentionRoot)).rejects.toMatchObject({ code: "ENOENT" });
        }),
    );
    it.live.each(["file", "workspace"] as const)(
      "rejects external alias rebinding before a %s read returns",
      (kind) =>
        fileMutationFixture(async (h) => {
          const first = NodePath.join(h.root, "external-one"),
            second = NodePath.join(h.root, "external-two"),
            alias = NodePath.join(h.cwd, "alias");
          await NodeFSP.mkdir(first);
          await NodeFSP.mkdir(second);
          await NodeFSP.writeFile(NodePath.join(first, "main.tex"), "first");
          await NodeFSP.writeFile(NodePath.join(second, "main.tex"), "second");
          await NodeFSP.symlink(first, alias);
          const read = () =>
            Effect.promise(async () => {
              const contents = await NodeFSP.readFile(NodePath.join(alias, "main.tex"), "utf8");
              await NodeFSP.unlink(alias);
              await NodeFSP.symlink(second, alias);
              return contents;
            });
          const effect =
            kind === "file"
              ? h.methods.withSettledFileRead({ cwd: h.cwd, relativePath: "alias/main.tex" }, read)
              : h.methods.withSettledWorkspaceRead(
                  { cwd: h.cwd, relativePath: "alias/main.tex" },
                  read,
                );
          await expect(h.run(effect)).rejects.toMatchObject({
            _tag: "WorkspaceFileTargetChangedError",
            publicationOutcome: "unchanged",
          });
          expect(await NodeFSP.readFile(NodePath.join(alias, "main.tex"), "utf8")).toBe("second");
        }),
    );
    it.live("replays an original creation receipt after D while refusing changed intent", () =>
      fileMutationFixture(async (h) => {
        const input = {
          cwd: h.cwd,
          relativePath: "main.tex",
          contents: "C",
          createOnly: true as const,
          mutationId: "create",
        };
        const first = await h.run(h.methods.writeFile(input));
        await NodeFSP.writeFile(NodePath.join(h.cwd, "main.tex"), "D");
        const methods = await h.restart();
        expect(await h.run(methods.writeFile(input))).toEqual(first);
        expect(await NodeFSP.readFile(NodePath.join(h.cwd, "main.tex"), "utf8")).toBe("D");
        await expect(
          h.run(methods.writeFile({ ...input, relativePath: "other.tex" })),
        ).rejects.toMatchObject({ _tag: "WorkspaceFileMutationIntentConflictError" });
        await expect(NodeFSP.lstat(NodePath.join(h.cwd, "other.tex"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }),
    );
    it.live.each([false, true])(
      "keeps a completed older linked create readable with a held writer, historical device=%s",
      (historicalDevice) =>
        fileMutationFixture(async (h) => {
          const relativePath = "untitled.tex",
            target = NodePath.join(h.cwd, relativePath);
          await NodeFSP.writeFile(NodePath.join(h.cwd, "main.tex"), "unrelated manuscript");
          await h.run(
            h.methods.writeFile({
              cwd: h.cwd,
              relativePath,
              contents: "C",
              createOnly: true,
              mutationId: "older-create",
            }),
          );
          const parent = await directoryIdentity(h.cwd),
            storage = NodePath.join(h.retentionRoot, `${parent.dev}-${parent.ino}`);
          const directory = NodePath.join(storage, (await NodeFSP.readdir(storage))[0]!);
          const record = await readRetainedRecord(directory);
          if (record.version !== 2 || !record.binding || !record.stagedIdentity)
            throw new Error("Missing native create receipt.");
          const slot = NodePath.join(directory, "slot"),
            journal = NodePath.join(directory, "record.json");
          // Reproduce the older helper's successful hard-link publication, including a still-open stage writer.
          await NodeFSP.unlink(target);
          await NodeFSP.link(slot, target);
          const identity = historicalDevice
            ? { ...record.stagedIdentity, dev: "previous-mount-device" }
            : record.stagedIdentity;
          await durableJson(journal, {
            ...record,
            publishedIdentity: identity,
            stagedIdentity: identity,
            binding: historicalDevice
              ? {
                  ...record.binding,
                  rootIdentity: { ...record.binding.rootIdentity, dev: "previous-mount-device" },
                  parentIdentity: {
                    ...record.binding.parentIdentity,
                    dev: "previous-mount-device",
                  },
                  recordIdentity: {
                    ...record.binding.recordIdentity,
                    dev: "previous-mount-device",
                  },
                }
              : record.binding,
          });
          const originalJournal = await NodeFSP.readFile(journal),
            writer = await NodeFSP.open(slot, "r+");
          try {
            const methods = await h.restart(),
              epoch = await h.run(methods.getMutationEpoch({ cwd: h.cwd }));
            expect((await h.settledRead("main.tex")).contents).toBe("unrelated manuscript");
            const read = await h.settledRead(relativePath);
            expect(read.contents).toBe("C");
            expect(read.publicationAttention).toBeUndefined();
            await h.run(
              methods.withWorkspacePublicationFence(
                { cwd: h.cwd, expectedEpoch: epoch },
                () => Effect.void,
              ),
            );
            await writer.write("D", 0, "utf8");
            await writer.sync();
            await expect(
              h.run(
                methods.writeFile({
                  cwd: h.cwd,
                  relativePath,
                  contents: "E",
                  expectedRevision: revision("C"),
                  mutationId: "stale-save",
                }),
              ),
            ).rejects.toMatchObject({ _tag: "WorkspaceFileRevisionConflictError" });
            expect(await NodeFSP.readFile(target, "utf8")).toBe("D");
            await h.run(
              methods.writeFile({
                cwd: h.cwd,
                relativePath,
                contents: "E",
                expectedRevision: revision("D"),
                mutationId: "fresh-save",
              }),
            );
            await writer.write("F", 0, "utf8");
            await writer.sync();
            expect(await NodeFSP.readFile(target, "utf8")).toBe("E");
            expect(await NodeFSP.readFile(slot, "utf8")).toBe("F");
            expect(await NodeFSP.readFile(journal)).toEqual(originalJournal);
            expect(await h.run(methods.getMutationEpoch({ cwd: h.cwd }))).not.toBe(epoch);
          } finally {
            await writer.close();
          }
        }),
    );
    it.live(
      "keeps modern create writers private and does not clear an ambiguous older create",
      () =>
        fileMutationFixture(async (h) => {
          const target = NodePath.join(h.cwd, "main.tex");
          await h.run(
            h.methods.writeFile({
              cwd: h.cwd,
              relativePath: "main.tex",
              contents: "C",
              createOnly: true,
              mutationId: "create",
            }),
          );
          const parent = await directoryIdentity(h.cwd),
            storage = NodePath.join(h.retentionRoot, `${parent.dev}-${parent.ino}`);
          const directory = NodePath.join(storage, (await NodeFSP.readdir(storage))[0]!);
          const record = await readRetainedRecord(directory);
          if (record.version !== 2) throw new Error("Missing native create receipt.");
          expect(record.publishedIdentity).not.toEqual(record.stagedIdentity);
          const epoch = await h.run(h.methods.getMutationEpoch({ cwd: h.cwd }));
          await NodeFSP.writeFile(NodePath.join(directory, "slot"), "private late D");
          expect(await NodeFSP.readFile(target, "utf8")).toBe("C");
          expect(await h.run(h.methods.getMutationEpoch({ cwd: h.cwd }))).toBe(epoch);
          await durableJson(NodePath.join(directory, "record.json"), {
            ...record,
            publishedIdentity: record.stagedIdentity,
            outcome: "attention",
            failure: "recovery",
          });
          const methods = await h.restart();
          await expect(h.run(methods.getMutationEpoch({ cwd: h.cwd }))).rejects.toMatchObject({
            _tag: "WorkspaceFileRecoveryRequiredError",
          });
          expect((await h.settledRead("main.tex")).publicationAttention?.recoveryId).toBe("create");
          expect(await NodeFSP.readFile(target, "utf8")).toBe("C");
          expect(await NodeFSP.readFile(NodePath.join(directory, "slot"), "utf8")).toBe(
            "private late D",
          );
        }),
    );
    it.live("keeps read and version queries from provisioning private storage", () =>
      fileMutationFixture(async (h) => {
        await NodeFSP.writeFile(NodePath.join(h.cwd, "main.tex"), "A");
        expect((await h.settledRead("main.tex")).contents).toBe("A");
        expect(
          (await h.run(h.methods.listFileVersions({ cwd: h.cwd, relativePath: "main.tex" })))
            .versions,
        ).toEqual([]);
        await expect(NodeFSP.lstat(h.retentionRoot)).rejects.toMatchObject({ code: "ENOENT" });
      }),
    );
    it.live("binds a large binary clone to whole bytes, root epoch and the original receipt", () =>
      fileMutationFixture(async (h) => {
        await NodeFSP.mkdir(NodePath.join(h.cwd, "exports"));
        await NodeFSP.writeFile(NodePath.join(h.cwd, "source.tex"), "source A");
        const epoch = await h.run(h.methods.getMutationEpoch({ cwd: h.cwd }));
        const bytes = Buffer.alloc(2 * 1024 * 1024 + 3, 0x31);
        bytes[bytes.length - 1] = 0;
        const input = {
          cwd: h.cwd,
          relativePath: "exports/report.pdf",
          bytes,
          mutationId: "pdf",
          expectedMutationEpoch: epoch,
        };
        const first = await h.run(h.methods.writeBinaryFile(input));
        expect(first.revision).toBe(bytesRevision(bytes));
        expect(await NodeFSP.readFile(NodePath.join(h.cwd, input.relativePath))).toEqual(bytes);
        if (first.publicationEpoch === undefined)
          throw new Error("The guarded PDF receipt lost its publication epoch.");
        expect(first.publicationEpoch).not.toBe(epoch);
        expect(await h.run(h.methods.getMutationEpoch({ cwd: h.cwd }))).toBe(
          first.publicationEpoch,
        );
        const unchanged = await h.run(
          h.methods.writeBinaryFile({
            ...input,
            mutationId: "pdf-noop",
            expectedMutationEpoch: first.publicationEpoch,
          }),
        );
        expect(unchanged.publicationEpoch).toBe(first.publicationEpoch);
        await h.run(
          h.methods.renameFile({
            cwd: h.cwd,
            relativePath: "source.tex",
            destinationRelativePath: "parked.tex",
            expectedRevision: revision("source A"),
            mutationId: "source-away",
          }),
        );
        await h.run(
          h.methods.renameFile({
            cwd: h.cwd,
            relativePath: "parked.tex",
            destinationRelativePath: "source.tex",
            expectedRevision: revision("source A"),
            mutationId: "source-back",
          }),
        );
        expect(await NodeFSP.readFile(NodePath.join(h.cwd, "source.tex"), "utf8")).toBe("source A");
        expect(await h.run(h.methods.getMutationEpoch({ cwd: h.cwd }))).not.toBe(
          first.publicationEpoch,
        );
        await NodeFSP.writeFile(NodePath.join(h.cwd, input.relativePath), "outside D");
        const methods = await h.restart();
        expect(await h.run(methods.writeBinaryFile(input))).toEqual(first);
        expect(await NodeFSP.readFile(NodePath.join(h.cwd, input.relativePath), "utf8")).toBe(
          "outside D",
        );
        await expect(
          h.run(methods.writeBinaryFile({ ...input, expectedMutationEpoch: "changed" })),
        ).rejects.toMatchObject({ _tag: "WorkspaceFileMutationIntentConflictError" });
        const replacement = await h.run(
          methods.writeBinaryFile({
            ...input,
            mutationId: "replacement",
            expectedRevision: revision("outside D"),
            expectedMutationEpoch: await h.run(methods.getMutationEpoch({ cwd: h.cwd })),
          }),
        );
        expect(replacement.publicationEpoch).not.toBe(first.publicationEpoch);
        expect(await NodeFSP.readFile(NodePath.join(h.cwd, input.relativePath))).toEqual(
          input.bytes,
        );
      }),
    );
    it.live("compares the binary epoch after competing native ownership retires", () => {
      const entered = deferred(),
        release = deferred();
      let held = false;
      return fileMutationFixture(
        async (h) => {
          await NodeFSP.mkdir(NodePath.join(h.cwd, "notes"));
          await NodeFSP.mkdir(NodePath.join(h.cwd, "exports"));
          await NodeFSP.writeFile(NodePath.join(h.cwd, "notes/a.tex"), "source A");
          const epoch = await h.run(h.methods.getMutationEpoch({ cwd: h.cwd }));
          const first = h.run(
            h.methods.deleteFile({
              cwd: h.cwd,
              relativePath: "notes/a.tex",
              expectedRevision: revision("source A"),
              mutationId: "source",
            }),
          );
          await entered.promise;
          const second = await h.restart();
          const output = h.run(
            second.writeBinaryFile({
              cwd: h.cwd,
              relativePath: "exports/report.pdf",
              bytes: Buffer.from("%PDF binary"),
              expectedMutationEpoch: epoch,
              mutationId: "output",
            }),
          );
          release.resolve();
          await first;
          await expect(output).rejects.toMatchObject({
            _tag: "WorkspaceFileTargetChangedError",
            publicationOutcome: "unchanged",
          });
          await expect(
            NodeFSP.lstat(NodePath.join(h.cwd, "exports/report.pdf")),
          ).rejects.toMatchObject({ code: "ENOENT" });
        },
        {
          at: async (point) => {
            if (point === "prepared" && !held) {
              held = true;
              entered.resolve();
              await release.promise;
            }
          },
        },
      );
    });
    it.live("preserves attention across restart and discard until exact current acceptance", () => {
      let target = "",
        outside = "",
        conflict = true;
      return fileMutationFixture(
        async (h) => {
          target = NodePath.join(h.cwd, "main.tex");
          outside = NodePath.join(h.root, "writer");
          await NodeFSP.writeFile(target, "A");
          const input = {
            cwd: h.cwd,
            relativePath: "main.tex",
            expectedRevision: revision("A"),
            mutationId: "remove",
          };
          await expect(h.run(h.methods.deleteFile(input))).rejects.toMatchObject({
            _tag: "WorkspaceFileRecoveryRequiredError",
            recoveryId: "remove",
          });
          const methods = await h.restart();
          let history = await h.run(methods.listFileVersions(input));
          expect(history.attention?.recoveryId).toBe("remove");
          await h.run(
            methods.discardFileVersion({ ...input, versionId: history.versions[0]!.versionId }),
          );
          history = await h.run(methods.listFileVersions(input));
          expect(history.attention?.recoveryId).toBe("remove");
          await expect(h.run(methods.getMutationEpoch({ cwd: h.cwd }))).rejects.toMatchObject({
            _tag: "WorkspaceFileRecoveryRequiredError",
          });
          await expect(
            h.run(
              methods.resolveFileMutation({
                ...input,
                recoveryId: "remove",
                choice: "accept-current",
                currentRevision: revision("B"),
              }),
            ),
          ).rejects.toMatchObject({ _tag: "WorkspaceFileTargetChangedError" });
          const accepted = await h.run(
            methods.resolveFileMutation({
              ...input,
              recoveryId: "remove",
              choice: "accept-current",
              currentRevision: revision("D"),
            }),
          );
          await NodeFSP.writeFile(target, "E");
          expect(
            await h.run(
              methods.resolveFileMutation({
                ...input,
                recoveryId: "remove",
                choice: "accept-current",
                currentRevision: revision("D"),
              }),
            ),
          ).toEqual(accepted);
          await expect(h.run(methods.deleteFile(input))).rejects.toMatchObject({
            _tag: "WorkspaceFileRecoveryRequiredError",
            recoveryId: "remove",
          });
          await h.run(
            methods.deleteFile({ ...input, expectedRevision: revision("E"), mutationId: "fresh" }),
          );
          await expect(NodeFSP.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
        },
        {
          at: async (point) => {
            if (point === "checked" && conflict) {
              await NodeFSP.writeFile(outside, "B");
              await NodeFSP.rename(outside, target);
            }
            if (point === "restore-intent" && conflict) {
              conflict = false;
              await NodeFSP.writeFile(outside, "D");
              await NodeFSP.rename(outside, target);
            }
          },
        },
      );
    });
    it.live(
      "does not auto-adopt legacy journals, but retains versions through explicit current review",
      () =>
        fileMutationFixture(async (h) => {
          const target = NodePath.join(h.cwd, "main.tex"),
            parent = await directoryIdentity(h.cwd),
            storage = NodePath.join(h.retentionRoot, `${parent.dev}-${parent.ino}`),
            directory = NodePath.join(storage, "legacy");
          await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
          await NodeFSP.chmod(h.retentionRoot, 0o700);
          await NodeFSP.chmod(storage, 0o700);
          await NodeFSP.writeFile(target, "D");
          await NodeFSP.writeFile(NodePath.join(directory, "slot"), "B");
          await durableJson(NodePath.join(directory, "record.json"), {
            version: 1,
            target,
            expected: revision("A"),
            desired: revision("C"),
            mechanism: "move-aside",
            phase: "prepared",
            stagedIdentity: null,
            restoreSlot: null,
            restoreTarget: null,
            restoreSlotRevision: null,
            restoreTargetRevision: null,
            rounds: 0,
            visibleRetentionPath: null,
            outcome: null,
          });
          const methods = await h.restart();
          const history = await h.run(
            methods.listFileVersions({ cwd: h.cwd, relativePath: "main.tex" }),
          );
          expect(history.attention?.recoveryId).toBe("legacy");
          expect(await NodeFSP.readFile(history.versions[0]!.retainedPath, "utf8")).toBe("B");
          expect(await NodeFSP.readFile(target, "utf8")).toBe("D");
          await expect(h.run(methods.getMutationEpoch({ cwd: h.cwd }))).rejects.toMatchObject({
            _tag: "WorkspaceFileRecoveryRequiredError",
          });
          await h.run(
            methods.resolveFileMutation({
              cwd: h.cwd,
              relativePath: "main.tex",
              recoveryId: "legacy",
              choice: "accept-current",
              currentRevision: revision("D"),
            }),
          );
          expect(await h.run(methods.getMutationEpoch({ cwd: h.cwd }))).toMatch(/^[0-9a-f]{64}$/);
          expect(await NodeFSP.readFile(target, "utf8")).toBe("D");
        }),
    );
    it.live("keeps unknown target authority blocking build admission after restart", () =>
      fileMutationFixture(async (h) => {
        const parent = await directoryIdentity(h.cwd),
          storage = NodePath.join(h.retentionRoot, `${parent.dev}-${parent.ino}`),
          directory = NodePath.join(storage, "unknown");
        await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
        await NodeFSP.chmod(h.retentionRoot, 0o700);
        await NodeFSP.chmod(storage, 0o700);
        await NodeFSP.writeFile(NodePath.join(directory, "record.json"), "unknown format");
        await NodeFSP.writeFile(NodePath.join(directory, "slot"), "unattributed B");
        await NodeFSP.writeFile(NodePath.join(h.cwd, "main.tex"), "D");
        const methods = await h.restart();
        const history = await h.run(
          methods.listFileVersions({ cwd: h.cwd, relativePath: "main.tex" }),
        );
        expect(history.attention?.recoveryId).toBe("unknown");
        await expect(
          h.run(
            methods.resolveFileMutation({
              cwd: h.cwd,
              relativePath: "main.tex",
              recoveryId: "unknown",
              choice: "accept-current",
              currentRevision: revision("D"),
            }),
          ),
        ).rejects.toMatchObject({ _tag: "WorkspaceFileRecoveryRequiredError" });
        await expect(h.run(methods.getMutationEpoch({ cwd: h.cwd }))).rejects.toMatchObject({
          _tag: "WorkspaceFileRecoveryRequiredError",
        });
        expect(await NodeFSP.readFile(NodePath.join(directory, "slot"), "utf8")).toBe(
          "unattributed B",
        );
      }),
    );
    it.live(
      "settles active removals before epoch capture and does not treat discard as source mutation",
      () =>
        fileMutationFixture(async (h) => {
          const target = NodePath.join(h.cwd, "main.tex");
          await NodeFSP.writeFile(target, "A");
          const parent = await directoryIdentity(h.cwd),
            storage = NodePath.join(h.retentionRoot, `${parent.dev}-${parent.ino}`);
          await NodeFSP.mkdir(storage, { recursive: true, mode: 0o700 });
          await NodeFSP.chmod(h.retentionRoot, 0o700);
          await expect(
            mutateRetainedFile(
              {
                cwd: h.cwd,
                relativePath: "main.tex",
                retentionDirectory: storage,
                id: "active",
                mutationId: "active",
                bytes: null,
                expectedRevision: revision("A"),
                kind: "delete",
                condition: "revision",
                ...(h.helper === undefined ? {} : { nativePublicationHelper: h.helper }),
              },
              target,
              {
                at: async (point) => {
                  if (point === "displaced") throw new Error("process died");
                },
              },
            ),
          ).rejects.toThrow("process died");
          const methods = await h.restart(),
            epoch = await h.run(methods.getMutationEpoch({ cwd: h.cwd }));
          await expect(NodeFSP.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
          const history = await h.run(
            methods.listFileVersions({ cwd: h.cwd, relativePath: "main.tex" }),
          );
          await h.run(
            methods.discardFileVersion({
              cwd: h.cwd,
              relativePath: "main.tex",
              versionId: history.versions[0]!.versionId,
            }),
          );
          expect(await h.run(methods.getMutationEpoch({ cwd: h.cwd }))).toBe(epoch);
          await h.run(
            methods.createBinaryFile({
              cwd: h.cwd,
              relativePath: "new.tex",
              bytes: Buffer.from("C"),
              mutationId: "new",
            }),
          );
          const artifact = NodePath.join(h.root, "artifact");
          await expect(
            h.run(
              methods.withWorkspacePublicationFence({ cwd: h.cwd, expectedEpoch: epoch }, () =>
                Effect.promise(() => NodeFSP.writeFile(artifact, "stale")),
              ),
            ),
          ).rejects.toMatchObject({ _tag: "WorkspaceFileTargetChangedError" });
          await expect(NodeFSP.lstat(artifact)).rejects.toMatchObject({ code: "ENOENT" });
        }),
    );
    it.live("refuses finite admission durably without creating source parents", () =>
      fileMutationFixture(
        async (h) => {
          const input = {
            cwd: h.cwd,
            relativePath: "new/main.tex",
            bytes: Buffer.from("C"),
            mutationId: "quota",
          };
          await expect(h.run(h.methods.createBinaryFile(input))).rejects.toMatchObject({
            _tag: "WorkspaceFileMutationUnavailableError",
            publicationOutcome: "unchanged",
          });
          await expect(NodeFSP.lstat(NodePath.join(h.cwd, "new"))).rejects.toMatchObject({
            code: "ENOENT",
          });
          const methods = await h.restart();
          await expect(h.run(methods.createBinaryFile(input))).rejects.toMatchObject({
            _tag: "WorkspaceFileMutationUnavailableError",
            publicationOutcome: "unchanged",
          });
        },
        {},
        1,
      ),
    );
    it.live("shares one finite admission budget across concurrent physical parents", () =>
      fileMutationFixture(
        async (h) => {
          await NodeFSP.mkdir(NodePath.join(h.cwd, "one"));
          await NodeFSP.mkdir(NodePath.join(h.cwd, "two"));
          const bytes = Buffer.alloc(9000, "C");
          const results = await Promise.allSettled(
            ["one", "two"].map((parent) =>
              h.run(
                h.methods.createBinaryFile({
                  cwd: h.cwd,
                  relativePath: `${parent}/new.tex`,
                  bytes,
                  mutationId: `budget-${parent}`,
                }),
              ),
            ),
          );
          expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
          const failed = results.find((result) => result.status === "rejected");
          expect(failed?.reason).toMatchObject({
            _tag: "WorkspaceFileMutationUnavailableError",
            publicationOutcome: "unchanged",
          });
          for (const [index, parent] of ["one", "two"].entries()) {
            const target = NodePath.join(h.cwd, parent, "new.tex");
            if (results[index]?.status === "fulfilled")
              expect(await NodeFSP.readFile(target)).toEqual(bytes);
            else await expect(NodeFSP.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
          }
        },
        {},
        30000,
      ),
    );
    it.live("charges descendants of a raced retained directory before new admission", () =>
      fileMutationFixture(
        async (h) => {
          const target = NodePath.join(h.cwd, "old");
          await NodeFSP.mkdir(target);
          await NodeFSP.mkdir(NodePath.join(h.cwd, "other"));
          const parent = await directoryIdentity(h.cwd);
          const storage = NodePath.join(h.retentionRoot, `${parent.dev}-${parent.ino}`);
          await h.run(
            h.methods.prepareRetainedDirectory({ cwd: h.cwd, retentionDirectory: storage }),
          );
          const late = Buffer.alloc(25000, "B");
          const captured = await mutateRetainedFile(
            {
              cwd: h.cwd,
              relativePath: "old",
              retentionDirectory: storage,
              id: "raced-prune",
              mutationId: "raced-prune",
              bytes: null,
              expectedRevision: null,
              kind: "prune",
              condition: "unguarded",
              ...(h.helper === undefined ? {} : { nativePublicationHelper: h.helper }),
            },
            target,
            {
              at: async (point) => {
                if (point === "checked")
                  await NodeFSP.writeFile(NodePath.join(target, "late.tex"), late);
                if (point === "displaced") await NodeFSP.mkdir(target);
              },
            },
          );
          expect(captured.outcome).toBe("attention");
          const retained = NodePath.join(captured.recordDirectory, "retained", "late.tex");
          expect(await NodeFSP.readFile(retained)).toEqual(late);
          await expect(
            h.run(
              h.methods.createBinaryFile({
                cwd: h.cwd,
                relativePath: "other/new.tex",
                bytes: Buffer.alloc(9000, "C"),
                mutationId: "after-prune",
              }),
            ),
          ).rejects.toMatchObject({
            _tag: "WorkspaceFileMutationUnavailableError",
            publicationOutcome: "unchanged",
          });
          await expect(
            NodeFSP.lstat(NodePath.join(h.cwd, "other", "new.tex")),
          ).rejects.toMatchObject({ code: "ENOENT" });
          expect(await NodeFSP.readFile(retained)).toEqual(late);
        },
        {},
        30000,
      ),
    );
    it.live.each(["file", "workspace"] as const)(
      "rejects fresh-root ENOENT under an old %s read lease",
      (kind) =>
        fileMutationFixture(async (h) => {
          let proof = false;
          const read = (_attention: unknown, settlement: { readonly currentMissing: boolean }) =>
            Effect.tryPromise({
              try: async () => {
                proof = settlement.currentMissing;
                await NodeFSP.rename(h.cwd, NodePath.join(h.root, "retired-paper"));
                await NodeFSP.mkdir(h.cwd);
                return NodeFSP.realpath(NodePath.join(h.cwd, "missing.tex"));
              },
              catch: (cause) =>
                new WorkspaceFileSystemOperationError({
                  workspaceRoot: h.cwd,
                  relativePath: "missing.tex",
                  resolvedPath: NodePath.join(h.cwd, "missing.tex"),
                  operationPath: NodePath.join(h.cwd, "missing.tex"),
                  operation: "read",
                  cause,
                }),
            });
          const effect =
            kind === "file"
              ? h.methods.withSettledFileRead({ cwd: h.cwd, relativePath: "missing.tex" }, read)
              : h.methods.withSettledWorkspaceRead(
                  { cwd: h.cwd, relativePath: "missing.tex" },
                  read,
                );
          await expect(h.run(effect)).rejects.toMatchObject({
            _tag: "WorkspaceFileTargetChangedError",
            publicationOutcome: "unchanged",
          });
          expect(proof).toBe(true);
          await expect(NodeFSP.lstat(NodePath.join(h.cwd, "missing.tex"))).rejects.toMatchObject({
            code: "ENOENT",
          });
        }),
    );
    it.live(
      "acknowledges real missing current once while preserving the original attention receipt",
      () => {
        let crash = true;
        return fileMutationFixture(
          async (h) => {
            const target = NodePath.join(h.cwd, "main.tex");
            await NodeFSP.writeFile(target, "A");
            const input = {
              cwd: h.cwd,
              relativePath: "main.tex",
              expectedRevision: revision("A"),
              mutationId: "removed",
            };
            await expect(h.run(h.methods.deleteFile(input))).rejects.toMatchObject({
              _tag: "WorkspaceFileRecoveryRequiredError",
              recoveryId: "removed",
            });
            const methods = await h.restart();
            const accepted = await h.run(
              methods.resolveFileMutation({
                ...input,
                recoveryId: "removed",
                choice: "accept-current",
                currentRevision: null,
              }),
            );
            expect(accepted).toEqual({ recoveryId: "removed", revision: null });
            await NodeFSP.writeFile(target, "outside D");
            expect(
              await h.run(
                methods.resolveFileMutation({
                  ...input,
                  recoveryId: "removed",
                  choice: "accept-current",
                  currentRevision: null,
                }),
              ),
            ).toEqual(accepted);
            await expect(h.run(methods.deleteFile(input))).rejects.toMatchObject({
              _tag: "WorkspaceFileRecoveryRequiredError",
              recoveryId: "removed",
            });
            expect(await NodeFSP.readFile(target, "utf8")).toBe("outside D");
          },
          {
            at: async (point) => {
              if (point === "displaced" && crash) {
                crash = false;
                throw new Error("native owner died after capture");
              }
            },
          },
        );
      },
    );
    it.live(
      "keeps lost post-publication journals as indexed attention rather than unchanged refusal",
      () => {
        let retention = "",
          lostJournal = "";
        return fileMutationFixture(
          async (h) => {
            retention = h.retentionRoot;
            const input = {
              cwd: h.cwd,
              relativePath: "main.tex",
              bytes: Buffer.from("C"),
              mutationId: "lost-journal",
            };
            await expect(h.run(h.methods.createBinaryFile(input))).rejects.toMatchObject({
              _tag: "WorkspaceFileRecoveryRequiredError",
              recoveryId: "lost-journal",
              publicationOutcome: "retained-attention",
            });
            expect(await NodeFSP.readFile(NodePath.join(h.cwd, "main.tex"), "utf8")).toBe("C");
            await NodeFSP.unlink(lostJournal); // The durable index remains even if the attention header is also lost.
            const methods = await h.restart();
            expect(
              (await h.run(methods.listFileVersions({ cwd: h.cwd, relativePath: "main.tex" })))
                .attention?.recoveryId,
            ).toBe("lost-journal");
            await expect(h.run(methods.getMutationEpoch({ cwd: h.cwd }))).rejects.toMatchObject({
              _tag: "WorkspaceFileRecoveryRequiredError",
              recoveryId: "lost-journal",
            });
            await NodeFSP.writeFile(NodePath.join(h.cwd, "main.tex"), "D");
            await expect(h.run(methods.createBinaryFile(input))).rejects.toMatchObject({
              _tag: "WorkspaceFileRecoveryRequiredError",
              recoveryId: "lost-journal",
            });
            expect(await NodeFSP.readFile(NodePath.join(h.cwd, "main.tex"), "utf8")).toBe("D");
          },
          {
            at: async (point) => {
              if (point !== "installed") return;
              for (const name of await NodeFSP.readdir(retention, { recursive: true }))
                if (name.endsWith("record.json")) {
                  const path = NodePath.join(retention, name),
                    record = JSON.parse(await NodeFSP.readFile(path, "utf8"));
                  if (record.mutationId === "lost-journal") {
                    lostJournal = path;
                    await NodeFSP.unlink(path);
                    throw new Error("private journal lost after publication");
                  }
                }
              throw new Error("The actual published journal was not found.");
            },
          },
        );
      },
    );
    it.live("retires legacy active records without asserting pre-namespace authority", () =>
      fileMutationFixture(async (h) => {
        const target = NodePath.join(h.cwd, "main.tex");
        await NodeFSP.writeFile(target, "A");
        const parent = await directoryIdentity(h.cwd),
          storage = NodePath.join(h.retentionRoot, `${parent.dev}-${parent.ino}`),
          journal = NodePath.join(storage, "legacy-active", "record.json");
        await NodeFSP.mkdir(storage, { recursive: true, mode: 0o700 });
        await NodeFSP.chmod(h.retentionRoot, 0o700);
        await expect(
          mutateRetainedFile(
            {
              cwd: h.cwd,
              relativePath: "main.tex",
              retentionDirectory: storage,
              id: "legacy-active",
              mutationId: "legacy-active",
              expectedRevision: revision("A"),
              kind: "delete",
              condition: "revision",
              ...(h.helper === undefined ? {} : { nativePublicationHelper: h.helper }),
            },
            target,
            {
              at: async (point) => {
                if (point !== "prepared") return;
                const record = JSON.parse(await NodeFSP.readFile(journal, "utf8"));
                delete record.sourceMutation;
                await durableJson(journal, record);
                throw new Error("legacy process died");
              },
            },
          ),
        ).rejects.toThrow("legacy process died");
        const methods = await h.restart();
        expect(
          (await h.run(methods.listFileVersions({ cwd: h.cwd, relativePath: "main.tex" })))
            .attention?.recoveryId,
        ).toBe("legacy-active");
        expect(await NodeFSP.readFile(target, "utf8")).toBe("A");
        await expect(h.run(methods.getMutationEpoch({ cwd: h.cwd }))).rejects.toMatchObject({
          _tag: "WorkspaceFileRecoveryRequiredError",
          recoveryId: "legacy-active",
        });
      }),
    );
  }
});
