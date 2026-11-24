import {
  AuthDiagnosticsReadScope,
  AuthEnvironmentMaintainScope,
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  AuthAccessWriteScope,
  AuthSourceControlWriteScope,
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  CommandId,
  ProjectId,
  ProjectMutationError,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentFilePath,
  type AuthEnvironmentScope,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProjectWriteFileError,
  IssueTrackerKind,
  SecretProviderId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";
import * as RpcAuthorization from "./RpcAuthorization.ts";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  RunId,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Stream from "effect/Stream";

import {
  RPC_REQUIRED_SCOPES,
  requiredScopeForRpcMethod,
  requiredScopeForDeviceList,
} from "./RpcAuthorization.ts";

describe("RPC authorization scopes", () => {
  it("requires settings permission for custom-model setup, removal and paid tests", () => {
    for (const method of [
      WS_METHODS.serverSaveCustomModel,
      WS_METHODS.serverRemoveCustomModel,
      WS_METHODS.serverTestCustomModel,
    ])
      expect(requiredScopeForRpcMethod(method)).toBe(AuthSettingsWriteScope);
  });

  it.effect("authorizes filter option reads without granting source-control writes", () =>
    Effect.gen(function* () {
      const tag = WS_METHODS.pullRequestsFilterOptions;
      const group = WsRpcGroup.omit(
        ...[...WsRpcGroup.requests.keys()].filter(
          (method): method is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof tag> =>
            method !== tag,
        ),
      );
      const accesses: string[] = [];
      const handler = group.toLayerHandler(tag, ({ kind }) =>
        Effect.sync(() => {
          accesses.push(kind);
          return {
            labels: [{ name: "bug", color: null }],
            authors: [],
            references: [],
            truncated: false,
          };
        }),
      );
      const clientWith = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
        RpcTest.makeClient(group).pipe(
          Effect.provide(Layer.merge(handler, RpcAuthorization.layer(scopes))),
        );
      const input = {
        projectIds: [ProjectId.make("filter-options-project")],
        kind: "labels" as const,
        query: "bug",
      };
      const writer = yield* clientWith([AuthSourceControlWriteScope]);
      expect(yield* writer[tag](input).pipe(Effect.flip)).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: AuthOrchestrationReadScope,
      });
      expect(accesses).toEqual([]);

      const reader = yield* clientWith([AuthOrchestrationReadScope]);
      yield* reader[tag](input);
      expect(accesses).toEqual(["labels"]);
    }).pipe(Effect.scoped),
  );

  it("declares exactly one scope for every RPC in the server group", () => {
    expect(new Set(Object.keys(RPC_REQUIRED_SCOPES))).toEqual(new Set(WsRpcGroup.requests.keys()));
  });

  it("treats file preparation and observation as read-only environment operations", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.filesystemPrepareFileOpen)).toBe(
      AuthFilesystemReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.filesystemSubscribeFileChanges)).toBe(
      AuthFilesystemReadScope,
    );
  });

  it("keeps compute inspection and history read-only while lifecycle changes require operate", () => {
    for (const method of [
      WS_METHODS.computeInspectRuntimes,
      WS_METHODS.computeRuntimeInventory,
      WS_METHODS.computeListSessions,
      WS_METHODS.computeGetSession,
      WS_METHODS.computeListExecutions,
      WS_METHODS.computeListOutputs,
      WS_METHODS.subscribeComputeSessions,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationReadScope);
    }
    for (const method of [
      WS_METHODS.computeVerifyRuntime,
      WS_METHODS.computeStartSession,
      WS_METHODS.computeSubmitExecution,
      WS_METHODS.computeCancelExecution,
      WS_METHODS.computeInterruptSession,
      WS_METHODS.computeRestartSession,
      WS_METHODS.computeStopSession,
      WS_METHODS.computeInspectVariables,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    }
  });

  it("lets only a session that operates threads approve sending a feedback report", () => {
    // Guest links have no RPC session, and read-only sessions lack this scope.
    expect(requiredScopeForRpcMethod(WS_METHODS.agentFeedbackAnswerRequest)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("keeps triage, which seeds an agent that reads logs and the database, behind operate scope", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverPrepareTriage)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("separates passive terminal observation from operations that can change a shell", () => {
    for (const method of [WS_METHODS.terminalObserve, WS_METHODS.subscribeTerminalMetadata]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthTerminalReadScope);
    }
    for (const method of [
      WS_METHODS.terminalAttach,
      WS_METHODS.terminalOpen,
      WS_METHODS.terminalWrite,
      WS_METHODS.terminalResize,
      WS_METHODS.terminalClear,
      WS_METHODS.terminalClose,
      WS_METHODS.previewStopLocalServer,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthTerminalOperateScope);
    }
  });
  // SCIENT-FORK:START — Scient Extensions RPC scopes.
  it("lets readers observe extensions while every extensions change needs settings write", () => {
    for (const method of [
      WS_METHODS.extensionsBrandIcon,
      WS_METHODS.extensionsList,
      WS_METHODS.extensionsSubscribeChanges,
      WS_METHODS.extensionsDiscoverSearch,
      WS_METHODS.extensionsDiscoverCatalog,
      WS_METHODS.extensionsDiscoverEntry,
      WS_METHODS.extensionsProviderStoreSearch,
      WS_METHODS.extensionsProviderStoreEntry,
      WS_METHODS.extensionsDeliveryReceipt,
      WS_METHODS.threadMcpStatusSubscribe,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationReadScope);
    }
    for (const method of [
      WS_METHODS.extensionsConnectorAdd,
      WS_METHODS.extensionsConnectorStartSignIn,
      WS_METHODS.extensionsConnectorUpdate,
      WS_METHODS.extensionsConnectorRemove,
      WS_METHODS.extensionsConnectorTest,
      WS_METHODS.extensionsPluginInstall,
      WS_METHODS.extensionsPluginRemove,
      WS_METHODS.extensionsPluginSetEnabled,
      WS_METHODS.providerPluginsAct,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthSettingsWriteScope);
    }
  });
  // SCIENT-FORK:END

  it("lets thread readers observe and refresh checkout branches", () => {
    for (const method of [WS_METHODS.subscribeVcsBranch, WS_METHODS.vcsRefreshBranch]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationReadScope);
    }
  });

  it("lets file readers see a task folder and takes source control to add a repository to it", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.workspaceTaskFolder)).toBe(AuthFilesystemReadScope);
    expect(requiredScopeForRpcMethod(WS_METHODS.workspaceAddTaskFolderRepository)).toBe(
      AuthSourceControlWriteScope,
    );
  });

  it("still lets readers load settings the way installed Swift clients ask", () => {
    expect(requiredScopeForRpcMethod("server.getSettings")).toBe(AuthOrchestrationReadScope);
  });

  it("rejects unknown RPC method names", () => {
    for (const method of ["server.notRegistered", "toString", "constructor"]) {
      expect(() => requiredScopeForRpcMethod(method)).toThrow(
        `RPC method ${method} has no declared authorization scope.`,
      );
    }
  });
});

