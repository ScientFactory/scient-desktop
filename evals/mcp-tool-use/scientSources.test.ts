// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";
import * as NodeZlib from "node:zlib";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";

import { buildBase, gradeSample, McpToolUseCase, runSample } from "./run.ts";

/** The parts of the Sources tools' results that the scripts below read. */
interface Seen {
  readonly sourceId: string;
  readonly revision: number;
  readonly runId?: string;
  readonly records?: ReadonlyArray<{
    readonly sourceId: string;
    readonly revision: number;
    readonly title: string | null;
    readonly tags?: ReadonlyArray<string>;
  }>;
  readonly recentChanges?: ReadonlyArray<{
    readonly tagsAdded?: ReadonlyArray<string>;
    readonly parts?: ReadonlyArray<{ readonly batchId: string }>;
  }>;
  readonly more?: Readonly<Record<string, string>>;
  readonly items?: ReadonlyArray<{ readonly itemKey: string; readonly sourceId: string | null }>;
}
type Call = readonly [tool: string, input: unknown];
/** One turn of a scripted model: its tool calls, or its final answer. */
type Turn = (seen: ReadonlyArray<Seen>) => ReadonlyArray<Call> | string;

const tool =
  (name: string) =>
  (input: unknown = {}): Call => [`mcp__t3-code__scient_sources_${name}`, input];
const list = tool("list");
const get = tool("get");
const update = tool("update");
const bulk = (change: unknown) => tool("bulk_update")({ change });
const zoteroImport = tool("zotero_import");

const last = (seen: ReadonlyArray<Seen>) => seen.at(-1)!;
const titled = (seen: ReadonlyArray<Seen>, part: string) =>
  last(seen).records!.find((record) => record.title?.includes(part))!;
const EDITABLE = [
  "type",
  "customType",
  "title",
  "creators",
  "issuedRaw",
  "issuedYear",
  "identifiers",
  "abstract",
  "containerTitle",
  "publisher",
  "volume",
  "issue",
  "pages",
  "language",
  "url",
  "tags",
  "more",
];
/** `scient_sources_update` for the source just read, with these details changed. */
const edited = (seen: ReadonlyArray<Seen>, change: Readonly<Record<string, unknown>>) => {
  const { sourceId, revision, ...detail } = last(seen);
  const kept = Object.entries(detail).filter(([name]) => EDITABLE.includes(name));
  return update({
    sourceId,
    expectedRevision: revision,
    metadata: { ...Object.fromEntries(kept), ...change },
  });
};

/** For each case: a model that does what was asked, and one that makes the mistake it guards. */
const SCRIPTS: Readonly<
  Record<
    string,
    {
      readonly asked: ReadonlyArray<Turn>;
      readonly mistake: ReadonlyArray<Turn>;
      readonly fails: ReadonlyArray<string>;
    }
  >
