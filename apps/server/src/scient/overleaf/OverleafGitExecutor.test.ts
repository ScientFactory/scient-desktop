// @effect-diagnostics nodeBuiltinImport:off -- Inspects the executor's scratch directory on disk.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";

import {
  MINIMUM_GIT_VERSION,
  OVERLEAF_COMMIT_IDENTITY,
  OverleafGitError,
  OverleafGitExecutor,
  buildOverleafGitEnvironment,
  isSupportedGitVersion,
  make,
  parseGitVersion,
  posixAskpassScript,
  windowsAskpassLauncher,
  windowsAskpassPowerShellScript,
} from "./OverleafGitExecutor.ts";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const bytes = (value: string) => new TextEncoder().encode(value);

const withExecutor = <A, E>(
  body: (input: {
    readonly git: OverleafGitExecutor["Service"];
    readonly runtimeRoot: string;
    readonly work: string;
  }) => Effect.Effect<A, E, FileSystem.FileSystem>,
  options: { readonly allowLocalProtocols?: boolean } = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-overleaf-git-" });
      const runtimeRoot = NodePath.join(root, "runtime");
      const work = NodePath.join(root, "work");
      yield* fs.makeDirectory(work);
      const git = yield* make({ runtimeRoot, ...options });
      return yield* body({ git, runtimeRoot, work });
    }),
  ).pipe(Effect.provide(NodeServices.layer));

describe("Overleaf Git environment", () => {
  const base = {
    home: "/scratch/home",
    temp: "/scratch/tmp",
    childPath: "/usr/bin:/bin",
    hooks: "/scratch/hooks-disabled",
    globalConfig: "/scratch/gitconfig",
    globalExcludes: "/scratch/empty",
  };
  const config = (env: Record<string, string>) =>
    Object.fromEntries(
      Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, index) => [
        env[`GIT_CONFIG_KEY_${index}`],
        env[`GIT_CONFIG_VALUE_${index}`],
      ]),
    );

  it("is built from scratch with helpers, hooks and other transports disabled", () => {
    const env = buildOverleafGitEnvironment(base);
    expect(env.HOME).toBe("/scratch/home");
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(env.GIT_CONFIG_GLOBAL).toBe("/scratch/gitconfig");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_ASKPASS).toBeUndefined();
    expect(env.SCIENT_OVERLEAF_TOKEN_FILE).toBeUndefined();
    expect(config(env)).toMatchObject({
      "credential.helper": "",
      "core.hooksPath": "/scratch/hooks-disabled",
      "protocol.allow": "never",
      "protocol.https.allow": "always",
      "protocol.file.allow": "never",
      "protocol.ext.allow": "never",
      "http.followRedirects": "false",
      "commit.gpgSign": "false",
    });
  });

  it("always commits as the fixed Scient identity", () => {
    const env = buildOverleafGitEnvironment(base);
    expect(env.GIT_AUTHOR_NAME).toBe(OVERLEAF_COMMIT_IDENTITY.name);
    expect(env.GIT_COMMITTER_EMAIL).toBe(OVERLEAF_COMMIT_IDENTITY.email);
  });

  it("names the askpass helper and token file only when a token is supplied", () => {
    const env = buildOverleafGitEnvironment({
      ...base,
      askpass: "/scratch/askpass.sh",
      tokenPath: "/scratch/token",
    });
    expect(env.GIT_ASKPASS).toBe("/scratch/askpass.sh");
    expect(env.SCIENT_OVERLEAF_TOKEN_FILE).toBe("/scratch/token");
    expect(JSON.stringify(env)).not.toContain("olp_");
  });

  it("allows local repositories only when a test asks for them", () => {
    const env = buildOverleafGitEnvironment({ ...base, allowLocalProtocols: true });
    expect(config(env)["protocol.file.allow"]).toBe("always");
  });

  it("keeps the askpass helpers free of the token itself", () => {
    expect(posixAskpassScript()).toContain("SCIENT_OVERLEAF_TOKEN_FILE");
    expect(windowsAskpassPowerShellScript()).toContain(
      "ReadAllText($env:SCIENT_OVERLEAF_TOKEN_FILE)",
    );
    expect(windowsAskpassLauncher("C:\\ps.exe", "C:\\a.ps1")).toContain('-File "C:\\a.ps1" %*');
  });
});

describe("Overleaf Git version gate", () => {
  it("parses common version strings", () => {
    expect(parseGitVersion("git version 2.54.0 (Apple Git-157)\n")).toEqual([2, 54]);
    expect(parseGitVersion("git version 2.39.5.windows.1")).toEqual([2, 39]);
    expect(parseGitVersion("not git")).toBeNull();
  });

  it(`accepts ${MINIMUM_GIT_VERSION.join(".")} and newer only`, () => {
    expect(isSupportedGitVersion([2, 38])).toBe(false);
    expect(isSupportedGitVersion([2, 39])).toBe(true);
    expect(isSupportedGitVersion([3, 0])).toBe(true);
    expect(isSupportedGitVersion([1, 99])).toBe(false);
  });
});

