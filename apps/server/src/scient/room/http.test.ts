import * as NodeServices from "@effect/platform-node/NodeServices";
import { ROOM_MESSAGE_MAX_LENGTH } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http";

import { readPost } from "./http.ts";

const post = (form: FormData) =>
  readPost.pipe(
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(
        new Request("http://localhost/api/room/messages", { method: "POST", body: form }),
      ),
    ),
  );

it.effect("keeps a JSON file a guest attaches as a file, not a form field", () =>
  Effect.gen(function* () {
    const form = new FormData();
    form.append("to", "people");
    form.append("text", "");
    form.append("file", new File(['{"a":1}'], "data.json", { type: "application/json" }));
    const submission = yield* post(form);
    assert.deepEqual(
      submission?.uploads.map((upload) => [upload.name, upload.contentType]),
      [["data.json", "application/json"]],
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps a multi-line form message within the length limit as the guest typed it", () =>
  Effect.gen(function* () {
    // At the limit with LF, over it once each line break is counted as CRLF.
    const lines = Array.from({ length: 50 }, () => "x".repeat(79));
    const text = lines.join("\n").padEnd(ROOM_MESSAGE_MAX_LENGTH, "x");
    const form = new FormData();
    form.append("to", "agent");
    form.append("text", text);
    const submission = yield* post(form);
    assert.strictEqual(submission?.fields.text, text);
    assert.strictEqual(submission?.fields.to, "agent");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
