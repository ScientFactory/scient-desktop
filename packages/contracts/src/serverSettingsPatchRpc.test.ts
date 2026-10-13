import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProviderInstanceId } from "./providerInstance.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";
import type { ServerSettingsPatch } from "./settings.ts";
import { ThreadSectionId } from "./baseSchemas.ts";

const payload = WsRpcGroup.requests.get(WS_METHODS.serverUpdateSettings)!.payloadSchema;
const encode = Schema.encodeSync(payload);
const decode = Schema.decodeUnknownSync(payload);
const legacyError = "The legacy providers patch is accepted from older clients only.";

describe("server.updateSettings payload encoding", () => {
  const ordinaryPatches = [
    ["empty patch", {}],
    [
      "section creation",
      {
        threadSections: [{ id: ThreadSectionId.make("research"), name: "Research", order: 0 }],
        threadSectionsGeneralIndex: 0,
        threadSectionsExpected: { threadSections: [], threadSectionsGeneralIndex: 0 },
      },
    ],
    ["ordinary setting", { responseStreamingMode: "turn" }],
    ["provider instances", { providerInstances: {} }],
    [
      "model visibility with curated seed",
      {
        setModelsHidden: [
          {
            provider: ProviderInstanceId.make("pi_remote"),
            model: "synthetic",
            hidden: true,
            initialPreferences: {
              hiddenModels: ["unsaved-hidden"],
              modelOrder: ["first", "synthetic"],
            },
          },
        ],
      },
    ],
    [
      "model order with explicitly empty seed",
      {
        setProviderModelOrder: {
          provider: ProviderInstanceId.make("pi_remote"),
          modelOrder: ["synthetic"],
          initialPreferences: { hiddenModels: [], modelOrder: [] },
        },
      },
    ],
  ] as const satisfies ReadonlyArray<readonly [string, ServerSettingsPatch]>;

  it.each(ordinaryPatches)("encodes %s without the legacy providers field", (_name, patch) => {
    const request = { patch };
    expect(encode(request)).toEqual(request);
    expect(encode(decode(request))).toEqual(request);
    expect(encode(request)).not.toHaveProperty("patch.providers");
  });

  it("encodes a provider mutation carried alongside an empty patch", () => {
    const request = {
      patch: {},
      providerInstanceMutation: {
        operation: "remove" as const,
        instanceId: ProviderInstanceId.make("codex_work"),
      },
    };
    expect(encode(request)).toEqual(request);
    expect(encode(decode(request))).toEqual(request);
  });

  it.each([
    ["empty map", {}],
    ["provider setting", { codex: { enabled: false } }],
    ["opaque legacy setting", { codex: { opaque: { revision: 2 } } }],
  ])("decodes %s from older clients but refuses to encode it", (_name, providers) => {
    const request = { patch: { providers } };
    const decoded = decode(request);
    expect(decoded).toEqual(request);
    expect(() => encode(decoded)).toThrow(legacyError);
  });

  it("rejects an explicitly supplied undefined legacy field", () => {
    expect(() => encode({ patch: { providers: undefined } })).toThrow(legacyError);
  });

  it("still validates ordinary fields at the RPC boundary", () => {
    expect(() => decode({ patch: { threadSectionsGeneralIndex: -1 } })).toThrow();
    expect(() => decode({ patch: { responseStreamingMode: "invalid" } })).toThrow();
  });
});
