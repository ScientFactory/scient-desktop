import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { ChatGptDictationError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { makeOmpExecutableGate, OmpExecutableGate } from "../omp/OmpExecutableGate.ts";
import { makeScientAgentDictation } from "./ScientAgentDictation.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const wav = new TextEncoder().encode("RIFF-test-recording");

/**
 * A stand-in agent: it answers `--runtime-info` with `version`, and `dictate` with `reply`,
 * after writing its arguments and the recording it was given beside itself.
 */
const fakeAgent = (root: string, version: string, reply: unknown) => {
  const info = {
    product: "scient-agent",
    version,
    upstream: { name: "oh-my-pi", version: "18.3.1" },
    rpcProtocolVersions: [2],
  };
  return [
    `#!${process.execPath}`,
    "const fs = require('node:fs');",
    `if (process.argv.includes('--runtime-info')) { console.log(${encode(encode(info))}); process.exit(0); }`,
    `fs.writeFileSync(${encode(`${root}/args.json`)}, JSON.stringify(process.argv.slice(2)));`,
    `fs.writeFileSync(${encode(`${root}/heard.txt`)}, fs.readFileSync(process.argv[3]));`,
    `console.log(${encode(encode(reply))});`,
    "",
  ].join("\n");
};

const dictateWith = (version: string, reply: unknown) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const env = yield* HostProcess.Environment;
    const root = yield* fs.makeTempDirectoryScoped();
    const executable = path.join(root, "scient-agent");
    yield* fs.writeFileString(executable, fakeAgent(root, version, reply));
    yield* fs.chmod(executable, 0o700);
    const dictation = yield* makeScientAgentDictation({
      binaryPath: executable,
      environment: { PATH: env.PATH },
      workDir: root,
    }).pipe(Effect.provideService(OmpExecutableGate, yield* makeOmpExecutableGate()));
    const exit = yield* Effect.exit(dictation.dictate({ wav, language: "he" }));
    const read = (name: string) =>
      fs.readFileString(path.join(root, name)).pipe(Effect.orElseSucceed(() => undefined));
    const leftover = (yield* fs.readDirectory(root)).filter((name) =>
      name.startsWith("dictation-"),
    );
    return { exit, args: yield* read("args.json"), heard: yield* read("heard.txt"), leftover };
  });

const reasonOf = (exit: Exit.Exit<unknown, ChatGptDictationError>) =>
  Exit.isFailure(exit) ? (Cause.squash(exit.cause) as ChatGptDictationError).reason : undefined;

describe("dictation with ChatGPT through Scient Agent", () => {
  it.effect("hands the agent the recording and returns its text, leaving no copy behind", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { exit, args, heard, leftover } = yield* dictateWith("0.1.9", {
          text: " The p value was below 0.05. ",
        });
        expect(exit).toEqual(Exit.succeed({ text: "The p value was below 0.05." }));
        const [command, file, ...flags] = JSON.parse(args!) as string[];
        expect(command).toBe("dictate");
        expect(file).toMatch(/dictation\.wav$/);
        expect(flags).toEqual(["--json", "--language", "he"]);
        expect(heard).toBe("RIFF-test-recording");
        expect(leftover).toEqual([]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("passes on the reason the agent gives", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { exit } = yield* dictateWith("0.1.9", {
          error: { kind: "rate-limited", message: "slow down" },
        });
        expect(reasonOf(exit)).toBe("rate-limited");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("asks for an update, and never runs `dictate`, on an agent that predates it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { exit, args } = yield* dictateWith("0.1.8", { text: "unused" });
        expect(reasonOf(exit)).toBe("update-required");
        expect(args).toBeUndefined();
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