it("requires operate permission for host retry while preserving read-only listing", () => {
  expect(requiredScopeForDeviceList({})).toBe(AuthOrchestrationReadScope);
  expect(requiredScopeForDeviceList({ retryHostId: "remote-host" })).toBe(
    AuthOrchestrationOperateScope,
  );
});

it("requires operate permission for tool updates even alongside a read-only check", () => {
  expect(requiredScopeForDeviceList({ updateTool: "agent", inspectOnly: true })).toBe(
    AuthOrchestrationOperateScope,
  );
  expect(requiredScopeForDeviceList({ updateTool: "hub" })).toBe(AuthOrchestrationOperateScope);
});

describe("RPC scope middleware", () => {
  const tested = [WS_METHODS.serverProbe, WS_METHODS.serverRetryResourceTelemetry] as const;
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
        !(tested as ReadonlyArray<string>).includes(tag),
    ),
  );

  it.effect.each([
    { scopes: [AuthOrchestrationReadScope], missing: AuthEnvironmentMaintainScope },
    {
      scopes: [AuthOrchestrationReadScope, AuthEnvironmentMaintainScope],
      missing: AuthDiagnosticsReadScope,
    },
  ])("rejects telemetry retry without $missing before its handler runs", ({ scopes, missing }) =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverProbe, () => Effect.succeed({})),
            group.toLayerHandler(WS_METHODS.serverRetryResourceTelemetry, () =>
              Effect.sync(() => handled.push("retry")).pipe(Effect.andThen(Effect.never)),
            ),
            RpcAuthorization.layer(scopes),
          ),
        ),
      );

      expect(yield* client[WS_METHODS.serverProbe]({})).toEqual({});
      expect(
        yield* client[WS_METHODS.serverRetryResourceTelemetry]({}).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: missing,
      });
      expect(handled).toEqual([]);
    }),
  );
});

describe("retained file recovery authorization", () => {
  const tested = [
    WS_METHODS.projectsListFileVersions,
    WS_METHODS.projectsDiscardFileVersion,
    WS_METHODS.projectsResolveFileMutation,
  ] as const;
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
        !(tested as ReadonlyArray<string>).includes(tag),
    ),
  );

  it.effect.each(
    [false, true].flatMap((canWrite) =>
      ["current-revision", null].map((currentRevision) => ({ canWrite, currentRevision })),
    ),
  )(
    "preserves evidence until write authority is granted: write=$canWrite, current=$currentRevision",
    ({ canWrite, currentRevision }) =>
      Effect.gen(function* () {
        const input = { cwd: "/workspace", relativePath: "notes.md" };
        const attention = {
          recoveryId: "recovery-1",
          mutationId: "mutation-1",
          retainedPaths: ["/workspace/.scient/retained/one"],
          message: "Review retained publication.",
        };
        let retained = true;
        let unresolved = true;
        const client = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.mergeAll(
              group.toLayerHandler(WS_METHODS.projectsListFileVersions, () =>
                Effect.sync(() => ({
                  versions: retained
                    ? [
                        {
                          versionId: "version-1",
                          mutationId: "mutation-1",
                          retainedPath: attention.retainedPaths[0]!,
                          revision: "retained-revision",
                          byteLength: 7,
                          retainedAt: 123,
                        },
                      ]
                    : [],
                  retainedBytes: retained ? 7 : 0,
                  limitBytes: null,
                  attention: unresolved ? attention : null,
                })),
              ),
              group.toLayerHandler(WS_METHODS.projectsDiscardFileVersion, (request) =>
                Effect.sync(() => {
                  retained = false;
                  return { versionId: request.versionId };
                }),
              ),
              group.toLayerHandler(WS_METHODS.projectsResolveFileMutation, (request) =>
                request.currentRevision !== currentRevision
                  ? Effect.fail(
                      new ProjectWriteFileError({
                        ...input,
                        failure: currentRevision === null ? "target_changed" : "revision_conflict",
                        ...(currentRevision === null ? {} : { currentRevision }),
                        mutationId: "mutation-1",
                        publicationOutcome: "retained-attention",
                        recoveryId: "recovery-1",
                        retainedPaths: attention.retainedPaths,
                      }),
                    )
                  : Effect.sync(() => {
                      unresolved = false;
                      return { recoveryId: request.recoveryId, revision: currentRevision };
                    }),
              ),
              RpcAuthorization.layer(
                canWrite
                  ? [AuthFilesystemReadScope, AuthFilesystemWriteScope]
                  : [AuthFilesystemReadScope],
              ),
            ),
          ),
        );
        expect((yield* client[WS_METHODS.projectsListFileVersions](input)).attention).toEqual(
          attention,
        );
        const discard = yield* client[WS_METHODS.projectsDiscardFileVersion]({
          ...input,
          versionId: "version-1",
        }).pipe(Effect.result);
        const staleResolution = yield* client[WS_METHODS.projectsResolveFileMutation]({
          ...input,
          recoveryId: "recovery-1",
          currentRevision: currentRevision === null ? "reviewed-revision" : null,
          choice: "accept-current",
        }).pipe(Effect.flip);
        if (!canWrite) {
          expect(discard).toMatchObject({
            _tag: "Failure",
            failure: {
              _tag: "EnvironmentAuthorizationError",
              requiredPermission: AuthFilesystemWriteScope,
            },
          });
          expect(staleResolution).toMatchObject({
            _tag: "EnvironmentAuthorizationError",
            requiredPermission: AuthFilesystemWriteScope,
          });
          expect(
            yield* client[WS_METHODS.projectsResolveFileMutation]({
              ...input,
              recoveryId: "recovery-1",
              currentRevision,
              choice: "accept-current",
            }).pipe(Effect.flip),
          ).toMatchObject({
            _tag: "EnvironmentAuthorizationError",
            requiredPermission: AuthFilesystemWriteScope,
          });
          expect(retained).toBe(true);
          expect(unresolved).toBe(true);
        } else {
          expect(discard).toMatchObject({ _tag: "Success", success: { versionId: "version-1" } });
          expect(staleResolution).toMatchObject({
            _tag: "ProjectWriteFileError",
            failure: currentRevision === null ? "target_changed" : "revision_conflict",
            ...(currentRevision === null ? {} : { currentRevision }),
            mutationId: "mutation-1",
            publicationOutcome: "retained-attention",
            recoveryId: "recovery-1",
            retainedPaths: attention.retainedPaths,
          });
          if (currentRevision === null)
            expect(staleResolution).not.toHaveProperty("currentRevision");
          expect((yield* client[WS_METHODS.projectsListFileVersions](input)).attention).toEqual(
            attention,
          );
          expect(
            yield* client[WS_METHODS.projectsResolveFileMutation]({
              ...input,
              recoveryId: "recovery-1",
              currentRevision,
              choice: "accept-current",
            }),
          ).toEqual({ recoveryId: "recovery-1", revision: currentRevision });
          expect((yield* client[WS_METHODS.projectsListFileVersions](input)).attention).toBeNull();
        }
      }).pipe(Effect.scoped),
  );
});

