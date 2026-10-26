// @effect-diagnostics nodeBuiltinImport:off -- Checks the actual developer-tools installation.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { withExecutor } from "./OverleafGitExecutor.testkit.ts";
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
/** The per-user temporary folder `xcrun` keeps its database in, whatever `TMPDIR` says. */
const darwinUserTemp = () =>
  NodeChildProcess.execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], {
    encoding: "utf8",
  }).trim();

/** A database file's bytes, or null when another xcrun run replaced it since the listing. */
const readXcrunFile = (path: string): Buffer | null => {
  try {
    return NodeFS.readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

/** xcrun's database files there, by name, with their size and change time. */
const xcrunFiles = (temp: string) =>
  new Map(
    NodeFS.readdirSync(temp)
      .filter((name) => name.startsWith("xcrun_db"))
      .flatMap((name) => {
        const stat = NodeFS.statSync(NodePath.join(temp, name), { throwIfNoEntry: false });
        return stat === undefined ? [] : [[name, `${stat.size}:${stat.ctimeMs}`] as const];
      }),
  );

describe.skipIf(HostProcess.Platform.defaultValue() !== "darwin")(
  "OverleafGitExecutor on macOS",
  () => {
    it.effect("runs the developer tools' own Git, never the xcrun launcher", () =>
      withExecutor(({ git, work }) =>
        Effect.gen(function* () {
          const { executable } = yield* git.availability;
          expect(executable).not.toBe("/usr/bin/git");
          const real = NodeFS.realpathSync(executable);
          expect(real).not.toBe("/usr/bin/git");
          // A real installation: its helpers sit beside it, and Git finds them there.
          const installation = NodePath.dirname(NodePath.dirname(real));
          expect(NodeFS.existsSync(NodePath.join(installation, "libexec", "git-core"))).toBe(true);
          const execPath = yield* git.execute({ cwd: work, args: ["--exec-path"] });
          expect(NodeFS.realpathSync(text(execPath.stdout).trim())).toBe(
            NodeFS.realpathSync(NodePath.join(installation, "libexec", "git-core")),
          );
        }),
      ),
    );

    it.effect("clones, fetches and pushes with nothing written outside its runtime folder", () =>
      withExecutor(
        ({ git, runtimeRoot, work }) =>
          Effect.gen(function* () {
            const temp = darwinUserTemp();
            const before = xcrunFiles(temp);
            const bare = NodePath.join(work, "remote.git");
            yield* git.execute({ cwd: work, args: ["init", "-q", "--bare", "-b", "main", bare] });
            // The templates were found without xcrun: a new repository has its description.
            expect(NodeFS.existsSync(NodePath.join(bare, "description"))).toBe(true);
            yield* git.execute({ cwd: work, args: ["clone", "-q", bare, "clone"] });
            const clone = NodePath.join(work, "clone");
            NodeFS.writeFileSync(NodePath.join(clone, "main.tex"), "hello\n");
            yield* git.execute({ cwd: clone, args: ["add", "main.tex"] });
            yield* git.execute({ cwd: clone, args: ["commit", "-q", "-m", "first"] });
            yield* git.execute({ cwd: clone, args: ["push", "-q", "origin", "HEAD:main"] });
            yield* git.execute({ cwd: clone, args: ["fetch", "-q", "origin"] });
            const remote = yield* git.execute({
              cwd: clone,
              args: ["ls-remote", "origin", "main"],
            });
            const local = yield* git.execute({ cwd: clone, args: ["rev-parse", "HEAD"] });
            expect(text(remote.stdout).split("\t")[0]).toBe(text(local.stdout).trim());
            expect(NodeFS.readdirSync(runtimeRoot)).toEqual([]);
            // xcrun records each HOME it serves in a shared database (or a partial copy of
            // it): none of this executor's homes may appear there.
            for (const [name, stamp] of xcrunFiles(temp)) {
              if (before.get(name) === stamp) continue;
              const content = readXcrunFile(NodePath.join(temp, name));
              if (content === null) continue;
              expect(content.includes(runtimeRoot)).toBe(false);
            }
          }),
        { allowLocalProtocols: true },
      ),
    );
  },
);
