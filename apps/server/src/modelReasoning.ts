// @effect-diagnostics globalTimers:off -- This injected Promise/fetch API owns and clears its transport deadline.
// @effect-diagnostics globalDate:off -- Injectable epoch clock records portable ISO evidence timestamps.
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import type {
  CustomModelProtocol,
  ModelReasoningLevel,
  ModelReasoningMetadata,
} from "@t3tools/contracts";

export interface ModelReasoningResolveInput {
  baseUrl: string;
  protocol: CustomModelProtocol;
  modelId: string;
  apiKey?: string;
  credentialId?: string;
}

const TTL = 60 * 60 * 1000;
const NEGATIVE_TTL = 60 * 1000;
const MAX_ENTRIES = 128;
const MAX_PENDING = 16;
const TIMEOUT = 5_000;
const MAX_BYTES = 8 * 1024 * 1024;
const REVIEWED_AT = "2026-09-06T00:00:00.000Z";
const CATALOG_TTL = 30 * 24 * TTL;
const LEVELS: readonly ModelReasoningLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
type Evidence = Omit<ModelReasoningMetadata, "checkedAt" | "stale" | "source">;

// Reviewed 2026-09-06. Exact IDs only; snapshots/aliases require their own review.
// https://developers.openai.com/api/docs/models/gpt-6-astra
// https://developers.openai.com/api/docs/models/gpt-5.6-luna
// https://developers.openai.com/api/docs/models/gpt-4.1
// https://developers.openai.com/api/docs/models/gpt-5.1
// https://developers.openai.com/api/docs/models/gpt-5.2
// https://developers.openai.com/api/docs/models/gpt-5.4
// https://developers.openai.com/api/docs/models/gpt-5.5
// `off` is the normalized spelling of the documented API value `none`.
const openAiCatalog = new Map<string, Evidence>([
  [
    "gpt-6-astra",
    {
      status: "known",
      supported: true,
      levels: ["low", "medium", "high", "xhigh", "max"],
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      images: true,
      mandatory: true,
      mode: "effort",
    },
  ],
  [
    "gpt-5.6-luna",
    {
      status: "known",
      supported: true,
      levels: ["off", "low", "medium", "high", "xhigh", "max"],
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      images: true,
      defaultLevel: "medium",
      mandatory: false,
      mode: "effort",
    },
  ],
  [
    "gpt-4.1",
    {
      status: "known",
      supported: false,
      levels: [],
      contextWindow: 1_047_576,
      maxOutputTokens: 32_768,
      images: true,
    },
  ],
  ...(["gpt-5.1", "gpt-5.2", "gpt-5.4", "gpt-5.5"] as const).map((id): [string, Evidence] => [
    id,
    {
      status: "known",
      supported: true,
      mode: "effort",
      mandatory: false,
      levels:
        id === "gpt-5.1"
          ? ["off", "low", "medium", "high"]
          : ["off", "low", "medium", "high", "xhigh"],
      defaultLevel: id === "gpt-5.5" ? "medium" : "off",
      contextWindow: id === "gpt-5.1" || id === "gpt-5.2" ? 400_000 : 1_050_000,
      maxOutputTokens: 128_000,
      images: true,
    },
  ]),
]);
// https://docs.x.ai/developers/model-capabilities/text/reasoning
// https://docs.x.ai/developers/models/grok-4.5
// https://docs.x.ai/developers/models/grok-4.6
// These exact model pages report context and image input, but no output token limit.
// xhigh on 4.5 aliases high; do not advertise it as a distinct level.
// Multi-agent effort controls agent count, so it is not in this reasoning catalog.
const xAiCatalog = new Map<string, Evidence>([
  [
    "grok-4.5",
    {
      status: "known",
      supported: true,
      levels: ["low", "medium", "high"],
      contextWindow: 500_000,
      images: true,
      defaultLevel: "high",
      mandatory: true,
      mode: "effort",
    },
  ],
  [
    "grok-4.6",
    {
      status: "known",
      supported: true,
      levels: ["low", "medium", "high", "xhigh"],
      contextWindow: 500_000,
      images: true,
      defaultLevel: "high",
      mandatory: true,
      mode: "effort",
    },
  ],
]);