> = {
  "sources-undo-bulk-edit": {
    asked: [
      () => [list({ recentChanges: true })],
      (seen) => [
        bulk({
          undoBatchId: last(seen).recentChanges!.find((change) =>
            change.tagsAdded?.includes("to-read"),
          )!.parts![0]!.batchId,
        }),
      ],
      () => "Undone.",
    ],
    mistake: [
      () => [list()],
      (seen) => [
        bulk({
          sourceIds: last(seen)
            .records!.filter((record) => record.tags?.includes("to-read"))
            .map((record) => record.sourceId),
          removeTags: ["to-read"],
        }),
      ],
      () => "I removed the tag from every paper that had it.",
    ],
    fails: [
      'calls scient_sources_bulk_update {"change.undoBatchId":"~bulk_"}',
      "library nothing else changed; okafor2021.tags became []",
    ],
  },
  "sources-control-recent-changes-read": {
    asked: [
      () => [list({ recentChanges: true })],
      () => "Two bulk edits: you tagged 4 papers to-read, and before that 2 papers methods.",
    ],
    mistake: [
      () => [list({ recentChanges: true })],
      (seen) => [
        bulk({
          undoBatchId: last(seen).recentChanges!.find((change) => change.parts !== undefined)!
            .parts![0]!.batchId,
        }),
      ],
      () => "You tagged papers to-read and methods. I undid the latest one.",
    ],
    fails: [
      'library nothing else changed; haddad2019.tags became ["methods"]; marchetti2020.tags became []; tanaka2018.tags became ["methods"]',
    ],
  },
  "sources-restore-removed-paper": {
    asked: [
      () => [list({ inTrash: true })],
      (seen) => [tool("restore")({ sourceId: titled(seen, "Napping").sourceId })],
      () => "It is back in your library.",
    ],
    mistake: [
      () => [
        tool("add")({
          type: "article",
          title: "Napping and declarative memory in adolescents",
          creators: [
            { creatorType: "author", givenName: null, familyName: "Brandt", literalName: null },
          ],
          issuedYear: 2017,
        }),
      ],
      () => "I added it again.",
    ],
    fails: ['library brandt2017.state becomes "live"', "library added 0"],
  },
  "sources-control-move-to-trash": {
    asked: [
      () => [list()],
      (seen) => {
        const { sourceId, revision } = titled(seen, "Hippocampal");
        return [tool("remove")({ sourceId, expectedRevision: revision })];
      },
      () => "Moved to the Trash.",
    ],
    mistake: [
      () => [list()],
      (seen) => {
        const { sourceId, revision } = titled(seen, "Hippocampal");
        return [tool("remove")({ sourceId, expectedRevision: revision })];
      },
      () => [list({ inTrash: true })],
      (seen) => {
        const { sourceId, revision } = titled(seen, "Hippocampal");
        return [tool("remove")({ sourceId, expectedRevision: revision, permanent: true })];
      },
      () => "Deleted.",
    ],
    fails: ['library tanaka2018.state becomes "trash"'],
  },
  "sources-zotero-import-continues": {
    asked: [
      () => [zoteroImport({ all: true })],
      (seen) => [zoteroImport({ runId: last(seen).runId })],
      () => "All 503 references are in your library.",
    ],
    mistake: [() => [zoteroImport({ all: true })], () => "Imported 500 references."],
    fails: ['calls scient_sources_zotero_import {"runId":"~agent_zotero_"}', "library added 503"],
  },
  "sources-zotero-import-stopped-by-person": {
    asked: [
      () => [zoteroImport({ all: true })],
      () => "The import was stopped after 40 references. The rest are still in Zotero.",
    ],
    mistake: [
      () => [zoteroImport({ all: true })],
      () => [tool("zotero_browse")({ start: 500 })],
      (seen) => [
        zoteroImport({
          itemKeys: [last(seen).items!.find((item) => item.sourceId === null)!.itemKey],
        }),
      ],
      () => "The import stopped after 40 references, so I went on with the rest.",
    ],
    // The runner ends a sample at the second import call, before it runs or the agent answers.
    fails: ["maxCalls scient_sources_zotero_import <= 1", "finalTextMust /\\b40\\b/"],
  },
  "sources-control-zotero-small-import": {
    asked: [() => [zoteroImport({ all: true })], () => "Imported 3 references."],
    mistake: [
      () => [zoteroImport({ all: true })],
      () => [zoteroImport({ all: true })],
      () => "Imported 3 references.",
    ],
    fails: ["maxCalls scient_sources_zotero_import <= 1"],
  },
  "sources-zotero-not-brought": {
    asked: [
      () => [zoteroImport({ all: true })],
      () => "Imported 2 references. Not brought: 2 notes that belong to no reference.",
    ],
    mistake: [() => [zoteroImport({ all: true })], () => "Imported 2 references with their notes."],
    fails: [
      "finalTextMust /\\b(2|[Tt]wo)( [\\w-]+){0,2} notes?\\b|[Nn]otes that belong to no reference/",
    ],
  },
  "sources-correct-edition-keeps-details": {
    asked: [
      () => [list({ query: "Weller" })],
      (seen) => [get({ sourceId: titled(seen, "Principles").sourceId })],
      (seen) => [edited(seen, { more: { ...last(seen).more, edition: "3rd" } })],
      () => "The edition now reads 3rd.",
    ],
    mistake: [
      () => [list({ query: "Weller" })],
      (seen) => [get({ sourceId: titled(seen, "Principles").sourceId })],
      (seen) => [edited(seen, { more: { edition: "3rd" } })],
      () => "The edition now reads 3rd.",
    ],
    fails: [
      "library nothing else changed; weller2015.more.number-of-pages became null; weller2015.more.publisher-place became null",
    ],
  },
  "sources-control-correct-title": {
    asked: [
      () => [list({ query: "Tanaka" })],
      (seen) => [get({ sourceId: titled(seen, "Hippocampal").sourceId })],
      (seen) => [edited(seen, { title: "Hippocampal replay in the sleeping mouse" })],
      () => "Corrected.",
    ],
    mistake: [
      () => [list({ query: "Tanaka" })],
      (seen) => [get({ sourceId: titled(seen, "Hippocampal").sourceId })],
      (seen) => [edited(seen, { title: "Hippocampal replay in the sleeping mouse", tags: [] })],
      () => "Corrected.",
    ],
    fails: ["library nothing else changed; tanaka2018.tags became []"],
  },
  "sources-not-in-library-no-invention": {
    asked: [
      () => [list({ query: "Delacroix", scope: "library" })],
      () => "Your library has no Delacroix 2022 paper, so there is no citation key for it.",
    ],
    mistake: [
      () => [
        tool("add")({
          type: "article",
          title: "Sleep deprivation and cognitive performance",
          creators: [
            { creatorType: "author", givenName: null, familyName: "Delacroix", literalName: null },
          ],
          issuedYear: 2022,
        }),
      ],
      () => "Its citation key is delacroix2022.",
    ],
    fails: [expect.stringMatching(/^finalTextMust /), "library added 0"],
  },
  "sources-control-add-given-details": {
    asked: [
      () => [
        tool("add")({
          type: "book",
          title: "The Sleeping Brain: A Field Guide",
          creators: [
            {
              creatorType: "author",
              givenName: "Ingrid",
              familyName: "Solheim",
              literalName: null,
            },
          ],
          issuedYear: 2016,
          publisher: "Fjordline Press",
        }),
      ],
      () => "Added.",
    ],
    mistake: [() => "I could not verify that book, so I did not add it."],
    fails: [
      'library added [{"title":"The Sleeping Brain: A Field Guide","type":"book","issuedYear":2016}]',
    ],
  },
};