it.effect(
  "does not expand broad orchestration grants into settings, host, file or provider authority",
  () =>
    Effect.gen(function* () {
      const tested = [
        WS_METHODS.serverTestCustomModel,
        WS_METHODS.filesystemPrepareFileOpen,
        WS_METHODS.serverUninstallAcpRegistryManagedBinary,
      ] as const;
      const group = WsRpcGroup.omit(
        ...[...WsRpcGroup.requests.keys()].filter(
          (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
            !(tested as ReadonlyArray<string>).includes(tag),
        ),
      );
      const handled: string[] = [];
      const filePath = EnvironmentFilePath.make("/tmp/scient-rpc-scope-fixture.txt");
      const fileResult = {
        canonicalPath: filePath,
        fileName: "scient-rpc-scope-fixture.txt",
        byteLength: 0,
        mtimeMs: null,
        presentation: { kind: "text" as const, mediaType: "text/plain" },
      };
      const handlers = Layer.mergeAll(
        group.toLayerHandler(WS_METHODS.serverTestCustomModel, () =>
          Effect.sync(() => {
            handled.push("paid-model");
            return { revision: 1 };
          }),
        ),
        group.toLayerHandler(WS_METHODS.filesystemPrepareFileOpen, () =>
          Effect.sync(() => {
            handled.push("host-file");
            return fileResult;
          }),
        ),
        group.toLayerHandler(WS_METHODS.serverUninstallAcpRegistryManagedBinary, () =>
          Effect.sync(() => {
            handled.push("provider-remove");
            return { agentId: "fixture-agent", removed: true };
          }),
        ),
      );
      const clientFor = (scopes: readonly AuthEnvironmentScope[]) =>
        RpcTest.makeClient(group).pipe(
          Effect.provide(Layer.mergeAll(handlers, RpcAuthorization.layer(scopes))),
        );
      const modelInput = {
        connectionId: "fixture-connection",
        modelId: "fixture-model",
        instanceId: ProviderInstanceId.make("pi"),
        revision: 1,
      };
      const broad = yield* clientFor([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]);
      const refused = [
        [
          yield* broad[WS_METHODS.serverTestCustomModel](modelInput).pipe(Effect.flip),
          AuthSettingsWriteScope,
          AuthOrchestrationOperateScope,
        ],
        [
          yield* broad[WS_METHODS.filesystemPrepareFileOpen]({ path: filePath }).pipe(Effect.flip),
          AuthFilesystemReadScope,
          AuthOrchestrationReadScope,
        ],
        [
          yield* broad[WS_METHODS.serverUninstallAcpRegistryManagedBinary]({
            agentId: "fixture-agent",
          }).pipe(Effect.flip),
          AuthProvidersManageScope,
          AuthOrchestrationOperateScope,
        ],
      ] as const;
      for (const [error, permission, legacyScope] of refused)
        expect(error).toMatchObject({
          _tag: "EnvironmentAuthorizationError",
          requiredPermission: permission,
          requiredScope: legacyScope,
        });
      expect(handled).toEqual([]);
      const exact = yield* clientFor([
        AuthSettingsWriteScope,
        AuthFilesystemReadScope,
        AuthProvidersManageScope,
      ]);
      expect(yield* exact[WS_METHODS.serverTestCustomModel](modelInput)).toEqual({ revision: 1 });
      expect(yield* exact[WS_METHODS.filesystemPrepareFileOpen]({ path: filePath })).toEqual(
        fileResult,
      );
      expect(
        yield* exact[WS_METHODS.serverUninstallAcpRegistryManagedBinary]({
          agentId: "fixture-agent",
        }),
      ).toEqual({ agentId: "fixture-agent", removed: true });
      expect(handled).toEqual(["paid-model", "host-file", "provider-remove"]);
    }).pipe(Effect.scoped),
);

it.effect("allows issue reads but requires a source-control grant before commenting", () =>
  Effect.gen(function* () {
    const tested = [WS_METHODS.issuesList, WS_METHODS.issuesComment] as const;
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
          !(tested as ReadonlyArray<string>).includes(tag),
      ),
    );
    const comments: string[] = [];
    const handlers = Layer.mergeAll(
      group.toLayerHandler(WS_METHODS.issuesList, () =>
        Effect.succeed({ entries: [], trackers: [], errors: [], viewers: {}, nextCursors: {} }),
      ),
      group.toLayerHandler(WS_METHODS.issuesComment, ({ body }) =>
        Effect.sync(() => {
          comments.push(body);
        }),
      ),
    );
    const reader = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(Layer.merge(handlers, RpcAuthorization.layer([AuthOrchestrationReadScope]))),
    );
    const comment = {
      projectId: ProjectId.make("web"),
      tracker: IssueTrackerKind.make("github"),
      scope: "acme/web",
      key: "42",
      body: "Repro attached.",
    };

    expect((yield* reader[WS_METHODS.issuesList]({ state: "open" })).entries).toEqual([]);
    expect(yield* reader[WS_METHODS.issuesComment](comment).pipe(Effect.flip)).toMatchObject({
      _tag: "EnvironmentAuthorizationError",
      requiredPermission: AuthSourceControlWriteScope,
    });
    expect(comments).toEqual([]);

    const writer = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.merge(
          handlers,
          RpcAuthorization.layer([AuthOrchestrationReadScope, AuthSourceControlWriteScope]),
        ),
      ),
    );
    yield* writer[WS_METHODS.issuesComment](comment);
    expect(comments).toEqual(["Repro attached."]);
  }).pipe(Effect.scoped),
);

