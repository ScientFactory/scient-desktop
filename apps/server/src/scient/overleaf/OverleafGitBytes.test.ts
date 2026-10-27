// @effect-diagnostics nodeBuiltinImport:off -- Independently hashes the exact bytes Git must preserve.
import * as NodeChildProcess from "node:child_process";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as OverleafRepository from "./OverleafRepository.ts";
import { make, OverleafGitExecutor } from "./OverleafGitExecutor.ts";
import { withExecutor } from "./OverleafGitExecutor.testkit.ts";

const bytes = (value: string) => new TextEncoder().encode(value);
const objectId = (value: Uint8Array) =>
  NodeCrypto.createHash("sha1").update(`blob ${value.length}\0`).update(value).digest("hex");

describe("Overleaf Git bytes", () => {
  it.effect(
    "hashes and merges LF, CRLF, mixed endings, BOM and binary without machine conversions",
    () =>
      withExecutor(({ git: initialGit, work, runtimeRoot, publicationHelper }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const hostile = NodePath.join(work, "host.gitconfig");
          yield* fs.writeFileString(
            hostile,
            "[core]\n autocrlf = true\n fileMode = true\n longpaths = false\n safecrlf = true\n[credential]\n helper = !exit 91\n",
          );
          const environment = { ...process.env, GIT_CONFIG_COUNT: "0", GIT_CONFIG_GLOBAL: hostile };
          const { executable } = yield* initialGit.availability;
          expect(
            NodeChildProcess.execFileSync(executable, ["config", "--get", "core.autocrlf"], {
              env: environment,
              encoding: "utf8",
            }).trim(),
          ).toBe("true");
          const git = yield* make({ runtimeRoot, publicationHelper }).pipe(
            Effect.provideService(HostProcess.Environment, environment),
          );
          const repos = yield* OverleafRepository.make.pipe(
            Effect.provideService(OverleafGitExecutor, git),
          );
          const repo = NodePath.join(work, "bytes.git");
          yield* repos.initialize({
            repo,
            gitUrl: "https://git.overleaf.com/0123456789abcdef01234567",
          });
          const lines = (ending: (index: number) => string, bom = "") =>
            bom +
            Array.from({ length: 20 }, (_, index) => `line-${index}${ending(index)}`).join("");
          const textSamples = new Map([
            ["lf.tex", lines(() => "\n")],
            ["crlf.tex", lines(() => "\r\n")],
            ["mixed.tex", lines((index) => (index % 2 === 0 ? "\r\n" : "\n"))],
            ["bom.tex", lines((index) => (index === 19 ? "" : "\r\n"), "\ufeff")],
          ]);
          const samples = new Map<string, Uint8Array>([
            ...[...textSamples].map(([name, content]) => [name, bytes(content)] as const),
            ["binary.dat", Uint8Array.from([0, 255, 128, 13, 10, 0, 42])],
          ]);
          const stage = NodePath.join(
            work,
            ...Array.from({ length: 5 }, (_, index) => `${index}-${"long".repeat(12)}`),
          );
          yield* fs.makeDirectory(stage, { recursive: true });
          expect(stage.length).toBeGreaterThan(260);
          const files: string[] = [];
          for (const [name, value] of samples) {
            const file = NodePath.join(stage, name);
            yield* fs.writeFile(file, value);
            files.push(file);
          }
          const hashed = yield* repos.writeBlobsFromFiles({ repo, files });
          expect(hashed).toEqual([...samples.values()].map(objectId));
          const entries = [...samples.keys()].map((path, index) => ({ path, oid: hashed[index]! }));
          const base = yield* repos.writeTree({ repo, entries });
          const localEntries = [];
          const remoteEntries = [];
          const expected = new Map(samples);
          for (const entry of entries) {
            const content = textSamples.get(entry.path);
            const localBytes =
              content === undefined
                ? Uint8Array.from([0, 254, 128, 13, 10, 0, 42])
                : bytes(content.replace("line-2", "local-2"));
            const remoteBytes =
              content === undefined
                ? samples.get(entry.path)!
                : bytes(content.replace("line-17", "remote-17"));
            expected.set(
              entry.path,
              content === undefined
                ? localBytes
                : bytes(content.replace("line-2", "local-2").replace("line-17", "remote-17")),
            );
            localEntries.push({
              path: entry.path,
              oid: yield* repos.writeBlob({ repo, bytes: localBytes }),
            });
            remoteEntries.push({
              path: entry.path,
              oid: yield* repos.writeBlob({ repo, bytes: remoteBytes }),
            });
          }
          const local = yield* repos.writeTree({ repo, entries: localEntries });
          const remote = yield* repos.writeTree({ repo, entries: remoteEntries });
          const merged = yield* repos.merge({ repo, base, local, remote });
          const mergedEntries = yield* repos.readTree({ repo, tree: merged.tree });
          expect(mergedEntries).toHaveLength(samples.size);
          for (const entry of mergedEntries) {
            const original = expected.get(entry.path);
            if (original === undefined) continue;
            expect(entry.oid).toBe(objectId(original));
            const actual = yield* repos.readBlob({ repo, oid: entry.oid, maxBytes: 1024 });
            expect(actual).toEqual(original);
          }
        }),
      ),
  );
});
