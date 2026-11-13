import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type ScientSourceDetailResult,
  ScientSourceNoteUpdateRequest,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { layerRemoteHttpClient } from "../rpc/http.ts";
import { updateEnvironmentScientSourceNote } from "./scientSourcesHttp.ts";

const decodeNoteRequest = Schema.decodeUnknownSync(ScientSourceNoteUpdateRequest);

const target = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Fixture",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const prepared: PreparedConnection = {
  environmentId: target.environmentId,
  label: target.label,
  httpBaseUrl: target.httpBaseUrl,
  socketUrl: "wss://environment.example.test/ws",
  httpAuthorization: null,
  target,
};
const record: ScientSourceDetailResult = {
  formatVersion: 1,
  projectId: "project_test",
  sourceId: "source_test",
  revision: 1,
  type: "article",
  title: "Fixture",
  creators: [],
  issuedRaw: null,
  issuedYear: null,
  identifiers: [],
  abstract: null,
  containerTitle: null,
  publisher: null,
  volume: null,
  issue: null,
  pages: null,
  language: null,
  url: null,
  tags: [],
  externalReferences: [],
  attachments: [],
  fieldProvenance: [],
  importedAt: "2026-11-13T00:00:00.000Z",
};

it.effect(
  "carries the checked note base, editing session and selected key through conflict and Keep mine",
  () =>
    Effect.gen(function* () {
      let stored = "Saved elsewhere";
      const requests: Array<ScientSourceNoteUpdateRequest> = [];
      const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        expect(request.url).toBe("https://environment.example.test/api/scient/sources/note/update");
        const body = decodeNoteRequest(await request.json());
        requests.push(body);
        const outcome = body.expectedNote === stored ? "updated" : "stale";
        if (outcome === "updated") stored = body.note ?? "";
        return Response.json({ outcome, record: { ...record, note: stored, projectNote: stored } });
      }) satisfies typeof fetch;
      const save = (expectedNote: string) =>
        updateEnvironmentScientSourceNote({
          prepared,
          root: "/project",
          sourceId: record.sourceId,
          expectedRevision: 1,
          note: "My draft",
          expectedNote,
          noteSession: "session-1",
          citationKey: "other2026",
        }).pipe(Effect.provide(layerRemoteHttpClient(fetchFn)));
      const conflict = yield* save("Original");
      expect(conflict.outcome).toBe("stale");
      const saved = yield* save(conflict.record.note!);
      expect(saved.outcome).toBe("updated");
      expect(stored).toBe("My draft");
      expect(requests).toMatchObject([
        { expectedNote: "Original", noteSession: "session-1", citationKey: "other2026" },
        { expectedNote: "Saved elsewhere", noteSession: "session-1", citationKey: "other2026" },
      ]);
    }),
);
