import {
  LiteratureWatchCandidate,
  LiteratureWatchDefinition,
  LiteratureWatchEvidence,
  LiteratureWatchQueries,
  LiteratureWatchServiceRun,
} from "@scientfactory/scient-sources";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import { WorkspaceBindingResolver } from "../../../scient/projectScope/WorkspaceBindingResolver.ts";
import * as AgentInvocationContext from "../../../scient/operations/AgentInvocationContext.ts";
import { ScientOperation } from "../../ScientOperationTool.ts";
import { ScientSourcesToolError } from "../sources/tools.ts";

const dependencies = [AgentInvocationContext.AgentInvocationContext, WorkspaceBindingResolver];
const Id = Schema.String.check(Schema.isNonEmpty());
const Line = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(600));

const operation = (id: string, write: boolean) => ({
  id,
  scope: "workspace" as const,
  requiredCapabilities: write
    ? (["sources:read", "sources:write"] as const)
    : (["sources:read"] as const),
});

const WatchSummary = Schema.Struct({
  watchId: Id,
  title: Schema.String,
  everyDays: Schema.Int,
  paused: Schema.Boolean,
  lastBriefingAt: Schema.optionalKey(Schema.String),
  briefings: Schema.Int,
});

const TriageExample = Schema.Struct({
  title: Schema.String,
  action: Schema.optionalKey(Schema.Literals(["kept", "dismissed"])),
  note: Schema.optionalKey(Schema.String),
});

export const ScientWatchesResult = Schema.Struct({
  watches: Schema.optionalKey(Schema.Array(WatchSummary)),
  watch: Schema.optionalKey(
    Schema.Struct({
      ...WatchSummary.fields,
      request: Schema.String,
      details: Schema.optionalKey(Schema.String),
      queries: LiteratureWatchQueries,
      covered: Schema.Record(Schema.String, Schema.String),
      lastServices: Schema.optionalKey(Schema.Array(LiteratureWatchServiceRun)),
      recentTriage: Schema.Array(TriageExample),
      openRunId: Schema.optionalKey(Id),
    }),
  ),
  issues: Schema.optionalKey(Schema.Array(Schema.String)),
});

const ScientWatchesTool = Tool.make("scient_watches", {
  description:
    "Read literature watches: without watchId, list them; with it, its request, details asked for, queries, the day each service is searched up to, the last run's services, and what the person kept, dismissed or noted lately (learn from these before screening).",
  parameters: Schema.Struct({ watchId: Schema.optionalKey(Id) }),
  success: ScientWatchesResult,
  failure: ScientSourcesToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read literature watches")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, operation("sources.watches", false));

const ScientWatchSaveTool = Tool.make("scient_watch_save", {
  description:
    "Create or change a literature watch after the person describes what to follow. Write one query per service in its own syntax (pubmed: field tags such as [tiab]; openalex: boolean title-and-abstract search, no commas; arxiv: cat: and abs: terms); leave out services that do not fit the field. A new watch runs right away over the last 30 days in its own thread, then every everyDays while Scient is open. Pass watchId to edit, with the whole definition; paused stops its runs.",
  parameters: Schema.Struct({
    watchId: Schema.optionalKey(Id),
    ...LiteratureWatchDefinition.fields,
    paused: Schema.optionalKey(Schema.Boolean),
  }),
  success: Schema.Struct({
    watchId: Id,
    created: Schema.Boolean,
    firstRunStarted: Schema.Boolean,
  }),
  failure: ScientSourcesToolError,
  dependencies,
})
  .annotate(Tool.Title, "Save a literature watch")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, operation("sources.watch.save", true));

const TitleLine = Schema.Struct({
  id: Id,
  title: Schema.String,
  venue: Schema.optionalKey(Schema.String),
  published: Schema.optionalKey(Schema.String),
  kinds: Schema.optionalKey(Schema.Array(Schema.String)),
  noAbstract: Schema.optionalKey(Schema.Literal(true)),
});

const ScientWatchRunTool = Tool.make("scient_watch_run", {
  description:
    "Start or resume a watch's run. Scient searches each service from the day it was searched up to, removes duplicates and papers earlier runs judged, and returns the services' status and the candidate titles from offset, 500 at a time (page with nextOffset, in order, until allTitlesRead; every title handed out counts as screened). Pass abstractsFor with candidate ids to read their abstracts and details. Pass the runId on every call after the first.",
  parameters: Schema.Struct({
    watchId: Id,
    runId: Schema.optionalKey(Id),
    offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    abstractsFor: Schema.optionalKey(
      Schema.Array(Id).check(Schema.isMinLength(1), Schema.isMaxLength(30)),
    ),
  }),
  success: Schema.Struct({
    runId: Id,
    services: Schema.Array(LiteratureWatchServiceRun),
    candidates: Schema.Int,
    alreadySeen: Schema.Int,
    titles: Schema.optionalKey(Schema.Array(TitleLine)),
    /** True once every candidate title has been handed out; publish only then. */
    allTitlesRead: Schema.optionalKey(Schema.Boolean),
    nextOffset: Schema.optionalKey(Schema.Int),
    abstracts: Schema.optionalKey(Schema.Array(LiteratureWatchCandidate)),
  }),
  failure: ScientSourcesToolError,
  dependencies,
})
  .annotate(Tool.Title, "Run a literature watch")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true)
  .annotate(ScientOperation, operation("sources.watch.run", true));

const ScientWatchPublishTool = Tool.make("scient_watch_publish", {
  description:
    "Publish the run's briefing: picks in order of importance (the first 8 are the briefing, up to 40 in all), each with why (one line), details (one line per thing the watch asks about; leave out what the text does not say) and evidence (what you actually read: title, abstract or full-text). Every handed-out candidate not picked is recorded as passed. Safe to retry.",
  parameters: Schema.Struct({
    watchId: Id,
    runId: Id,
    summary: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2_000))),
    picks: Schema.Array(
      Schema.Struct({
        candidateId: Id,
        why: Line,
        details: Schema.Array(Line).check(Schema.isMaxLength(12)),
        evidence: LiteratureWatchEvidence,
      }),
    ).check(Schema.isMaxLength(40)),
  }),
  success: Schema.Struct({
    briefingId: Id,
    picks: Schema.Int,
    screened: Schema.Int,
    unscreened: Schema.optionalKey(Schema.Int),
  }),
  failure: ScientSourcesToolError,
  dependencies,
})
  .annotate(Tool.Title, "Publish a literature watch briefing")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, operation("sources.watch.publish", true));

export const ScientLiteratureWatchToolkit = Toolkit.make(
  ScientWatchesTool,
  ScientWatchSaveTool,
  ScientWatchRunTool,
  ScientWatchPublishTool,
);