it.effect("reads a linked environment's thread only for a client that may read threads here", () =>
  Effect.gen(function* () {
    const linkedThreadTags = [
      WS_METHODS.peerLinksSubscribeThread,
      WS_METHODS.peerLinksThreadHistoryPage,
      WS_METHODS.peerLinksThreadItem,
      WS_METHODS.peerLinksNames,
    ] as const;
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof linkedThreadTags)[number]> =>
          !(linkedThreadTags as ReadonlyArray<string>).includes(tag),
      ),
    );
    const read: string[] = [];
    const input = {
      environmentId: EnvironmentId.make("environment-box"),
      threadId: ThreadId.make("thread:box"),
    };
    const handlers = group.toLayer({
      [WS_METHODS.peerLinksSubscribeThread]: ({ threadId }) =>
        Stream.sync(() => {
          read.push(threadId);
          return { kind: "synchronized" as const };
        }),
      [WS_METHODS.peerLinksThreadHistoryPage]: () => Effect.die("unused"),
      [WS_METHODS.peerLinksThreadItem]: ({ threadId }) =>
        Effect.sync(() => {
          read.push(threadId);
          return { item: null };
        }),
      // A thread link resolves to the linked environment by its name.
      [WS_METHODS.peerLinksNames]: () =>
        Effect.succeed({ links: [{ environmentId: input.environmentId, label: "Box" }] }),
    });
    // Managing links and writing settings here say nothing about reading threads.
    const outsider = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.merge(
          handlers,
          RpcAuthorization.layer([AuthAccessWriteScope, AuthSettingsWriteScope]),
        ),
      ),
    );
    const refused = {
      _tag: "EnvironmentAuthorizationError",
      requiredPermission: AuthOrchestrationReadScope,
    };
    expect(
      yield* outsider[WS_METHODS.peerLinksSubscribeThread](input).pipe(
        Stream.runCollect,
        Effect.flip,
      ),
    ).toMatchObject(refused);
    expect(
      yield* outsider[WS_METHODS.peerLinksThreadItem]({
        ...input,
        itemId: TurnItemId.make("item:1"),
      }).pipe(Effect.flip),
    ).toMatchObject(refused);
    expect(
      yield* outsider[WS_METHODS.peerLinksThreadHistoryPage]({ ...input, cursor: "c" }).pipe(
        Effect.flip,
      ),
    ).toMatchObject(refused);
    expect(read).toEqual([]);
    expect(yield* outsider[WS_METHODS.peerLinksNames]({}).pipe(Effect.flip)).toMatchObject({
      requiredPermission: AuthOrchestrationReadScope,
    });

    const reader = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(Layer.merge(handlers, RpcAuthorization.layer([AuthOrchestrationReadScope]))),
    );
    expect(
      Array.from(yield* reader[WS_METHODS.peerLinksSubscribeThread](input).pipe(Stream.runCollect)),
    ).toEqual([{ kind: "synchronized" }]);
    expect(read).toEqual([input.threadId]);
    expect((yield* reader[WS_METHODS.peerLinksNames]({})).links).toEqual([
      { environmentId: input.environmentId, label: "Box" },
    ]);
  }).pipe(Effect.scoped),
);

