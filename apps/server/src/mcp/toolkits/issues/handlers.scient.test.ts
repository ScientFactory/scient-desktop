import {
  EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type IssueDetail,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/ai";

import * as IssueService from "../../../issue/IssueService.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadIssueService from "../../../orchestration-v2/ThreadIssueService.ts";
import { v2PullRequestThread } from "../../../orchestration-v2/testkit/pullRequestFixtures.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as IssuesHandlers from "./handlers.ts";
import { IssuesToolkit } from "./tools.ts";

const OWN_PROJECT = ProjectId.make("project-own");
const OTHER_PROJECT = ProjectId.make("project-other");
const OWN_THREAD = ThreadId.make("thread-own");
const OTHER_THREAD = ThreadId.make("thread-other");
const GITHUB = IssueTrackerKind.make("github");
const OWN_URL = "https://github.com/own/repo/issues/7";
const OTHER_URL = "https://github.com/other/repo/issues/9";

const nativeCaller: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: "provider-session-1",
  thread: {
    threadId: OWN_THREAD,
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["issues"]),
  issuedAt: 1,
};

const externalClient: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: "client-1",
  thread: undefined,
  client: { sessionId: "client-1", label: "Claude Code", access: "full-access" },
  capabilities: new Set(["issues"]),
  issuedAt: 1,
};

const thread = (id: ThreadId, projectId: ProjectId) => ({
  ...v2PullRequestThread({
    id,
    projectId,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    latestUserMessageAt: "2026-08-20T00:00:00.000Z",
  }),
  issues: [
    {
      tracker: GITHUB,
      host: "github.com",
      scope: `${projectId}/repo`,
      key: "1",
      projectId,
      url: `https://github.com/${projectId}/repo/issues/1`,
      source: "manual" as const,
      linkedAt: "2026-08-10T00:00:00.000Z",
      displayKey: "#1",
      title: `Linked in ${projectId}`,
    },
  ],
});

const detail = (projectId: ProjectId) =>
  ({
    tracker: GITHUB,
    host: "github.com",
    scope: `${projectId}/repo`,
    key: "7",
    displayKey: "#7",
    title: "Seven",
    url: OWN_URL,
    author: null,
    state: { category: "open", name: "open" },
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    closedAt: null,
    assignees: [],
    labels: [],
    commentCount: 0,
    projectId,
    projectTitle: "Project",
    writable: true,
    capabilities: {
      create: true,
      edit: true,
      comment: true,
      labels: true,
      assignees: true,
      reactions: false,
      templates: false,
      linkedPullRequests: true,
      events: true,
      search: true,
    },
    states: [],
    viewerPermissions: { setState: true, comment: true, edit: true, labels: true, assignees: true },
    viewer: null,
    body: "",
    comments: [],
    commentsCursor: null,
    events: [],
    linkedPullRequests: [],
  }) satisfies IssueDetail;

const makeHarness = Effect.fn("makeScientIssuesHarness")(function* () {
  const trackerCalls = yield* Ref.make<ReadonlyArray<string>>([]);
  const record = (call: string) => Ref.update(trackerCalls, (calls) => [...calls, call]);
  const threads = new Map([
    [OWN_THREAD, thread(OWN_THREAD, OWN_PROJECT)],
    [OTHER_THREAD, thread(OTHER_THREAD, OTHER_PROJECT)],
  ]);
  const layerDependencies = Layer.mergeAll(
    Layer.mock(ProjectService.ProjectService)({
      getShell: () => Effect.succeedNone,
      listShells: () => Effect.succeed([]),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadShell: (id) => Effect.succeed(threads.get(id) ?? null),
    }),
    Layer.mock(IssueService.IssueService)({
      detail: (ref) => record(`detail:${ref.projectId}`).pipe(Effect.as(detail(ref.projectId))),
      comment: (input) => record(`comment:${input.projectId}`),
      projectScope: (projectId) =>
        Effect.succeed({ projectId, tracker: GITHUB, host: "github.com", scope: "x/repo" }),
      resolveUrl: (url) =>
        Effect.succeed({
          projectId: url === OTHER_URL ? OTHER_PROJECT : OWN_PROJECT,
          tracker: GITHUB,
          host: "github.com",
          scope: "x/repo",
          key: url.split("/").at(-1)!,
          writable: true,
        }),
    }),
    Layer.mock(ThreadIssueService.ThreadIssueService)({
      link: (input) => record(`link:${input.threadId}`).pipe(Effect.as({ alreadyLinked: false })),
      unlink: () => Effect.succeed({ wasLinked: true }),
    }),
    McpToolAccessTestkit.liveThreadsLayer,
  );
  const toolkit = yield* IssuesToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(IssuesHandlers.layer).pipe(
        Layer.provide(layerDependencies),
      ),
    ),
  );
  const call = <Name extends keyof typeof IssuesToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    scope: McpInvocationContext.McpInvocationScope = nativeCaller,
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof IssuesToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provide(layerDependencies),
    );
  return { call, trackerCalls };
});

describe("issue tools keep a thread credential in its own project", () => {
  it.effect("refuses another project's thread, project and URL", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      expect(
        yield* harness.call("list_thread_issues", { threadId: OTHER_THREAD }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "IssueThreadNotFoundError" });
      expect(
        yield* harness
          .call("link_issue", { threadId: OTHER_THREAD, url: OTHER_URL })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "IssueThreadNotFoundError" });
      expect(
        yield* harness.call("list_issues", { projectId: OTHER_PROJECT }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "IssueProjectNotFoundError" });
      expect(
        yield* harness.call("read_issue", { projectId: OTHER_PROJECT, key: "9" }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "IssueProjectNotFoundError" });
      expect(
        yield* harness.call("comment_on_issue", { url: OTHER_URL, body: "hi" }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "IssueOperationError", reason: "not-found" });
      expect(yield* harness.call("link_issue", { url: OTHER_URL }).pipe(Effect.flip)).toMatchObject(
        { _tag: "IssueOperationError", reason: "not-found" },
      );
      expect(yield* Ref.get(harness.trackerCalls)).toEqual([]);
    }),
  );

  it.effect("still reads, comments and links within the caller's own project", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      expect((yield* harness.call("list_thread_issues", {})).issues).toMatchObject([
        { projectId: OWN_PROJECT },
      ]);
      yield* harness.call("comment_on_issue", { url: OWN_URL, body: "hi" });
      yield* harness.call("link_issue", { key: "7" });
      expect(yield* Ref.get(harness.trackerCalls)).toEqual([
        `comment:${OWN_PROJECT}`,
        `detail:${OWN_PROJECT}`,
        `link:${OWN_THREAD}`,
      ]);
    }),
  );

  it.effect("leaves an external client its environment-wide reach", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      expect(
        (yield* harness.call("list_thread_issues", { threadId: OTHER_THREAD }, externalClient))
          .issues,
      ).toMatchObject([{ projectId: OTHER_PROJECT }]);
      const read = yield* harness.call("read_issue", { url: OTHER_URL }, externalClient);
      expect(read.projectId).toBe(OTHER_PROJECT);
    }),
  );
});