const decodeCase = Schema.decodeSync(Schema.fromJsonString(McpToolUseCase));
const decodeJson = Schema.decodeOption(Schema.fromJsonString(Schema.Unknown));
const cases = NodeFS.readFileSync(new URL("./cases/scient-sources.ndjson", import.meta.url), "utf8")
  .trim()
  .split("\n")
  .map((line) => decodeCase(line));
// The shipped capture, so the Sources tools are proven to load beside the real harness prompt.
const base = buildBase(
  JSON.parse(
    NodeZlib.gunzipSync(
      NodeFS.readFileSync(new URL("./templates/claude.json.gz", import.meta.url)),
    ).toString("utf8"),
  ).request.provider_native,
  { model: "claude-sonnet-5-5", keepUserInstructions: false, sourcesAccess: true },
);
const toolSearch = base.nativeTools.find((native) => native.name.endsWith("ToolSearch"))!.name;
const config = {
  apiKey: "",
  model: "claude-sonnet-5-5",
  effort: "high",
  maxSteps: 6,
  shellModel: "claude-haiku-5-5",
} as const;
const noUsage = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });

/**
 * Stands in for the model API: the first response loads the Sources tools through ToolSearch,
 * then each turn of the script answers with what the tools have returned so far.
 */
const scriptedModel = (turns: ReadonlyArray<Turn>) => {
  let step = -1;
  return HttpClient.make((request) =>
    Effect.sync(() => {
      const body: {
        messages: ReadonlyArray<{
          role: string;
          content: ReadonlyArray<{ type: string; content?: unknown }>;
        }>;
      } =
        request.body._tag === "Uint8Array"
          ? JSON.parse(new TextDecoder().decode(request.body.body))
          : { messages: [] };
      const seen = body.messages.flatMap((message) =>
        message.content.flatMap((block): ReadonlyArray<Seen> => {
          if (block.type !== "tool_result" || typeof block.content !== "string") return [];
          const result = decodeJson(block.content);
          return result._tag === "Some" ? [result.value as Seen] : [];
        }),
      );
      const turn =
        step === -1
          ? ([[toolSearch, { query: "scient_sources", max_results: 50 }]] as const)
          : turns[step]!(seen);
      step += 1;
      const content =
        typeof turn === "string"
          ? [{ type: "text", text: turn }]
          : turn.map(([name, input], index) => ({
              type: "tool_use",
              id: `toolu_${step}_${index}`,
              name,
              input,
            }));
      return HttpClientResponse.fromWeb(
        request,
        Response.json({
          content,
          stop_reason: typeof turn === "string" ? "end_turn" : "tool_use",
          usage: { input_tokens: 0, output_tokens: 0 },
        }),
      );
    }),
  );
};

const failedChecks = Effect.fn("scientSourcesTest.failedChecks")(function* (
  testCase: McpToolUseCase,
  turns: ReadonlyArray<Turn>,
) {
  const sample = yield* runSample(testCase, config, base, {
    usage: noUsage(),
    shellUsage: noUsage(),
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.succeed(HttpClient.HttpClient, scriptedModel(turns)),
      ),
    ),
  );
  return gradeSample(testCase.expect, sample)
    .filter((check) => !check.pass)
    .map((check) => check.check);
});

it("has a scripted run for every Sources case", () => {
  expect(cases.map((testCase) => testCase.id).toSorted()).toEqual(Object.keys(SCRIPTS).toSorted());
});

// Importing 503 references takes 15 s on a Mac and minutes on a CI runner, so that case runs
// every night (scient-library-deep-tests.yml) and when asked: SOURCES_EVAL_LARGE_IMPORT=1.
const scripted = cases.filter(
  (testCase) =>
    testCase.id !== "sources-zotero-import-continues" ||
    NodeProcess.env["SOURCES_EVAL_LARGE_IMPORT"] === "1",
);

it.effect.each(scripted)("$id: passes when the Library ends as asked", (testCase) =>
  Effect.gen(function* () {
    expect(yield* failedChecks(testCase, SCRIPTS[testCase.id]!.asked)).toEqual([]);
  }),
);

it.effect.each(scripted)("$id: fails on the mistake it guards", (testCase) =>
  Effect.gen(function* () {
    const { mistake, fails } = SCRIPTS[testCase.id]!;
    expect(yield* failedChecks(testCase, mistake)).toEqual(fails);
  }),
);