const unknown = (detail: string, supported: boolean | null = null): Evidence => ({
  status: "unknown",
  supported,
  levels: [],
  detail,
});
const Support = Schema.Struct({ supported: Schema.Boolean });
const optionalSupport = Schema.optionalKey(Schema.NullOr(Support));
const isPositiveLimit = Schema.is(Schema.Int.check(Schema.isGreaterThan(0)));
type ModelCapabilities = Pick<Evidence, "contextWindow" | "maxOutputTokens" | "images">;
function modelCapabilities(
  contextWindow: unknown,
  maxOutputTokens: unknown,
  images: boolean | undefined,
): ModelCapabilities {
  return {
    ...(isPositiveLimit(contextWindow) ? { contextWindow } : {}),
    ...(isPositiveLimit(maxOutputTokens) ? { maxOutputTokens } : {}),
    ...(images !== undefined ? { images } : {}),
  };
}
const hasModelCapabilities = (value: ModelCapabilities) =>
  value.contextWindow !== undefined ||
  value.maxOutputTokens !== undefined ||
  value.images !== undefined;
const AnthropicModel = Schema.Struct({
  id: Schema.NonEmptyString,
  // Invalid optional limits must not discard independently verified reasoning controls.
  max_input_tokens: Schema.optionalKey(Schema.Unknown),
  max_tokens: Schema.optionalKey(Schema.Unknown),
  capabilities: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        image_input: optionalSupport,
        thinking: Schema.optionalKey(
          Schema.NullOr(
            Schema.Struct({
              supported: Schema.Boolean,
              types: Schema.optionalKey(
                Schema.NullOr(
                  Schema.Struct({
                    adaptive: optionalSupport,
                    enabled: optionalSupport,
                  }),
                ),
              ),
            }),
          ),
        ),
        effort: Schema.optionalKey(
          Schema.NullOr(
            Schema.Struct({
              supported: Schema.Boolean,
              low: optionalSupport,
              medium: optionalSupport,
              high: optionalSupport,
              xhigh: optionalSupport,
              max: optionalSupport,
            }),
          ),
        ),
      }),
    ),
  ),
});

// https://platform.claude.com/docs/en/api/models/retrieve
// The endpoint explicitly resolves aliases; returned id need not equal the requested alias.
// Capabilities do not establish mandatory thinking or a default. Never synthesize either.
const decodeAnthropic = Schema.decodeUnknownSync(AnthropicModel);
function parseAnthropic(body: unknown): Evidence {
  const model = decodeAnthropic(body);
  return {
    ...parseAnthropicReasoning(model.capabilities),
    // Use the reported input ceiling conservatively. It is not evidence that input + output
    // can exceed this budget; never add the output ceiling to invent a combined capacity.
    ...modelCapabilities(
      model.max_input_tokens,
      model.max_tokens,
      model.capabilities?.image_input?.supported,
    ),
  };
}
function parseAnthropicReasoning(
  capabilities: (typeof AnthropicModel.Type)["capabilities"],
): Evidence {
  const thinking = capabilities?.thinking;
  const effort = capabilities?.effort;
  if (!thinking) return unknown("Thinking capabilities are unavailable.");
  if (!thinking.supported) {
    return effort?.supported
      ? unknown("Conflicting thinking capabilities.")
      : { status: "known", supported: false, levels: [] };
  }
  const isAdaptive = thinking.types?.adaptive?.supported === true;
  if (!isAdaptive) {
    return {
      ...unknown(
        "Nonadaptive thinking requires budget-specific transport and UI controls; effort labels cannot safely configure it.",
        true,
      ),
      mode: "budget",
    };
  }
  const levels = effort?.supported
    ? (["low", "medium", "high", "xhigh", "max"] as const).filter(
        (level) => effort[level]?.supported === true,
      )
    : [];
  return {
    status: levels.length > 0 ? "known" : "unknown",
    supported: true,
    levels,
    mode: "adaptive",
    ...(!levels.length
      ? { detail: "Reasoning is supported; available controls are not fully reported." }
      : {}),
  };
}

const GatewayEffort = Schema.Literals(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const RouterModel = Schema.Struct({
  id: Schema.String,
  context_length: Schema.optionalKey(Schema.Unknown),
  top_provider: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        max_completion_tokens: Schema.optionalKey(Schema.Unknown),
      }),
    ),
  ),
  architecture: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        input_modalities: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
      }),
    ),
  ),
  supported_parameters: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  reasoning: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        supported_efforts: Schema.optionalKey(Schema.NullOr(Schema.Array(GatewayEffort))),
        default_effort: Schema.optionalKey(Schema.NullOr(GatewayEffort)),
        default_enabled: Schema.optionalKey(Schema.Boolean),
        mandatory: Schema.optionalKey(Schema.Boolean),
        supports_max_tokens: Schema.optionalKey(Schema.Boolean),
      }),
    ),
  ),
});
const RouterEnvelope = Schema.Struct({ data: Schema.Array(Schema.Unknown) });
const RouterIdentity = Schema.Struct({ id: Schema.String });
const decodeRouterEnvelope = Schema.decodeUnknownSync(RouterEnvelope);
const decodeRouterIdentity = Schema.decodeUnknownSync(RouterIdentity);
const decodeRouterModel = Schema.decodeUnknownSync(RouterModel);

