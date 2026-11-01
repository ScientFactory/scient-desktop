import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { layerRemoteHttpClient } from "../rpc/http.ts";
import {
  cancelEnvironmentOverleafSync,
  getEnvironmentOverleafStatus,
  syncEnvironmentOverleaf,
  undoEnvironmentOverleafSend,
} from "./scientOverleafHttp.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: "wss://environment.example.test/ws",
  httpAuthorization: null,
  target: TARGET,
};

/** A server that records each request and answers with `body`. */
function recordingFetch(body: unknown) {
  const requests: Array<{ readonly url: string; readonly body: unknown }> = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, body: await request.json() });
    return Response.json(body);
  }) satisfies typeof fetch;
  return { fetchFn, requests };
}

describe("scientOverleafHttp", () => {
  it.effect(
    "posts a sync with its workspace, link, request ID, choices and the reviewed tree",
    () =>
      Effect.gen(function* () {
        const server = recordingFetch({
          _tag: "unsettled",
          reason: "folder-kept-changing",
          retried: false,
          settled: null,
        });
        const result = yield* syncEnvironmentOverleaf({
          prepared: PREPARED,
          request: {
            workspaceRoot: "/work/project",
            connectionId: "c1",
            requestId: "request-1",
            choices: [{ key: "k", choice: "markers" }],
            reviewedRemote: "a".repeat(40),
          },
        }).pipe(Effect.provide(layerRemoteHttpClient(server.fetchFn)));
        expect(result).toEqual({
          _tag: "unsettled",
          reason: "folder-kept-changing",
          retried: false,
          settled: null,
        });
        expect(server.requests).toEqual([
          {
            url: "https://environment.example.test/api/scient/overleaf/v1/sync",
            body: {
              workspaceRoot: "/work/project",
              connectionId: "c1",
              requestId: "request-1",
              choices: [{ key: "k", choice: "markers" }],
              reviewedRemote: "a".repeat(40),
            },
          },
        ]);
      }),
  );

  it.effect("reads a link's status from the status route", () =>
    Effect.gen(function* () {
      const server = recordingFetch({
        connection: {
          connectionId: "c1",
          checkoutRoot: "/work/project",
          folder: "paper",
          projectId: "0123456789abcdef01234567",
          branch: "master",
          state: "active",
          completedSyncCount: 0,
          createdAt: "2026-10-24T10:00:00.000Z",
          updatedAt: "2026-10-24T10:00:00.000Z",
        },
        availability: "ready",
        reasons: [],
        local: { _tag: "read", changed: 0, deleted: 0, added: 0 },
        markerPaths: [],
        unresolvedSends: 0,
        keptCopies: 0,
        busy: false,
        linkedElsewhere: false,
        revision: 3,
      });
      const status = yield* getEnvironmentOverleafStatus({
        prepared: PREPARED,
        request: { workspaceRoot: "/work/project", connectionId: "c1" },
      }).pipe(Effect.provide(layerRemoteHttpClient(server.fetchFn)));
      expect(status.availability).toBe("ready");
      expect(server.requests.map((request) => request.url)).toEqual([
        "https://environment.example.test/api/scient/overleaf/v1/status",
      ]);
    }),
  );

  it.effect("asks a running sync to stop through the cancel route", () =>
    Effect.gen(function* () {
      const server = recordingFetch({ _tag: "requested", operationId: "op-1" });
      const result = yield* cancelEnvironmentOverleafSync({
        prepared: PREPARED,
        request: { workspaceRoot: "/work/project", connectionId: "c1" },
      }).pipe(Effect.provide(layerRemoteHttpClient(server.fetchFn)));
      expect(result).toEqual({ _tag: "requested", operationId: "op-1" });
      expect(server.requests).toEqual([
        {
          url: "https://environment.example.test/api/scient/overleaf/v1/cancel",
          body: { workspaceRoot: "/work/project", connectionId: "c1" },
        },
      ]);
    }),
  );

  it.effect("posts an undo with its send number, and reads what it put back", () =>
    Effect.gen(function* () {
      const server = recordingFetch({
        _tag: "undone",
        restored: ["main.tex"],
        removed: [],
        recreated: [],
        skipped: [{ path: "notes.tex", reason: "changed" }],
        outcome: "replan",
        sync: { _tag: "cancelled", stage: "before-prepare", retried: false, settled: null },
      });
      const result = yield* undoEnvironmentOverleafSend({
        prepared: PREPARED,
        request: {
          workspaceRoot: "/work/project",
          connectionId: "c1",
          requestId: "request-1",
          attemptNumber: 4,
        },
      }).pipe(Effect.provide(layerRemoteHttpClient(server.fetchFn)));
      expect(result).toMatchObject({
        _tag: "undone",
        outcome: "replan",
        sync: { _tag: "cancelled" },
      });
      expect(server.requests).toEqual([
        {
          url: "https://environment.example.test/api/scient/overleaf/v1/undo",
          body: {
            workspaceRoot: "/work/project",
            connectionId: "c1",
            requestId: "request-1",
            attemptNumber: 4,
          },
        },
      ]);
    }),
  );

  it.effect("keeps the server's typed refusal, with its fixed reason", () =>
    Effect.gen(function* () {
      const fetchFn = (async () =>
        Response.json(
          {
            _tag: "ScientOverleafOperationError",
            reason: "access-denied",
            message:
              "Overleaf refused the token, or this account has no Git access to the project.",
          },
          { status: 409 },
        )) satisfies typeof fetch;
      const failure = yield* syncEnvironmentOverleaf({
        prepared: PREPARED,
        request: { workspaceRoot: "/work/project", connectionId: "c1", requestId: "request-1" },
      }).pipe(Effect.provide(layerRemoteHttpClient(fetchFn)), Effect.flip);
      expect(failure._tag).toBe("ScientOverleafOperationError");
      expect(failure).toMatchObject({ reason: "access-denied" });
    }),
  );
});
