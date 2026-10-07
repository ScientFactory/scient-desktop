// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Schema from "effect/Schema";
import { ompTarget } from "../../provider/omp/OmpTarget.ts";
import { nativeOmpSession } from "../../provider/testUtils/nativeOmpSession.ts";
import { scriptedOmpRpc } from "../../provider/testUtils/scriptedOmpRpc.ts";
const decodeString = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.String));

it.live(
  "preserves native OMP Unicode fork bytes and images in private files and cleans only abandoned owned prompts",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "scient-native-fork-files-"),
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
        );
        const stateDir = NodePath.join(root, "state");
        const attachmentsDir = NodePath.join(root, "attachments");
        NodeFS.mkdirSync(attachmentsDir);
        const image = Buffer.alloc(9000, 1);
        const imagePath = NodePath.join(attachmentsDir, "fork-image.png");
        NodeFS.writeFileSync(imagePath, image);
        const text =
          "SCIENT_FORK_CONTEXT_JSON\n" + "שלום ".repeat(2000) + "\nCURRENT REQUEST: continue";
        const instanceId = ProviderInstanceId.make("native-fork-files");
        const threadId = ThreadId.make("native-fork-files-thread");
        let sessionDir = "";
        const open = (peer: ReturnType<typeof scriptedOmpRpc>) =>
          nativeOmpSession({
            root,
            stateDir,
            attachmentsDir,
            target: ompTarget,
            instanceId,
            threadId,
            binaryPath: "synthetic-omp",
            environment: { HOME: root },
            modelSelection: { instanceId, model: "test/vision" },
            makeProcess: (options) => {
              sessionDir = options.sessionDir ?? "";
              return peer.makeProcess(options);
            },
          });
        const peer = scriptedOmpRpc({
          models: [{ provider: "test", id: "vision", input: ["text", "image"] }],
          initial: { provider: "test", id: "vision" },
          maxFrameBytes: 8192,
        });
        const session = yield* open(peer);
        yield* session.start({
          text,
          attachments: [
            {
              type: "image",
              id: "fork-image",
              name: "fork-image.png",
              mimeType: "image/png",
              sizeBytes: image.length,
            },
          ],
        });
        yield* peer.promptDelivered();
        const sent = peer.state.prompts[0];
        expect(sent?.bytes).toBeLessThanOrEqual(8192);
        expect(sent?.frame.images ?? []).toHaveLength(0);
        const paths = [...(sent?.frame.message ?? "").matchAll(/"(?:[^"\\]|\\.)*"/gu)].map(
          (match) => decodeString(match[0]),
        );
        const context = paths.find((path) => path.endsWith(".txt"));
        if (!context) return yield* Effect.die("Missing private fork prompt path");
        expect(NodePath.relative(NodeFS.realpathSync(stateDir), context)).not.toMatch(/^\.\./u);
        expect(NodeFS.readFileSync(context, "utf8")).toBe(text);
        if ((yield* HostProcessPlatform) !== "win32")
          expect(NodeFS.statSync(context).mode & 0o777).toBe(0o600);
        expect(paths).toContain(NodeFS.realpathSync(imagePath));
        expect(sent?.frame.message).toContain("Read the entire conversation");
        yield* session.close;
        expect(NodeFS.existsSync(context)).toBe(false);
        expect(NodeFS.readFileSync(imagePath)).toEqual(image);
        const stale = [
          "scient-prompt-11111111-1111-4111-8111-111111111111.txt",
          "scient-context-22222222-2222-4222-8222-222222222222.txt",
        ];
        for (const name of stale)
          NodeFS.writeFileSync(NodePath.join(sessionDir, name), "abandoned history");
        const retained = ["user-notes.txt", "scient-prompt-custom.txt", "scient-context-notes.txt"];
        for (const name of retained) NodeFS.writeFileSync(NodePath.join(sessionDir, name), "keep");
        const freshPeer = scriptedOmpRpc({
          models: [],
          initial: { provider: "test", id: "vision" },
        });
        const fresh = yield* open(freshPeer);
        for (const name of stale)
          expect(NodeFS.existsSync(NodePath.join(sessionDir, name))).toBe(false);
        for (const name of retained)
          expect(NodeFS.readFileSync(NodePath.join(sessionDir, name), "utf8")).toBe("keep");
        yield* fresh.close;
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(HostProcessPlatform, HostProcessPlatform.defaultValue()),
        ),
      ),
    ),
);