// https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
// Missing ladder != null: missing exposes no effort selector; null accepts gateway values,
// which may map to the same native effort. Absence of reasoning also occurs on dynamic routers.
function parseOpenRouter(body: unknown, modelId: string): Evidence {
  const { data } = decodeRouterEnvelope(body);
  const matches = data.filter((entry) => {
    try {
      return decodeRouterIdentity(entry).id === modelId;
    } catch {
      return false;
    }
  });
  if (matches.length !== 1) return unknown("No unique exact model entry in the catalog.");
  const model = decodeRouterModel(matches[0]);
  // https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties
  const capabilities = modelCapabilities(
    model.context_length,
    model.top_provider?.max_completion_tokens,
    model.architecture?.input_modalities?.includes("image"),
  );
  const reasoning = model.reasoning;
  if (!reasoning)
    return {
      ...capabilities,
      ...unknown(
        "Reasoning controls are not reported for this model.",
        model.supported_parameters?.includes("reasoning") ? true : null,
      ),
    };
  const efforts = reasoning.supported_efforts;
  const levels =
    efforts === null
      ? [...LEVELS]
      : efforts === undefined
        ? []
        : LEVELS.filter((level) => efforts.includes(level === "off" ? "none" : level));
  const available = levels.filter((level) => level !== "off" || reasoning.mandatory !== true);
  const defaultLevel = reasoning.default_effort === "none" ? "off" : reasoning.default_effort;
  return {
    status: available.length > 0 ? "known" : "unknown",
    ...capabilities,
    supported: true,
    levels: available,
    ...(reasoning.mandatory !== undefined ? { mandatory: reasoning.mandatory } : {}),
    ...(available.length
      ? { mode: "effort" as const }
      : reasoning.supports_max_tokens === true
        ? { mode: "budget" as const }
        : {}),
    // default_effort is an enabling preset, not an effective default when disabled.
    ...(reasoning.default_enabled === false && available.includes("off")
      ? { defaultLevel: "off" as const }
      : defaultLevel &&
          available.includes(defaultLevel) &&
          reasoning.default_enabled !== false &&
          (reasoning.default_enabled === true || reasoning.mandatory === true)
        ? { defaultLevel }
        : {}),
    detail:
      !available.length && reasoning.supports_max_tokens === true
        ? "Reasoning requires budget-specific transport and UI controls; no effort selector is reported."
        : efforts === null
          ? "Gateway effort values are accepted; some may map to the same native level."
          : efforts === undefined
            ? "No effort selector is reported."
            : "Provider-reported gateway effort levels.",
  };
}

/** Allow literal official base URLs (optionally one trailing slash); no URL normalization of paths. */
function endpoint(input: ModelReasoningResolveInput) {
  const base = input.baseUrl.endsWith("/") ? input.baseUrl.slice(0, -1) : input.baseUrl;
  if (input.protocol === "anthropic-messages")
    return base === "https://api.anthropic.com" || base === "https://api.anthropic.com/v1"
      ? "https://api.anthropic.com/v1"
      : undefined;
  if (input.protocol !== "openai-completions" && input.protocol !== "openai-responses")
    return undefined;
  return [
    "https://openrouter.ai/api/v1",
    "https://api.openai.com/v1",
    "https://api.x.ai/v1",
  ].includes(base)
    ? base
    : undefined;
}

