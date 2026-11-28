import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";
import {
  codeSourcesReadable,
  lastCodeSourcesCheck,
  readCodesFresh,
  runCodeReader,
  runSignInCodesWorker,
  type CodeReaders,
} from "./codeSourcesHelper.ts";

const readers = (overrides: Partial<CodeReaders> = {}): CodeReaders => ({
  messagesReadable: () => false,
  mailReadable: () => true,
  readMessageCodes: () => {
    throw new Error("Not permitted");
  },
  readMailCodes: () => [
    {
      key: "mail:7",
      code: "482913",
      source: "mail",
      at: 1_000,
      sender: "no-reply@example.com",
      toAccount: true,
      // Whatever else a reader carries stays in the reader's process.
      ...({ text: "Your example.com code is 482913" } as object),
    },
  ],
  ...overrides,
});

it("prints only whether each source reads, or each code with what choosing it needs", () => {
  expect(runSignInCodesWorker(["readable"], readers())).toEqual({ messages: false, mail: true });
  const look = { sinceMs: 0, service: ["example"], sites: ["example.com"] };
  const printed = JSON.stringify(runSignInCodesWorker(["codes", JSON.stringify(look)], readers()));
  expect(JSON.parse(printed)).toEqual([
    {
      key: "mail:7",
      code: "482913",
      source: "mail",
      at: 1_000,
      sender: "no-reply@example.com",
      toAccount: true,
    },
  ]);
  // A refused source reads as none; the other still answers.
  expect(printed).not.toContain("Your example.com code");
  expect(runSignInCodesWorker(["other"], readers())).toEqual([]);
});

it.effect("asks a new process each time, and keeps only well-formed codes", () =>
  Effect.gen(function* () {
    const runs: Array<ReadonlyArray<string>> = [];
    let granted = false;
    const run = async (args: ReadonlyArray<string>) => {
      runs.push(args);
      return args[0] === "readable"
        ? { messages: granted, mail: false }
        : [
            { key: "messages:1", code: "123456", source: "messages", at: 1, sender: "+1555" },
            { key: "messages:2", code: "not digits", source: "messages", at: 2, sender: "+1555" },
          ];
    };
    // regression: a grant made while Scient ran wasn't seen until a restart.
    expect(yield* codeSourcesReadable(run)).toBe(false);
    expect(lastCodeSourcesCheck()?.readable).toBe(false);
    granted = true;
    expect(yield* codeSourcesReadable(run)).toBe(true);
    expect(lastCodeSourcesCheck()?.readable).toBe(true);
    const codes = yield* readCodesFresh(
      { sinceMs: 0, service: ["example"], sites: ["example.com"] },
      run,
    );
    expect(codes.map(({ key }) => key)).toEqual(["messages:1"]);
    expect(runs.map(([mode]) => mode)).toEqual(["readable", "readable", "codes"]);
    // Nothing reads where the reader can't run.
    expect(
      yield* readCodesFresh({ sinceMs: 0, service: [], sites: [] }, async () => undefined),
    ).toEqual([]);
  }),
);

it("starts the reader as a process of its own", async () => {
  // A mode that reads nothing: only the process and its answer are checked.
  expect(await runCodeReader(["none"])).toEqual([]);
});