it.effect("pairs a client with a linked environment only for one that may hand out access", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.peerLinksPairClient
        > => tag !== WS_METHODS.peerLinksPairClient,
      ),
    );
    let asked = 0;
    const environmentId = EnvironmentId.make("environment-box");
    const handlers = group.toLayerHandler(WS_METHODS.peerLinksPairClient, () =>
      Effect.sync(() => {
        asked++;
        return {
          type: "unsupported" as const,
          reason: "link_access" as const,
          environmentId,
          label: "Box",
          urls: [],
        };
      }),
    );
    // Running agents and reading the access list do not include handing access out.
    const operator = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.merge(
          handlers,
          RpcAuthorization.layer([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]),
        ),
      ),
    );
    expect(
      yield* operator[WS_METHODS.peerLinksPairClient]({ environmentId }).pipe(Effect.flip),
    ).toMatchObject({
      _tag: "EnvironmentAuthorizationError",
      requiredPermission: AuthAccessWriteScope,
    });
    expect(asked).toBe(0);

    const manager = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(Layer.merge(handlers, RpcAuthorization.layer([AuthAccessWriteScope]))),
    );
    expect((yield* manager[WS_METHODS.peerLinksPairClient]({ environmentId })).type).toBe(
      "unsupported",
    );
    expect(asked).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect("hands out a link code or a guest link only within what the session itself holds", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.peerLinksPairLink | typeof WS_METHODS.guestShareCreate
        > => tag !== WS_METHODS.peerLinksPairLink && tag !== WS_METHODS.guestShareCreate,
      ),
    );
    let handled = 0;
    const environmentId = EnvironmentId.make("environment-box");
    const threadId = ThreadId.make("thread-1");
    const handlers = Layer.mergeAll(
      group.toLayerHandler(WS_METHODS.peerLinksPairLink, () =>
        Effect.sync(() => {
          handled++;
          return {
            type: "unsupported" as const,
            reason: "link_access" as const,
            environmentId,
            label: "Box",
            urls: [],
          };
        }),
      ),
      group.toLayerHandler(WS_METHODS.guestShareCreate, () =>
        Effect.sync(() => handled++).pipe(Effect.andThen(Effect.die("no share in this test"))),
      ),
    );
    const clientWith = (scopes: Parameters<typeof RpcAuthorization.layer>[0]) =>
      RpcTest.makeClient(group).pipe(
        Effect.provide(Layer.merge(handlers, RpcAuthorization.layer(scopes))),
      );

    // Managing access alone is not running agents or reading threads.
    const manager = yield* clientWith([AuthAccessWriteScope]);
    expect(
      yield* manager[WS_METHODS.peerLinksPairLink]({ environmentId, access: "read-only" }).pipe(
        Effect.flip,
      ),
    ).toMatchObject({ requiredPermission: AuthOrchestrationReadScope });
    expect(
      yield* manager[WS_METHODS.guestShareCreate]({ threadId }).pipe(Effect.flip),
    ).toMatchObject({ requiredPermission: AuthOrchestrationReadScope });

    const supervisor = yield* clientWith([
      AuthAccessWriteScope,
      AuthOrchestrationReadScope,
      AuthOrchestrationOperateScope,
    ]);
    expect(
      yield* supervisor[WS_METHODS.peerLinksPairLink]({
        environmentId,
        access: "full-access",
      }).pipe(Effect.flip),
    ).toMatchObject({ requiredPermission: AuthSettingsWriteScope });
    expect(handled).toBe(0);

    expect(
      (yield* supervisor[WS_METHODS.peerLinksPairLink]({ environmentId, access: "auto" })).type,
    ).toBe("unsupported");
    expect(handled).toBe(1);
    yield* supervisor[WS_METHODS.guestShareCreate]({ threadId }).pipe(Effect.exit);
    expect(handled).toBe(2);
  }).pipe(Effect.scoped),
);

it.effect.each([WS_METHODS.subscribeVcsBranch, WS_METHODS.subscribeVcsStatus] as const)(
  "enforces read permission on stream %s",
  (method) =>
    Effect.gen(function* () {
      const group = WsRpcGroup.omit(
        ...[...WsRpcGroup.requests.keys()].filter(
          (
            tag,
          ): tag is Exclude<
            keyof typeof RPC_REQUIRED_SCOPES,
            typeof WS_METHODS.subscribeVcsBranch | typeof WS_METHODS.subscribeVcsStatus
          > => tag !== WS_METHODS.subscribeVcsBranch && tag !== WS_METHODS.subscribeVcsStatus,
        ),
      );
      let handled = 0;
      const handlers = Layer.mergeAll(
        group.toLayerHandler(WS_METHODS.subscribeVcsBranch, () =>
          Stream.fromEffect(
            Effect.sync(() => {
              handled++;
              return { refName: "main" };
            }),
          ),
        ),
        group.toLayerHandler(WS_METHODS.subscribeVcsStatus, () =>
          Stream.fromEffect(
            Effect.sync(() => {
              handled++;
            }),
          ).pipe(Stream.drain),
        ),
      );
      const denied = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(Layer.merge(handlers, RpcAuthorization.layer([]))),
      );
      expect(
        yield* Stream.runDrain(
          method === WS_METHODS.subscribeVcsBranch
            ? denied[method]({ cwd: "/repo" }).pipe(Stream.drain)
            : denied[method]({ cwd: "/repo" }).pipe(Stream.drain),
        ).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthOrchestrationReadScope });
      expect(handled).toBe(0);
      const granted = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(Layer.merge(handlers, RpcAuthorization.layer([AuthOrchestrationReadScope]))),
      );
      yield* Stream.runDrain(
        method === WS_METHODS.subscribeVcsBranch
          ? granted[method]({ cwd: "/repo" }).pipe(Stream.drain)
          : granted[method]({ cwd: "/repo" }).pipe(Stream.drain),
      );
      expect(handled).toBe(1);
    }),
);

