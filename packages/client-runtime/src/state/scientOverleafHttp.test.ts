import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { layerRemoteHttpClient } from "../rpc/http.ts";
import { getEnvironmentOverleafStatus, syncEnvironmentOverleaf } from "./scientOverleafHttp.ts";

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
  it.effect("posts a sync with its workspace, link, request ID and choices", () =>
    Effect.gen(function* () {
      const server = recordingFetch({ _tag: "unsettled", reason: "folder-kept-changing" });
      const result = yield* syncEnvironmentOverleaf({
        prepared: PREPARED,
        request: {
          workspaceRoot: "/work/project",
          connectionId: "c1",
          requestId: "request-1",
          choices: [{ key: "k", choice: "markers" }],
        },
      }).pipe(Effect.provide(layerRemoteHttpClient(server.fetchFn)));
      expect(result).toEqual({ _tag: "unsettled", reason: "folder-kept-changing" });
      expect(server.requests).toEqual([
        {
          url: "https://environment.example.test/api/scient/overleaf/v1/sync",
          body: {
            workspaceRoot: "/work/project",
            connectionId: "c1",
            requestId: "request-1",
            choices: [{ key: "k", choice: "markers" }],
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
});
