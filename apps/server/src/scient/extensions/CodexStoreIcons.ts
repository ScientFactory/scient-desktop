import { extensionIconData } from "./ExtensionIconData.ts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import {
  makeConnectorFetch,
  STRICT_EGRESS_POLICY,
  type ConnectorFetch,
} from "./connectors/ConnectorOutbound.ts";

const MAX_ICON_BYTES = 64 * 1024;
const fetchIcon = makeConnectorFetch({
  policy: STRICT_EGRESS_POLICY,
  redirect: "error",
  timeoutMs: 5_000,
  maxResponseBytes: MAX_ICON_BYTES,
});

export function makeCodexStoreIcons(fetch: ConnectorFetch = fetchIcon) {
  const cache = new Map<string, { readonly value: string | undefined; readonly at: number }>();
  return Effect.fn("CodexStoreIcons.read")(function* (url: string | null | undefined) {
    if (!url) return undefined;
    let parsed: URL;
    try {
      parsed = new URL(url, "https://chatgpt.com");
    } catch {
      return undefined;
    }
    if (
      parsed.protocol !== "https:" ||
      !(
        parsed.hostname === "files.openai.com" ||
        (parsed.hostname === "chatgpt.com" && parsed.pathname.startsWith("/images/ecosystem/apps/"))
      ) ||
      parsed.username ||
      parsed.password ||
      parsed.port
    )
      return undefined;
    const key = parsed.href;
    const now = yield* Clock.currentTimeMillis;
    const cached = cache.get(key);
    if (cached && now - cached.at < 3_600_000) return cached.value;
    const value = yield* Effect.tryPromise(async (signal) => {
      const response = await fetch(key, {
        signal,
        headers: { accept: "image/png,image/jpeg,image/webp,image/svg+xml" },
      });
      if (!response.ok) {
        await response.body?.cancel();
        return undefined;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_ICON_BYTES) return undefined;
      const mime = response.headers.get("content-type")?.split(";")[0]?.trim();
      return extensionIconData(bytes, mime ?? "");
    }).pipe(Effect.orElseSucceed(() => undefined));
    cache.delete(key);
    cache.set(key, { value, at: now });
    while (cache.size > 256) cache.delete(cache.keys().next().value!);
    return value;
  });
}
