// @effect-diagnostics nodeBuiltinImport:off -- synthetic package and runtime outputs live in temporary folders.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";

import type { ExecutionProcessPort } from "@scientfactory/execution";
import {
  ComputeProjectId,
  ResultHandoffManifest,
  type ResultHandoffExportProgress,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import { makeResultsReader, publishScriptRun } from "../resultRevisions.ts";
import { exportResultPackage } from "./exportResultPackage.ts";
import { hashBytes } from "./handoffFiles.ts";
import { handoffLockfileChoices } from "./handoffEnvironment.ts";
import { exportHandoffInputs } from "./handoffInputs.ts";
import { makeResultHandoff } from "./ResultHandoff.ts";
import { verifyResultPackage } from "./verifyResultPackage.ts";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    createReadStream: vi.fn(actual.createReadStream),
    createWriteStream: vi.fn(actual.createWriteStream),
  };
});

const decodeManifest = Schema.decodeUnknownSync(ResultHandoffManifest);

it.effect(
  "copies the exact older script, checks omitted inputs and refuses corrupt bytes before running",
  () =>
    Effect.gen(function* () {
      const temp = yield* Effect.acquireRelease(
        Effect.promise(async () =>
          NodeFSP.realpath(
            await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-handoff-test-")),
          ),
        ),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const originalTable = "x\n1\n";
      const { root, layout, folder, manifest, manifestPath, manifestText, newer } =
        yield* Effect.promise(async () => {
          const root = NodePath.join(temp, "project");
          const stagingFolder = NodePath.join(temp, "staging");
          const layout = { computeDir: NodePath.join(temp, "state") };
          const source = "print('original')\n";
          await NodeFSP.mkdir(root);
          await NodeFSP.mkdir(stagingFolder);
          await NodeFSP.writeFile(NodePath.join(root, "analysis.py"), "print('edited')\n");
          await NodeFSP.writeFile(NodePath.join(root, "cohort.csv"), originalTable);
          await NodeFSP.writeFile(NodePath.join(stagingFolder, "table.csv"), originalTable);
          await NodeFSP.writeFile(NodePath.join(stagingFolder, "figure.png"), "saved figure");
          const stat = await NodeFSP.stat(NodePath.join(root, "cohort.csv"), { bigint: true });
          const publication = {
            projectId: "project",
            root,
            stagingFolder,
            succeeded: true,
            scriptPath: "analysis.py",
            language: "Python",
            code: source,
            sessionId: "session",
            executionId: "execution",
            startedAt: null,
            finishedAt: "2026-11-23T00:00:00Z",
            threadId: "private-author-id",
            runtime: {
              executable: "/private/author/bin/python",
              version: "3.12.13",
              fingerprint: null,
            },
            reads: {
              files: [
                {
                  path: NodePath.join(root, "cohort.csv"),
                  size: Number(stat.size),
                  modifiedAtNs: stat.mtimeNs.toString(),
                },
              ],
              truncated: false,
            },
          };
          const published = await publishScriptRun(layout, publication);
          if (published._tag !== "published") throw new Error(published.message);
          await NodeFSP.mkdir(stagingFolder);
          await NodeFSP.writeFile(NodePath.join(stagingFolder, "table.csv"), originalTable);
          const newer = await publishScriptRun(layout, {
            ...publication,
            code: "print('edited')\n",
            executionId: "newer-execution",
            finishedAt: "2026-11-23T00:01:00Z",
          });
          if (newer._tag !== "published") throw new Error(newer.message);
          const conda = "name: threshold\nprefix: /Users/synthetic/miniconda/envs/threshold\n";
          const hidden = String.raw`location = "C:\Users\synthetic"`;
          await NodeFSP.writeFile(NodePath.join(root, "environment.yml"), conda);
          await NodeFSP.writeFile(NodePath.join(root, "uv.lock"), hidden);
          await NodeFSP.writeFile(NodePath.join(root, "LICENSE"), "Synthetic fixture license");
          const revision = {
            ...published.revision,
            outputs: [
              ...published.revision.outputs,
              { ...published.revision.outputs[0]!, name: "what?.csv" },
            ],
            environment: {
              lockfiles: [
                { path: "environment.yml", sha256: hashBytes(conda) },
                { path: "uv.lock", sha256: hashBytes(hidden) },
              ],
            },
          };
          expect(await handoffLockfileChoices(root, revision)).toEqual([
            {
              path: "environment.yml",
              status: "prefix-removed",
              size: Buffer.byteLength("name: threshold\n"),
            },
            { path: "uv.lock", status: "private-path" },
          ]);
          const options = {
            reader: makeResultsReader(layout, "project", root),
            revision,
            projectRoot: root,
            destination: temp,
            includeInputs: [],
            recordedScript: source,
            createdAt: "2026-11-23T00:01:00Z",
            scientVersion: "0.0.0-test",
          };
          await expect(
            exportResultPackage({
              ...options,
              revision: {
                ...revision,
                parameters: [
                  {
                    name: "options",
                    value: JSON.stringify("--input=/somewhere/data.csv"),
                    source: "override",
                  },
                ],
              },
            }),
          ).rejects.toThrow("absolute path");
          const { folder, warnings } = await exportResultPackage(options);
          expect(warnings).toEqual(
            expect.arrayContaining([
              expect.stringContaining("what?.csv"),
              expect.stringContaining("uv.lock was excluded"),
            ]),
          );
          const manifestPath = NodePath.join(folder, "manifest.json");
          const manifestText = await NodeFSP.readFile(manifestPath, "utf8");
          const manifest = decodeManifest(JSON.parse(manifestText));
          expect(manifestText).not.toContain("private-author-id");
          expect(manifestText).not.toContain("/private/author");
          expect(manifest).toMatchObject({
            skippedOutputs: ["what?.csv"],
            license: { sha256: hashBytes("Synthetic fixture license") },
            environment: {
              lockfiles: [
                {
                  path: "environment.yml",
                  included: true,
                  prefixRemoved: true,
                  fileSha256: hashBytes("name: threshold\n"),
                },
                { path: "uv.lock", included: false, excludedReason: "private-path" },
              ],
            },
          });
          const crate = JSON.parse(
            await NodeFSP.readFile(NodePath.join(folder, "ro-crate-metadata.json"), "utf8"),
          );
          expect(crate["@graph"]).toContainEqual(
            expect.objectContaining({ "@id": "./", license: { "@id": "LICENSE" } }),
          );
          expect(
            await NodeFSP.readFile(
              NodePath.join(folder, "environment/lockfiles/environment.yml"),
              "utf8",
            ),
          ).toBe("name: threshold\n");
          await expect(
            NodeFSP.stat(NodePath.join(folder, "environment/lockfiles/uv.lock")),
          ).rejects.toMatchObject({ code: "ENOENT" });
          expect(manifest.inputs).toMatchObject([
            { path: "cohort.csv", origin: "observed", included: false },
          ]);
          expect(
            await NodeFSP.readFile(NodePath.join(folder, "source", "analysis.py"), "utf8"),
          ).toBe(source);
          expect(await NodeFSP.readdir(folder)).not.toContain("data");
          await NodeFSP.writeFile(NodePath.join(folder, "extra.txt"), "unlisted");
          for (const name of [".DS_Store", "Thumbs.db", "desktop.ini"]) {
            await NodeFSP.writeFile(NodePath.join(folder, name), "platform metadata");
          }
          return {
            root,
            layout,
            folder,
            manifest,
            manifestPath,
            manifestText,
            newer: newer.revision.revision,
          };
        });

      let launched = 0;
      const process: ExecutionProcessPort = {
        start: (invocation) =>
          Effect.promise(async () => {
            launched += 1;
            const results = invocation.environment.SCIENT_RESULTS_DIR;
            if (results !== undefined) {
              expect(invocation.cwd).not.toBe(folder);
              await NodeFSP.writeFile(NodePath.join(results, "table.csv"), originalTable);
              await NodeFSP.writeFile(NodePath.join(results, "figure.png"), "rerun figure");
            }
            const evidence = JSON.stringify({ version: "3.12.13", packages: [] });
            return {
              exitCode: Effect.succeed(0),
              cancel: Effect.void,
              output: Stream.make({ stream: "stdout", text: evidence } as const),
            };
          }),
      };
      const handoff = makeResultHandoff({
        layout,
        process,
        gateway: {
          project: () => Effect.succeed({ projectId: ComputeProjectId.make("project"), root }),
          inspectRuntimes: () => Effect.die("Unused"),
        },
        compute: { listExecutions: () => Effect.succeed([]) },
      });
      const latest = yield* handoff.exportPackage({
        cwd: root,
        path: "analysis.py",
        destination: temp,
        includeInputs: [],
      });
      expect(NodePath.basename(latest.folder)).toContain(newer);
      const noSelection = yield* Effect.flip(handoff.choices({ cwd: root }));
      expect(noSelection.message).toContain("scient_results_list");
      const wrongScript = yield* Effect.flip(
        handoff.choices({
          cwd: root,
          path: "other.py",
          revision: newer,
        }),
      );
      expect(wrongScript.message).toContain("No saved result matches");
      const verify = (inputsFolder?: string) =>
        verifyResultPackage(process, {
          packageFolder: folder,
          ...(inputsFolder === undefined ? {} : { inputsFolder }),
          allowExecution: true,
        });
      expect((yield* verify()).report).toMatchObject({
        status: "could-not-run",
        files: expect.arrayContaining([
          {
            path: "cohort.csv",
            status: "missing",
            message: expect.any(String),
            separatelySupplied: true,
          },
        ]),
      });
      const result = yield* verify(root);
      expect(result.report).toMatchObject({
        status: "verified",
        message:
          "Checked values, tables, and data files matched. Some figures need review, and some original outputs were unavailable.",
        timeoutMinutes: 60,
        files: expect.arrayContaining([
          { path: "extra.txt", status: "unlisted", message: expect.any(String) },
        ]),
        outputs: expect.arrayContaining([
          {
            path: "figure.png",
            status: "differs",
            sha256: expect.any(String),
            message: expect.any(String),
          },
          { path: "table.csv", status: "matched", sha256: expect.any(String) },
          { path: "what?.csv", status: "unchecked", message: expect.any(String) },
        ]),
      });
      expect(result.figures.map((figure) => figure.name)).toEqual(["figure.png"]);
      expect(
        result.report.files.filter((file) => file.status === "unlisted").map((file) => file.path),
      ).toEqual(["extra.txt"]);
      expect(result.report).not.toHaveProperty("verifierName");
      expect(NodePath.dirname(NodePath.dirname(result.reportPath))).toBe(temp);
      expect(yield* Effect.promise(() => NodeFSP.readFile(manifestPath, "utf8"))).toBe(
        manifestText,
      );
      expect(launched).toBe(2);

      // Completed figure-only rerun stays distinct in wording from a failed-to-start run.
      const figureOnlyManifest = {
        ...manifest,
        outputs: manifest.outputs.filter((output) => output.kind === "figure"),
        skippedOutputs: [],
      };
      yield* Effect.promise(() =>
        NodeFSP.writeFile(manifestPath, JSON.stringify(figureOnlyManifest)),
      );
      const figureOnlyDiffering = yield* verify(root);
      expect(figureOnlyDiffering.report).toMatchObject({
        status: "could-not-run",
        message:
          "The rerun finished with no retained values, tables, or data files to verify automatically. Review the differing figures.",
        outputs: [{ path: "figure.png", status: "differs" }],
      });
      expect(figureOnlyDiffering.figures.map((figure) => figure.name)).toEqual(["figure.png"]);
      yield* Effect.promise(() => NodeFSP.writeFile(manifestPath, manifestText));
      expect(launched).toBe(4);

      for (const stop of ["request", "disconnect"] as const) {
        const copying = yield* Deferred.make<void>();
        const blocked = new NodeStream.PassThrough();
        const realFs = yield* Effect.promise(() => vi.importActual<typeof NodeFS>("node:fs"));
        using _stream = vi.spyOn(NodeFS, "createReadStream").mockImplementation((path, options) => {
          if (path !== NodePath.join(root, "cohort.csv"))
            return realFs.createReadStream(path, options);
          Deferred.doneUnsafe(copying, Effect.void);
          return blocked as unknown as NodeFS.ReadStream;
        });
        let scratch: string | undefined;
        using _write = vi.spyOn(NodeFS, "createWriteStream").mockImplementation((path, options) => {
          if (typeof path === "string" && NodePath.basename(path) === "cohort.csv")
            scratch = NodePath.dirname(NodePath.dirname(path));
          return realFs.createWriteStream(path, options);
        });
        const verification = yield* handoff
          .verify({
            packageFolder: folder,
            inputsFolder: root,
            allowExecution: true,
            verificationId: "cancel-staging",
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(copying);
        if (stop === "request") {
          expect(yield* handoff.cancelVerification({ verificationId: "cancel-staging" })).toEqual({
            requested: true,
          });
          const { report, reportPath } = yield* Fiber.join(verification);
          expect(report.status).toBe("cancelled");
          expect(yield* Effect.promise(() => NodeFSP.readFile(reportPath, "utf8"))).toContain(
            '"status": "cancelled"',
          );
        } else {
          yield* Fiber.interrupt(verification);
        }
        expect(yield* handoff.cancelVerification({ verificationId: "cancel-staging" })).toEqual({
          requested: false,
        });
        expect(blocked.destroyed).toBe(true);
        expect(launched).toBe(4);
        expect(scratch).toBeDefined();
        yield* Effect.promise(() =>
          expect(NodeFSP.access(scratch!)).rejects.toMatchObject({ code: "ENOENT" }),
        );
      }

      yield* Effect.promise(() =>
        NodeFSP.appendFile(NodePath.join(root, "cohort.csv"), "changed\n"),
      );
      const changed = yield* verify(root);
      expect(changed.report).toMatchObject({
        status: "could-not-run",
        files: expect.arrayContaining([
          {
            path: "cohort.csv",
            status: "differs",
            separatelySupplied: true,
            message: expect.any(String),
          },
        ]),
      });
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(NodePath.join(root, "cohort.csv"), originalTable);
        await NodeFSP.appendFile(NodePath.join(folder, "outputs", "table.csv"), "tamper");
      });
      expect((yield* verify(root)).report).toMatchObject({
        status: "could-not-run",
        files: expect.arrayContaining([
          {
            path: "outputs/table.csv",
            status: "differs",
            message: expect.any(String),
          },
        ]),
      });
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          manifestPath,
          JSON.stringify({
            ...manifest,
            outputs: [{ ...manifest.outputs[0], name: "../foreign" }],
          }),
        ),
      );
      expect((yield* verify()).report).toMatchObject({ status: "could-not-run", revision: null });
      expect(launched).toBe(4);
    }),
);