describe("settings mutation authorization", () => {
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (
        tag,
      ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.serverUpdateSettings> =>
        tag !== WS_METHODS.serverUpdateSettings,
    ),
  );
  const providerInstanceMutation = {
    operation: "remove" as const,
    instanceId: ProviderInstanceId.make("codex_work"),
  };

  it.effect("allows provider-only mutations while denying mixed settings without their grant", () =>
    Effect.gen(function* () {
      let handled = 0;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverUpdateSettings, () =>
              Effect.sync(() => {
                handled++;
                return DEFAULT_SERVER_SETTINGS;
              }),
            ),
            RpcAuthorization.layer([AuthProvidersManageScope]),
          ),
        ),
      );
      yield* client[WS_METHODS.serverUpdateSettings]({ patch: {}, providerInstanceMutation });
      expect(handled).toBe(1);
      yield* client[WS_METHODS.serverUpdateSettings]({
        patch: {},
        providerInstanceMutation: {
          operation: "upsert",
          instanceId: ProviderInstanceId.make("codex_work"),
          instance: {
            driver: ProviderDriverKind.make("codex"),
            environment: [
              {
                name: "OPENAI_API_KEY",
                sensitive: true,
                value: {
                  provider: SecretProviderId.make("personal"),
                  reference: "op://Private/OpenAI/credential",
                },
              },
            ],
          },
        },
      });
      expect(handled).toBe(2);
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({
          patch: { defaultRuntimeMode: "full-access" },
          providerInstanceMutation,
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthSettingsWriteScope });
      // Removing a secret provider clears settings fields that read from it.
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({
          patch: { secretProviders: { [SecretProviderId.make("personal")]: null } },
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthSettingsWriteScope });
      expect(handled).toBe(2);
    }),
  );

  it.effect(
    "does not let a settings grant manage providers or turn off T3 Connect device approval",
    () =>
      Effect.gen(function* () {
        let handled = false;
        const client = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.mergeAll(
              group.toLayerHandler(WS_METHODS.serverUpdateSettings, () =>
                Effect.sync(() => {
                  handled = true;
                  return DEFAULT_SERVER_SETTINGS;
                }),
              ),
              RpcAuthorization.layer([AuthSettingsWriteScope]),
            ),
          ),
        );
        expect(
          yield* client[WS_METHODS.serverUpdateSettings]({
            patch: {},
            providerInstanceMutation,
          }).pipe(Effect.flip),
        ).toMatchObject({ requiredPermission: AuthProvidersManageScope });
        expect(
          yield* client[WS_METHODS.serverUpdateSettings]({
            patch: { secretProviders: { [SecretProviderId.make("personal")]: null } },
          }).pipe(Effect.flip),
        ).toMatchObject({ requiredPermission: AuthProvidersManageScope });
        expect(
          yield* client[WS_METHODS.serverUpdateSettings]({
            patch: { requireConnectDeviceApproval: false },
          }).pipe(Effect.flip),
        ).toMatchObject({ requiredPermission: AuthAccessWriteScope });
        // A reference names any secret the store holds, and the host entry names where it goes.
        expect(
          yield* client[WS_METHODS.serverUpdateSettings]({
            patch: {
              simlockDeviceHosts: [
                {
                  kind: "simlock",
                  id: "simlock_evil",
                  label: "Gateway",
                  gatewayUrl: "https://attacker.example",
                  agentToken: {
                    provider: SecretProviderId.make("personal"),
                    reference: "op://Private/OpenAI/credential",
                  },
                  maxLeases: 2,
                  maxLeaseMinutes: 60,
                },
              ],
            },
          }).pipe(Effect.flip),
        ).toMatchObject({ requiredPermission: AuthProvidersManageScope });
        expect(handled).toBe(false);
      }),
  );

  it.effect("saving project scripts needs task operation as well as the settings grant", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-1");
      const scripts = [
        {
          id: "setup",
          name: "Setup",
          command: "pnpm install",
          icon: "play" as const,
          runOnWorktreeCreate: true,
        },
      ];
      const update = (scopes: Parameters<typeof RpcAuthorization.layer>[0]) => {
        let handled = 0;
        return RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.mergeAll(
              group.toLayerHandler(WS_METHODS.serverUpdateSettings, () =>
                Effect.sync(() => {
                  handled++;
                  return DEFAULT_SERVER_SETTINGS;
                }),
              ),
              RpcAuthorization.layer(scopes),
            ),
          ),
          Effect.map((client) => ({ client, handled: () => handled })),
        );
      };
      const patches = [
        { defaultProjectScripts: scripts },
        { projectScriptOverrides: { [projectId]: scripts } },
        { projectSettingsOverrides: { [projectId]: { defaultProjectScripts: scripts } } },
      ];

      const settingsOnly = yield* update([AuthSettingsWriteScope]);
      for (const patch of patches) {
        expect(
          yield* settingsOnly.client[WS_METHODS.serverUpdateSettings]({ patch }).pipe(Effect.flip),
        ).toMatchObject({ requiredPermission: AuthOrchestrationOperateScope });
      }
      expect(settingsOnly.handled()).toBe(0);
      // Settings that carry no script stay with the settings grant alone.
      yield* settingsOnly.client[WS_METHODS.serverUpdateSettings]({
        patch: {
          defaultAutoPull: true,
          projectScriptOverrides: { [projectId]: null },
          projectSettingsOverrides: { [projectId]: { defaultAutoPull: true } },
        },
      });
      expect(settingsOnly.handled()).toBe(1);

      const operator = yield* update([AuthSettingsWriteScope, AuthOrchestrationOperateScope]);
      for (const patch of patches) {
        yield* operator.client[WS_METHODS.serverUpdateSettings]({ patch });
      }
      expect(operator.handled()).toBe(patches.length);
    }),
  );

  it.effect("does not let a settings grant send a named secret to a gateway it picks", () =>
    Effect.gen(function* () {
      const group = WsRpcGroup.omit(
        ...[...WsRpcGroup.requests.keys()].filter(
          (
            tag,
          ): tag is Exclude<
            keyof typeof RPC_REQUIRED_SCOPES,
            typeof WS_METHODS.deviceSimlockIdentity
          > => tag !== WS_METHODS.deviceSimlockIdentity,
        ),
      );
      let handled = 0;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.deviceSimlockIdentity, () =>
              Effect.sync(() => {
                handled++;
                return {
                  gatewayUrl: "https://attacker.example",
                  signedInAs: "agent",
                  tokenSource: "entered" as const,
                };
              }),
            ),
            RpcAuthorization.layer([AuthSettingsWriteScope]),
          ),
        ),
      );
      yield* client[WS_METHODS.deviceSimlockIdentity]({
        gatewayUrl: "https://attacker.example",
        agentToken: "typed-token",
      });
      expect(handled).toBe(1);
      expect(
        yield* client[WS_METHODS.deviceSimlockIdentity]({
          gatewayUrl: "https://attacker.example",
          agentToken: {
            provider: SecretProviderId.make("personal"),
            reference: "op://Private/OpenAI/credential",
          },
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthProvidersManageScope });
      expect(handled).toBe(1);
    }),
  );
});

