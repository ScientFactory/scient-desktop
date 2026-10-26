import { isExtensionIconDataUri } from "@t3tools/contracts";
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
      parsed = new URL(url);
    } catch {
      return undefined;
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "files.openai.com" ||
      parsed.username ||
      parsed.password ||
      parsed.port
    )
      return undefined;
    const now = yield* Clock.currentTimeMillis;
    const cached = cache.get(url);
    if (cached && now - cached.at < 3_600_000) return cached.value;
    const value = yield* Effect.tryPromise(async (signal) => {
      const response = await fetch(url, {
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
      const png =
        mime === "image/png" &&
        Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const jpeg =
        mime === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      const webp =
        mime === "image/webp" &&
        Buffer.from(bytes.subarray(0, 4)).toString() === "RIFF" &&
        Buffer.from(bytes.subarray(8, 12)).toString() === "WEBP";
      const svg =
        mime === "image/svg+xml" &&
        /^(?:<svg(?:\s|\/?>)|<\?xml(?:\s|\?))/.test(
          Buffer.from(bytes).toString("utf8").trimStart(),
        );
      if (!png && !jpeg && !webp && !svg) return undefined;
      const data = `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
      return isExtensionIconDataUri(data) ? data : undefined;
    }).pipe(Effect.orElseSucceed(() => undefined));
    cache.delete(url);
    cache.set(url, { value, at: now });
    while (cache.size > 256) cache.delete(cache.keys().next().value!);
    return value;
  });
}