describe("OverleafGitExecutor", () => {
  it.effect("finds a supported Git", () =>
    withExecutor(({ git }) =>
      Effect.gen(function* () {
        const found = yield* git.availability;
        expect(NodePath.isAbsolute(found.executable)).toBe(true);
        expect(parseGitVersion(found.version)).not.toBeNull();
      }),
    ),
  );

  it.effect("passes standard input and returns raw output", () =>
    withExecutor(({ git, work }) =>
      Effect.gen(function* () {
        yield* git.execute({ cwd: work, args: ["init", "-q", "--bare", "repo.git"] });
        const repo = NodePath.join(work, "repo.git");
        const written = yield* git.execute({
          cwd: repo,
          args: ["hash-object", "-w", "--stdin"],
          stdin: bytes("hello\n"),
        });
        const oid = text(written.stdout).trim();
        expect(oid).toMatch(/^[0-9a-f]{40}$/u);
        const read = yield* git.execute({ cwd: repo, args: ["cat-file", "blob", oid] });
        expect(text(read.stdout)).toBe("hello\n");
      }),
    ),
  );

  it.effect("ignores the machine's Git identity and configuration", () =>
    withExecutor(({ git, work }) =>
      Effect.gen(function* () {
        const ident = yield* git.execute({ cwd: work, args: ["var", "GIT_AUTHOR_IDENT"] });
        expect(text(ident.stdout)).toContain(
          `${OVERLEAF_COMMIT_IDENTITY.name} <${OVERLEAF_COMMIT_IDENTITY.email}>`,
        );
        const configured = yield* git.execute({
          cwd: work,
          args: ["config", "--get", "user.name"],
          acceptExitCodes: [1],
        });
        expect(configured.exitCode).toBe(1);
      }),
    ),
  );

  it.effect("hands the token to Git through askpass only, then removes it", () =>
    withExecutor(({ git, runtimeRoot, work }) =>
      Effect.gen(function* () {
        const filled = yield* git.execute({
          cwd: work,
          args: ["credential", "fill"],
          stdin: bytes("protocol=https\nhost=git.overleaf.com\n\n"),
          token: bytes("olp_FAKE-TOKEN-FOR-TEST"),
        });
        const output = text(filled.stdout);
        expect(output).toContain("username=git");
        expect(output).toContain("password=olp_FAKE-TOKEN-FOR-TEST");
        expect(NodeFS.readdirSync(runtimeRoot)).toEqual([]);
      }),
    ),
  );

  it.effect("reports a failing command with its exit code and Git's message", () =>
    withExecutor(({ git, work }) =>
      Effect.gen(function* () {
        const exit = yield* git
          .execute({ cwd: work, args: ["cat-file", "blob", "0".repeat(40)] })
          .pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        const error = yield* git
          .execute({ cwd: work, args: ["cat-file", "blob", "0".repeat(40)] })
          .pipe(Effect.flip);
        expect(error).toBeInstanceOf(OverleafGitError);
        expect(error.reason).toBe("non-zero-exit");
        expect(error.exitCode).not.toBe(0);
        expect(error.detail.length).toBeGreaterThan(0);
      }),
    ),
  );

  it.effect("stops a command that produces more output than allowed", () =>
    withExecutor(({ git, work }) =>
      Effect.gen(function* () {
        const error = yield* git
          .execute({ cwd: work, args: ["help", "-a"], maxOutputBytes: 64 })
          .pipe(Effect.flip);
        expect(error.reason).toBe("output-limit");
      }),
    ),
  );

  it.live("stops a command that runs past its time limit and leaves nothing behind", () =>
    withExecutor(({ git, runtimeRoot, work }) =>
      Effect.gen(function* () {
        const error = yield* git
          .execute({
            cwd: work,
            args: ["-c", "alias.wait=!sleep 30", "wait"],
            timeout: "400 millis",
          })
          .pipe(Effect.flip);
        expect(error.reason).toBe("timeout");
        expect(NodeFS.readdirSync(runtimeRoot)).toEqual([]);
      }),
    ),
  );
});

/** The per-user temporary folder `xcrun` keeps its database in, whatever `TMPDIR` says. */
const darwinUserTemp = () =>
  NodeChildProcess.execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], {
    encoding: "utf8",
  }).trim();

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
              // Other processes' xcrun runs replace these files; one gone since the listing holds nothing.
              let content: Buffer;
              try {
                content = NodeFS.readFileSync(NodePath.join(temp, name));
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
                throw error;
              }
              expect(content.includes(runtimeRoot)).toBe(false);
            }
          }),
        { allowLocalProtocols: true },
      ),
    );
  },
);
