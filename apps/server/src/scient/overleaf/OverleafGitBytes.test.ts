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
      withExecutor(({ git: initialGit, work, runtimeRoot }) =>
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
          const git = yield* make({ runtimeRoot }).pipe(
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
          for (const [key, expected] of [
            ["core.autocrlf", "false"],
            ["core.fileMode", "false"],
            ["core.longpaths", "true"],
            ["credential.helper", ""],
          ]) {
            const result = yield* git.execute({ cwd: repo, args: ["config", "--get", key!] });
            expect(new TextDecoder().decode(result.stdout).trim()).toBe(expected);
          }
          const samples = new Map<string, Uint8Array>([
            ["lf.tex", bytes("one\ntwo\n")],
            ["crlf.tex", bytes("one\r\ntwo\r\n")],
            ["mixed.tex", bytes("one\r\ntwo\nthree\rfour")],
            ["bom.tex", bytes("\ufeffone\r\ntwo")],
            ["binary.dat", Uint8Array.from([0, 255, 128, 13, 10, 0, 42])],
          ]);
          const files: string[] = [];
          for (const [name, value] of samples) {
            const file = NodePath.join(work, name);
            yield* fs.writeFile(file, value);
            files.push(file);
          }
          const hashed = yield* repos.writeBlobsFromFiles({ repo, files });
          expect(hashed).toEqual([...samples.values()].map(objectId));
          const entries = [...samples.keys()].map((path, index) => ({ path, oid: hashed[index]! }));
          const base = yield* repos.writeTree({ repo, entries });
          const localOid = yield* repos.writeBlob({ repo, bytes: bytes("local\r\n") });
          const remoteOid = yield* repos.writeBlob({ repo, bytes: bytes("\ufeffremote\n") });
          const local = yield* repos.writeTree({
            repo,
            entries: [...entries, { path: "local.tex", oid: localOid }],
          });
          const remote = yield* repos.writeTree({
            repo,
            entries: [...entries, { path: "remote.tex", oid: remoteOid }],
          });
          const merged = yield* repos.merge({ repo, base, local, remote });
          const mergedEntries = yield* repos.readTree({ repo, tree: merged.tree });
          expect(mergedEntries).toHaveLength(samples.size + 2);
          for (const entry of mergedEntries) {
            const original = samples.get(entry.path);
            if (original === undefined) continue;
            expect(entry.oid).toBe(objectId(original));
            const actual = yield* repos.readBlob({ repo, oid: entry.oid, maxBytes: 1024 });
            expect(actual).toEqual(original);
          }
        }),
      ),
  );
});
