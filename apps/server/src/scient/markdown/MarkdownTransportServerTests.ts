import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import type * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "node:crypto";
import { assert, type Vitest } from "@effect/vitest";
import { ScientMarkdownImageUploadResult, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";

import type { ScientRpcServerTestHarness } from "../../server.test.ts";

const PNG_BYTES = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  ),
);
const PNG_REVISION = `sha256:${NodeCrypto.createHash("sha256").update(PNG_BYTES).digest("hex")}`;
const decodeImageUpload = Schema.decodeUnknownEffect(ScientMarkdownImageUploadResult);

function imageForm(cwd: string, fileName = "result.png") {
  const form = new FormData();
  form.set("cwd", cwd);
  form.set("documentRelativePath", "notes/report.md");
  form.set("file", new Blob([PNG_BYTES], { type: "image/png" }), fileName);
  return HttpBody.formData(form);
}

// Use the production registration/auth stack and real sockets, not handler mocks.
export function registerMarkdownTransportTests(
  it: Vitest.MethodsNonLive<NodeServices.NodeServices>,
  harness: ScientRpcServerTestHarness,
): void {
  const { buildAppUnderTest, exchangeAccessToken, getWsServerUrl, withWsRpcClient } = harness;

  it.effect("preserves Markdown revisions and competing saves across websocket RPC", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "scient-markdown-rpc-" });
      yield* buildAppUnderTest();
      const wsUrl = yield* getWsServerUrl("/ws");

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const input = { cwd, relativePath: "notes/תוצאות.md" };
            const original = "# Results\r\n\r\nתוצאה 😀\r\n";
            const created = yield* client[WS_METHODS.projectsWriteFile]({
              ...input,
              contents: original,
              createOnly: true,
            });
            const opened = yield* client[WS_METHODS.projectsReadFile](input);
            assert.equal(opened.contents, original);
            assert.equal(opened.revision, created.revision);

            const contents = ["# First\r\nתוצאה 😁\r\n", "# Second\r\nתוצאה 😀\r\n"];
            const results = yield* Effect.all(
              contents.map((value) =>
                client[WS_METHODS.projectsWriteFile]({
                  ...input,
                  contents: value,
                  expectedRevision: opened.revision,
                }).pipe(Effect.result),
              ),
              { concurrency: 2 },
            );
            assert.lengthOf(
              results.filter((result) => result._tag === "Success"),
              1,
            );
            const rejected = results.find((result) => result._tag === "Failure");
            if (rejected?._tag !== "Failure") return assert.fail("Expected a losing CAS write");
            assert.equal(rejected.failure._tag, "ProjectWriteFileError");
            if (rejected.failure._tag !== "ProjectWriteFileError") return;
            assert.equal(rejected.failure.failure, "revision_conflict");

            const winner = yield* client[WS_METHODS.projectsReadFile](input);
            const winnerIndex = results.findIndex((result) => result._tag === "Success");
            assert.equal(winner.contents, contents[winnerIndex]);
            assert.equal(rejected.failure.currentRevision, winner.revision);
            assert.equal(
              yield* fs.readFileString(path.join(cwd, input.relativePath)),
              winner.contents,
            );

            const retried = yield* client[WS_METHODS.projectsWriteFile]({
              ...input,
              contents: original,
              expectedRevision: winner.revision,
            });
            const reopened = yield* client[WS_METHODS.projectsReadFile](input);
            assert.equal(reopened.revision, retried.revision);
            assert.equal(reopened.contents, original);
          }),
        ),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("keeps Markdown create and rename failures non-destructive across websocket RPC", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "scient-markdown-rpc-" });
      yield* buildAppUnderTest();
      const wsUrl = yield* getWsServerUrl("/ws");

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const input = { cwd, relativePath: "draft.md" };
            const created = yield* client[WS_METHODS.projectsWriteFile]({
              ...input,
              contents: "# Draft\n",
              createOnly: true,
            });
            const duplicate = yield* client[WS_METHODS.projectsWriteFile]({
              ...input,
              contents: "must not replace",
              createOnly: true,
            }).pipe(Effect.flip);
            assert.equal(duplicate._tag, "ProjectWriteFileError");
            if (duplicate._tag !== "ProjectWriteFileError") return;
            assert.equal(duplicate.failure, "path_exists");
            assert.equal(yield* fs.readFileString(path.join(cwd, "draft.md")), "# Draft\n");

            yield* fs.writeFileString(path.join(cwd, "draft.md"), "# External edit\n");
            const stale = yield* client[WS_METHODS.projectsRenameFile]({
              ...input,
              destinationRelativePath: "final.md",
              expectedRevision: created.revision,
            }).pipe(Effect.flip);
            assert.equal(stale._tag, "ProjectRenameFileError");
            if (stale._tag !== "ProjectRenameFileError") return;
            assert.equal(stale.failure, "revision_conflict");
            assert.isFalse(yield* fs.exists(path.join(cwd, "final.md")));

            const refreshed = yield* client[WS_METHODS.projectsReadFile](input);
            yield* client[WS_METHODS.projectsWriteFile]({
              cwd,
              relativePath: "occupied.md",
              contents: "# Keep this\n",
              createOnly: true,
            });
            const collision = yield* client[WS_METHODS.projectsRenameFile]({
              ...input,
              destinationRelativePath: "occupied.md",
              expectedRevision: refreshed.revision,
            }).pipe(Effect.flip);
            assert.equal(collision._tag, "ProjectRenameFileError");
            if (collision._tag !== "ProjectRenameFileError") return;
            assert.equal(collision.failure, "path_exists");
            assert.equal(yield* fs.readFileString(path.join(cwd, "occupied.md")), "# Keep this\n");
            assert.equal(yield* fs.readFileString(path.join(cwd, "draft.md")), "# External edit\n");

            const renamed = yield* client[WS_METHODS.projectsRenameFile]({
              ...input,
              destinationRelativePath: "notes/final.md",
              expectedRevision: refreshed.revision,
            });
            const reopened = yield* client[WS_METHODS.projectsReadFile]({
              cwd,
              relativePath: renamed.destinationRelativePath,
            });
            assert.equal(reopened.contents, "# External edit\n");
            assert.equal(reopened.revision, renamed.revision);
            assert.equal(renamed.revision, refreshed.revision);
            assert.isFalse(yield* fs.exists(path.join(cwd, "draft.md")));
          }),
        ),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("uploads Markdown assets with bearer auth and collision-safe portable paths", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "scient-markdown-http-" });
      yield* buildAppUnderTest();
      const { response, body } = yield* exchangeAccessToken();
      assert.equal(response.status, 200);
      assert.isString(body.access_token);
      const headers = {
        authorization: `Bearer ${body.access_token}`,
        origin: "http://remote-client.test:3773",
      };

      for (const suffix of ["", "-2"]) {
        const uploaded = yield* HttpClient.post("/api/scient/markdown/images/upload", {
          headers,
          body: imageForm(cwd, "Result plot.png"),
        });
        assert.equal(uploaded.status, 200);
        assert.equal(uploaded.headers["access-control-allow-origin"], "*");
        const result = yield* uploaded.json.pipe(Effect.flatMap(decodeImageUpload));
        assert.equal(result.relativePath, `notes/assets/Result-plot${suffix}.png`);
        assert.equal(result.markdownSource, `assets/Result-plot${suffix}.png`);
        assert.equal(result.byteLength, PNG_BYTES.byteLength);
        assert.equal(result.mediaType, "image/png");
        assert.equal(result.revision, PNG_REVISION);
        assert.deepEqual(yield* fs.readFile(path.join(cwd, result.relativePath)), PNG_BYTES);
      }

      const invalid = yield* HttpClient.post("/api/scient/markdown/images/upload", {
        headers,
        body: imageForm(cwd, "wrong.jpg"),
      });
      assert.equal(invalid.status, 400);
      assert.include(yield* invalid.json, {
        _tag: "ScientMarkdownImageInvalidError",
        reason: "media_extension_mismatch",
      });
      assert.deepEqual((yield* fs.readDirectory(path.join(cwd, "notes/assets"))).toSorted(), [
        "Result-plot-2.png",
        "Result-plot.png",
      ]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "denies unauthenticated and read-only Markdown asset uploads without writing files",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "scient-markdown-http-" });
        yield* buildAppUnderTest();
        const unauthenticated = yield* HttpClient.post("/api/scient/markdown/images/upload", {
          body: imageForm(cwd),
        });
        assert.equal(unauthenticated.status, 401);
        assert.include(yield* unauthenticated.json, { _tag: "EnvironmentAuthInvalidError" });

        const { response, body } = yield* exchangeAccessToken(undefined, {
          scope: "orchestration:read",
        });
        assert.equal(response.status, 200);
        assert.equal(body.scope, "orchestration:read");
        assert.isString(body.access_token);
        const readOnly = yield* HttpClient.post("/api/scient/markdown/images/upload", {
          headers: { authorization: `Bearer ${body.access_token}` },
          body: imageForm(cwd),
        });
        assert.equal(readOnly.status, 403);
        assert.include(yield* readOnly.json, {
          _tag: "EnvironmentScopeRequiredError",
          requiredScope: "orchestration:operate",
        });
        assert.deepEqual(yield* fs.readDirectory(cwd), []);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
}