/** One deadline covers fetch, body streaming and parsing; never follow a credentialed redirect. */
async function fetchJson(
  fetcher: typeof globalThis.fetch,
  url: string,
  headers: Record<string, string>,
): Promise<unknown> {
  const controller = new AbortController();
  let reader: Pick<ReadableStreamDefaultReader<Uint8Array>, "read" | "cancel"> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Metadata request timed out."));
    }, TIMEOUT);
  });
  try {
    return await Promise.race([
      deadline,
      (async () => {
        const response = await fetcher(url, {
          method: "GET",
          headers,
          redirect: "error",
          signal: controller.signal,
        });
        if (!response.ok || response.redirected || (response.url && response.url !== url))
          throw new Error("Metadata request failed.");
        if (Number(response.headers.get("content-length")) > MAX_BYTES || !response.body)
          throw new Error("Invalid metadata response.");
        const bodyReader = response.body.getReader();
        reader = bodyReader;
        const decoder = new TextDecoder();
        let text = "";
        let bytes = 0;
        while (true) {
          const chunk = await bodyReader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_BYTES || controller.signal.aborted)
            throw new Error("Metadata response limit exceeded.");
          text += decoder.decode(chunk.value, { stream: true });
        }
        return JSON.parse(text + decoder.decode()) as unknown;
      })(),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
    // Do not await cancellation: a broken transport must not extend the deadline.
    void reader?.cancel().catch(() => {});
  }
}