it.effect("answering a secret request with a reference needs provider management", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.secretsAnswerRequest
        > => tag !== WS_METHODS.secretsAnswerRequest,
      ),
    );
    const handled: string[] = [];
    const handler = group.toLayerHandler(WS_METHODS.secretsAnswerRequest, ({ answer }) =>
      Effect.sync(() => {
        handled.push(answer.type);
      }),
    );
    const clientWith = (...scopes: Parameters<typeof RpcAuthorization.layer>[0]) =>
      RpcTest.makeClient(group).pipe(
        Effect.provide(Layer.merge(handler, RpcAuthorization.layer(scopes))),
      );
    const request = { threadId: ThreadId.make("thread"), turnItemId: TurnItemId.make("item") };
    const reference = {
      type: "reference" as const,
      reference: {
        provider: SecretProviderId.make("personal"),
        reference: "op://Private/OpenAI/credential",
      },
    };

    const operate = yield* clientWith(AuthOrchestrationOperateScope);
    expect(
      yield* operate[WS_METHODS.secretsAnswerRequest]({ ...request, answer: reference }).pipe(
        Effect.flip,
      ),
    ).toMatchObject({ requiredPermission: AuthProvidersManageScope });
    expect(handled).toEqual([]);
    // Typed values stay with the scope that runs the thread, whatever the fields are called.
    yield* operate[WS_METHODS.secretsAnswerRequest]({
      ...request,
      answer: { type: "save", secret: "typed-value" },
    });
    yield* operate[WS_METHODS.secretsAnswerRequest]({
      ...request,
      answer: { type: "save", values: { provider: "personal", reference: "typed-value" } },
    });
    expect(handled).toEqual(["save", "save"]);

    const manage = yield* clientWith(AuthOrchestrationOperateScope, AuthProvidersManageScope);
    yield* manage[WS_METHODS.secretsAnswerRequest]({ ...request, answer: reference });
    expect(handled).toEqual(["save", "save", "reference"]);
    const manageOnly = yield* clientWith(AuthProvidersManageScope);
    expect(
      yield* manageOnly[WS_METHODS.secretsAnswerRequest]({ ...request, answer: reference }).pipe(
        Effect.flip,
      ),
    ).toMatchObject({ requiredPermission: AuthOrchestrationOperateScope });
  }),
);

it.effect("requires task permission before attaching a prepared worktree to a thread", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.gitPreparePullRequestThread
        > => tag !== WS_METHODS.gitPreparePullRequestThread,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.gitPreparePullRequestThread, () =>
            Effect.sync(() => {
              handled = true;
            }).pipe(Effect.andThen(Effect.never)),
          ),
          RpcAuthorization.layer([AuthSourceControlWriteScope]),
        ),
      ),
    );
    expect(
      yield* client[WS_METHODS.gitPreparePullRequestThread]({
        cwd: "/repo",
        reference: "42",
        mode: "worktree",
        threadId: ThreadId.make("thread"),
      }).pipe(Effect.flip),
    ).toMatchObject({ requiredPermission: AuthOrchestrationOperateScope });
    expect(handled).toBe(false);
  }),
);

describe("thread context authorization", () => {
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (
        tag,
      ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.gitRunStackedAction> =>
        tag !== WS_METHODS.gitRunStackedAction,
    ),
  );

  it.effect.each(["commit", "create_pr", "commit_push_pr"] as const)(
    "%s needs thread read permission only when generating a PR from a thread",
    (action) =>
      Effect.gen(function* () {
        const handled: string[] = [];
        const handler = group.toLayerHandler(WS_METHODS.gitRunStackedAction, ({ actionId }) =>
          Stream.fromEffect(Effect.sync(() => handled.push(actionId))).pipe(Stream.drain),
        );
        const client = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.merge(handler, RpcAuthorization.layer([AuthSourceControlWriteScope])),
          ),
        );
        const input = { actionId: "without-thread", cwd: "/repo", action };
        const withThread = { ...input, actionId: "with-thread", threadId: ThreadId.make("thread") };
        yield* Stream.runDrain(client[WS_METHODS.gitRunStackedAction](input));
        if (action === "create_pr" || action === "commit_push_pr") {
          expect(
            yield* Stream.runDrain(client[WS_METHODS.gitRunStackedAction](withThread)).pipe(
              Effect.flip,
            ),
          ).toMatchObject({ requiredPermission: AuthOrchestrationReadScope });
          expect(handled).toEqual(["without-thread"]);
        } else {
          yield* Stream.runDrain(client[WS_METHODS.gitRunStackedAction](withThread));
          expect(handled).toEqual(["without-thread", "with-thread"]);
        }
        const reader = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.merge(
              handler,
              RpcAuthorization.layer([AuthSourceControlWriteScope, AuthOrchestrationReadScope]),
            ),
          ),
        );
        yield* Stream.runDrain(
          reader[WS_METHODS.gitRunStackedAction]({ ...withThread, actionId: "allowed" }),
        );
        expect(handled.at(-1)).toBe("allowed");
      }),
  );
});

it.effect("separates host file URLs from readable attachment URLs", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.assetsCreateUrl> =>
          tag !== WS_METHODS.assetsCreateUrl,
      ),
    );
    let handled = 0;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.assetsCreateUrl, () =>
            Effect.sync(() => {
              handled++;
              return { relativeUrl: "/api/assets/file", expiresAt: 1 };
            }),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    yield* client[WS_METHODS.assetsCreateUrl]({
      resource: { _tag: "attachment", attachmentId: "image" },
    });
    yield* client[WS_METHODS.assetsCreateUrl]({
      resource: { _tag: "native-app-icon", app: { _tag: "app-id", appId: "com.apple.calculator" } },
    });
    for (const resource of [
      { _tag: "workspace-file", threadId: ThreadId.make("thread"), path: "file.txt" },
      { _tag: "media-file", threadId: ThreadId.make("thread"), path: "/repo/image.png" },
      { _tag: "draft-workspace-file", cwd: "/repo", path: "file.txt" },
      { _tag: "native-app-icon", app: { _tag: "app-path", path: "/private/Secret.app" } },
    ] as const) {
      expect(
        yield* client[WS_METHODS.assetsCreateUrl]({ resource }).pipe(Effect.flip),
      ).toMatchObject({
        requiredScope: AuthOrchestrationReadScope,
        requiredPermission: AuthFilesystemReadScope,
      });
    }
    expect(handled).toBe(2);
  }),
);

it.effect("denies manual cleanup before the handler without settings permission", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.serverRunStorageCleanup
        > => tag !== WS_METHODS.serverRunStorageCleanup,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.serverRunStorageCleanup, () =>
            Effect.sync(() => {
              handled = true;
              return {
                trigger: "manual" as const,
                startedAt: "2026-10-09T12:00:00.000Z",
                finishedAt: "2026-10-09T12:00:00.000Z",
                entries: [],
                counts: { removed: 0, kept: 0, failed: 0 },
                omittedCount: 0,
                bytesFreed: 0,
              };
            }),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    expect(yield* client[WS_METHODS.serverRunStorageCleanup]({}).pipe(Effect.flip)).toMatchObject({
      requiredPermission: AuthSettingsWriteScope,
    });
    expect(handled).toBe(false);
  }),
);