it("hashes data beyond the recorder limit and marks a changed input at export", async () => {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-large-input-")),
  );
  try {
    const pending = NodePath.join(root, "package");
    const path = NodePath.join(root, "large.csv");
    await NodeFSP.writeFile(path, "x");
    const bytes = 256 * 1024 * 1024 + 1;
    await NodeFSP.truncate(path, bytes);
    const stat = await NodeFSP.stat(path, { bigint: true });
    let progress: ResultHandoffExportProgress | undefined;
    const files = await exportHandoffInputs({
      project: root,
      pending,
      includeInputs: [],
      files: [
        {
          path: "large.csv",
          size: bytes - 1,
          sha256: null,
          changedDuringRun: false,
          modifiedAtNs: stat.mtimeNs.toString(),
        },
      ],
      onProgress: (current) => {
        progress = current;
      },
    });
    expect(files).toMatchObject([
      {
        path: "large.csv",
        size: bytes,
        // SHA-256 of "x" followed by 256 MiB of zero bytes.
        sha256: "31b91ae12dc384c86f1f527481da8895639b0a15efa42b6d5ebb6051bfeb888a",
        changedSinceRun: true,
        hashAtExport: true,
        included: false,
      },
    ]);
    expect(progress).toEqual({ bytesHashed: bytes, filesHashed: 1, totalFiles: 1 });
  } finally {
    await NodeFSP.rm(root, { force: true, recursive: true });
  }
});