/** Instance-local cache. now returns epoch milliseconds; fetch is injectable for offline tests. */
export function makeModelReasoningResolver(
  options: { fetch?: typeof globalThis.fetch; now?: () => number } = {},
) {
  const fetcher = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const salt = NodeCrypto.randomBytes(32);
  const cache = new Map<string, { value: ModelReasoningMetadata; expires: number }>();
  const pending = new Map<string, Promise<ModelReasoningMetadata>>();
  // Public catalog bytes carry no account evidence and are shared across keys/model IDs.
  type CatalogResult = { body: unknown; checkedAt: string };
  const catalogs = new Map<string, CatalogResult & { failed: boolean; expires: number }>();
  const catalogPending = new Map<string, Promise<CatalogResult>>();
  async function routerCatalog(scope: string, refresh: boolean): Promise<CatalogResult> {
    const cached = catalogs.get(scope);
    if (!refresh && cached && cached.expires > now()) {
      if (cached.failed) throw new Error("Catalog unavailable.");
      return cached;
    }
    const inflight = catalogPending.get(scope);
    if (inflight) return inflight;
    const request = (async () => {
      try {
        const body = await fetchJson(fetcher, "https://openrouter.ai/api/v1/models", {});
        decodeRouterEnvelope(body);
        catalogs.delete(scope);
        const result = { body, checkedAt: new Date(now()).toISOString() };
        catalogs.set(scope, { ...result, failed: false, expires: now() + TTL });
        return result;
      } catch {
        catalogs.delete(scope);
        catalogs.set(scope, {
          body: undefined,
          checkedAt: new Date(now()).toISOString(),
          failed: true,
          expires: now() + NEGATIVE_TTL,
        });
        throw new Error("Catalog unavailable.");
      } finally {
        // Bound future endpoint additions as well as individual response size.
        while (catalogs.size > 4) {
          const oldest = catalogs.keys().next().value;
          if (oldest !== undefined) catalogs.delete(oldest);
        }
      }
    })();
    catalogPending.set(scope, request);
    try {
      return await request;
    } finally {
      catalogPending.delete(scope);
    }
  }
  const stamp = (
    evidence: Evidence,
    source: ModelReasoningMetadata["source"],
  ): ModelReasoningMetadata => ({
    ...evidence,
    source,
    checkedAt: new Date(now()).toISOString(),
    stale: false,
  });
  const credentialScope = (input: ModelReasoningResolveInput) =>
    NodeCrypto.createHmac("sha256", salt)
      .update(JSON.stringify([input.credentialId ?? null, input.apiKey ?? null]))
      .digest("hex");
  function peek(input: ModelReasoningResolveInput): ModelReasoningMetadata {
    const base = endpoint(input);
    if (!base)
      return stamp(unknown("No metadata resolver for this endpoint or protocol."), "unknown");
    const catalog =
      base === "https://api.openai.com/v1"
        ? openAiCatalog
        : base === "https://api.x.ai/v1"
          ? xAiCatalog
          : undefined;
    const reviewed = catalog?.get(input.modelId);
    if (reviewed)
      return structuredClone({
        ...reviewed,
        source: "catalog" as const,
        checkedAt: REVIEWED_AT,
        stale: now() - Date.parse(REVIEWED_AT) >= CATALOG_TTL,
      });
    const scope = credentialScope(input);
    const cached = cache.get(JSON.stringify([base, input.protocol, input.modelId, scope]));
    if (cached)
      return structuredClone({
        ...cached.value,
        stale: cached.value.stale || cached.expires <= now(),
      });
    // A model switch can use the already fetched gateway catalog without starting IO.
    const gateway = catalogs.get(base);
    if (gateway && !gateway.failed) {
      try {
        return {
          ...stamp(parseOpenRouter(gateway.body, input.modelId), "provider"),
          checkedAt: gateway.checkedAt,
          stale: gateway.expires <= now(),
        };
      } catch {
        /* Malformed provider payloads are not diagnostics. */
      }
    }
    return stamp(unknown("No cached model reasoning evidence is available."), "unknown");
  }
  return {
    /** Synchronous, network-free fallback for an explicit setup deadline. */
    peek,
    async resolve(
      input: ModelReasoningResolveInput,
      refresh = false,
    ): Promise<ModelReasoningMetadata> {
      const base = endpoint(input);
      if (
        !base ||
        !input.modelId ||
        input.modelId === "." ||
        input.modelId === ".." ||
        input.modelId.length > 256 ||
        Array.from(input.modelId).some((character) => character.charCodeAt(0) < 32)
      ) {
        return stamp(
          unknown("No metadata resolver for this endpoint, protocol or model ID."),
          "unknown",
        );
      }
      const catalog =
        base === "https://api.openai.com/v1"
          ? openAiCatalog
          : base === "https://api.x.ai/v1"
            ? xAiCatalog
            : undefined;
      if (catalog) {
        const evidence = catalog.get(input.modelId);
        return evidence
          ? structuredClone({
              ...evidence,
              source: "catalog" as const,
              checkedAt: REVIEWED_AT,
              stale: now() - Date.parse(REVIEWED_AT) >= CATALOG_TTL,
            })
          : stamp(unknown("Exact model ID has not been reviewed in the catalog."), "unknown");
      }
      // Hash both identity and value: rotating a key under an unchanged credential ID isolates cache entries.
      // Neither raw keys nor credential IDs are retained in cache keys, diagnostics or returned metadata.
      const scope = credentialScope(input);
      const key = JSON.stringify([base, input.protocol, input.modelId, scope]);
      const previous = cache.get(key);
      if (!refresh && previous && previous.expires > now()) return structuredClone(previous.value);
      const inflight = pending.get(key);
      if (inflight) return structuredClone(await inflight);
      if (pending.size >= MAX_PENDING)
        return previous
          ? structuredClone({ ...previous.value, stale: true, detail: "Metadata refresh is busy." })
          : stamp(unknown("Metadata refresh is busy."), "unknown");
      const request = (async () => {
        let value: ModelReasoningMetadata;
        try {
          if (base === "https://api.anthropic.com/v1" && !input.apiKey) {
            value = stamp(unknown("An API key is required to read model capabilities."), "unknown");
          } else {
            if (base === "https://api.anthropic.com/v1") {
              const body = await fetchJson(
                fetcher,
                `${base}/models/${encodeURIComponent(input.modelId)}`,
                {
                  "x-api-key": input.apiKey!,
                  "anthropic-version": "2023-06-01",
                },
              );
              value = stamp(parseAnthropic(body), "provider");
            } else {
              const result = await routerCatalog(base, refresh);
              value = {
                ...stamp(parseOpenRouter(result.body, input.modelId), "provider"),
                checkedAt: result.checkedAt,
              };
            }
            if (value.supported === null && previous && previous.value.supported !== null) {
              value = {
                ...previous.value,
                ...modelCapabilities(value.contextWindow, value.maxOutputTokens, value.images),
                stale: true,
                detail: "Refresh did not verify controls; retaining previous evidence.",
              };
            }
          }
        } catch {
          // Transport/schema errors can embed credentials or response bodies. Never expose their text.
          value =
            previous && (previous.value.supported !== null || hasModelCapabilities(previous.value))
              ? {
                  ...previous.value,
                  stale: true,
                  detail: "Metadata refresh failed; retaining previous evidence.",
                }
              : stamp(unknown("Model metadata could not be verified."), "unknown");
        }
        cache.delete(key);
        cache.set(key, {
          value,
          expires:
            (value.status === "known" || hasModelCapabilities(value)) && !value.stale
              ? Math.min(now() + TTL, Date.parse(value.checkedAt) + TTL)
              : now() + NEGATIVE_TTL,
        });
        while (cache.size > MAX_ENTRIES) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        return value;
      })();
      pending.set(key, request);
      try {
        return structuredClone(await request);
      } finally {
        pending.delete(key);
      }
    },
  };
}