it.effect("requires filesystem read authority before inspecting host metadata", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.filesystemGetMetadata
        > => tag !== WS_METHODS.filesystemGetMetadata,
      ),
    );
    const inspected: string[][] = [];
    const handlers = group.toLayerHandler(WS_METHODS.filesystemGetMetadata, (input) =>
      Effect.sync(() => {
        inspected.push([...input.paths]);
        return { entries: [{ kind: "directory" as const }] };
      }),
    );
    const clientWith = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
      RpcTest.makeClient(group).pipe(
        Effect.provide(Layer.mergeAll(handlers, RpcAuthorization.layer(scopes))),
      );
    const operator = yield* clientWith([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]);
    expect(
      yield* operator[WS_METHODS.filesystemGetMetadata]({ paths: ["/tmp/metadata-fixture"] }).pipe(
        Effect.flip,
      ),
    ).toMatchObject({ requiredPermission: AuthFilesystemReadScope });
    expect(inspected).toEqual([]);
    const reader = yield* clientWith([AuthFilesystemReadScope]);
    expect(
      yield* reader[WS_METHODS.filesystemGetMetadata]({ paths: ["/tmp/metadata-fixture"] }),
    ).toEqual({ entries: [{ kind: "directory" }] });
    expect(inspected).toEqual([["/tmp/metadata-fixture"]]);
  }).pipe(Effect.scoped),
);

it.effect("requires settings authority as well as project authority for script mutations", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.projectsMutate> =>
          tag !== WS_METHODS.projectsMutate,
      ),
    );
    let handled = 0;
    const handlers = group.toLayerHandler(WS_METHODS.projectsMutate, (mutation) =>
      Effect.sync(() => {
        handled++;
      }).pipe(
        Effect.andThen(
          Effect.fail(
            new ProjectMutationError({
              commandId: mutation.commandId,
              message: "Synthetic project-store failure after authorization.",
            }),
          ),
        ),
      ),
    );
    const clientWith = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
      RpcTest.makeClient(group).pipe(
        Effect.provide(Layer.mergeAll(handlers, RpcAuthorization.layer(scopes))),
      );
    const mutation = {
      type: "project.update" as const,
      commandId: CommandId.make("command:script-scope"),
      projectId: ProjectId.make("project:script-scope"),
      scripts: [],
    };
    const operator = yield* clientWith([AuthOrchestrationOperateScope]);
    expect(yield* operator[WS_METHODS.projectsMutate](mutation).pipe(Effect.flip)).toMatchObject({
      requiredPermission: AuthSettingsWriteScope,
    });
    const settingsWriter = yield* clientWith([AuthSettingsWriteScope]);
    expect(
      yield* settingsWriter[WS_METHODS.projectsMutate](mutation).pipe(Effect.flip),
    ).toMatchObject({
      requiredPermission: AuthOrchestrationOperateScope,
    });
    expect(handled).toBe(0);
    const authorized = yield* clientWith([AuthOrchestrationOperateScope, AuthSettingsWriteScope]);
    expect(yield* authorized[WS_METHODS.projectsMutate](mutation).pipe(Effect.flip)).toMatchObject({
      _tag: "ProjectMutationError",
    });
    expect(handled).toBe(1);
    const ordinary = { ...mutation, scripts: undefined, title: "Renamed" };
    expect(yield* operator[WS_METHODS.projectsMutate](ordinary).pipe(Effect.flip)).toMatchObject({
      _tag: "ProjectMutationError",
    });
    expect(handled).toBe(2);
  }).pipe(Effect.scoped),
);

it.effect("requires provider management to send /logout through chat", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof ORCHESTRATION_V2_WS_METHODS.dispatchCommand
        > => tag !== ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
      ),
    );
    const handled: string[] = [];
    const handler = group.toLayerHandler(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, (command) =>
      Effect.sync(() => {
        handled.push(command.commandId);
        return { sequence: 1 };
      }),
    );
    const message = (commandId: string, text: string) => ({
      type: "message.dispatch" as const,
      createdBy: "user" as const,
      creationSource: "web" as const,
      commandId: CommandId.make(commandId),
      threadId: ThreadId.make("thread"),
      messageId: MessageId.make(commandId),
      text,
      attachments: [],
      dispatchMode: { type: "start_immediately" as const },
    });
    const edit = (commandId: string) => ({
      type: "queued-run.edit" as const,
      commandId: CommandId.make(commandId),
      threadId: ThreadId.make("thread"),
      runId: RunId.make("run"),
      text: "/logout",
    });
    // With an attachment, `/logout` reaches the provider as a prompt, not a sign-out.
    const attachments = [
      { type: "image" as const, id: "shot", name: "shot.png", mimeType: "image/png", sizeBytes: 1 },
    ];
    const operator = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(Layer.merge(handler, RpcAuthorization.layer([AuthOrchestrationOperateScope]))),
    );
    const dispatch = operator[ORCHESTRATION_V2_WS_METHODS.dispatchCommand];
    yield* dispatch(message("hello", "hello"));
    yield* dispatch({ ...message("attached", "/logout"), attachments });
    yield* dispatch({ ...edit("attached-edit"), attachments });
    // This edit keeps the queued attachments; message intake decides it.
    yield* dispatch(edit("kept-attachments-edit"));
    for (const command of [message("logout", " /LOGOUT "), { ...edit("edit"), attachments: [] }]) {
      expect(yield* dispatch(command).pipe(Effect.flip)).toMatchObject({
        requiredPermission: AuthProvidersManageScope,
      });
    }
    const manager = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.merge(
          handler,
          RpcAuthorization.layer([AuthOrchestrationOperateScope, AuthProvidersManageScope]),
        ),
      ),
    );
    yield* manager[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](message("manager", "/logout"));
    expect(handled).toEqual([
      "hello",
      "attached",
      "attached-edit",
      "kept-attachments-edit",
      "manager",
    ]);
  }).pipe(Effect.scoped),
);
