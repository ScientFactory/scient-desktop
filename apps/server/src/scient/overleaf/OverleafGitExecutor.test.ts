// @effect-diagnostics nodeBuiltinImport:off -- Inspects the executor's scratch directory on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import {
  make,
  MINIMUM_GIT_VERSION,
  OVERLEAF_COMMIT_IDENTITY,
  OverleafGitError,
  buildOverleafGitEnvironment,
  isSupportedGitVersion,
  parseGitVersion,
} from "./OverleafGitExecutor.ts";

import { withExecutor } from "./OverleafGitExecutor.testkit.ts";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const bytes = (value: string) => new TextEncoder().encode(value);

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

  it.effect("sweeps abandoned command scratch on startup and preserves unrelated state", () =>
    withExecutor(({ runtimeRoot, work, publicationHelper }) =>
      Effect.gen(function* () {
        const abandoned = NodePath.join(runtimeRoot, "git-crashed");
        NodeFS.mkdirSync(abandoned);
        NodeFS.writeFileSync(NodePath.join(abandoned, "token"), "dummy-crash-canary");
        NodeFS.writeFileSync(NodePath.join(runtimeRoot, "keep"), "state");
        const restarted = yield* make({ runtimeRoot, publicationHelper });
        expect(NodeFS.existsSync(abandoned)).toBe(false);
        expect(NodeFS.readFileSync(NodePath.join(runtimeRoot, "keep"), "utf8")).toBe("state");
        yield* restarted.execute({ cwd: work, args: ["--version"] });
        expect(NodeFS.readdirSync(runtimeRoot)).toEqual(["keep"]);
      }),
    ),
  );

  it.effect("refuses unavailable private scratch without taking down the service layer", () =>
    withExecutor(({ work, publicationHelper }) =>
      Effect.gen(function* () {
        const runtimeRoot = NodePath.join(work, "not-a-directory");
        NodeFS.writeFileSync(runtimeRoot, "untouched");
        const unavailable = yield* make({ runtimeRoot, publicationHelper });
        const error = yield* unavailable.availability.pipe(Effect.flip);
        expect(error.reason).toBe("runtime-failed");
        expect(NodeFS.readFileSync(runtimeRoot, "utf8")).toBe("untouched");
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
