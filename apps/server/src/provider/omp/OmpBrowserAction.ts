/** Browser handoff links persist only their public origin and path. */
export const browserActionUrl = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? `${url.origin}${url.pathname}`
      : undefined;
  } catch {
    return undefined;
  }
};

export const browserActionText = (value: string) =>
  // Query punctuation is part of the URL: splitting there can leave an OAuth tail intact.
  value.replace(/https?:\/\/[^\s<>]+/giu, (url) => browserActionUrl(url) ?? "[invalid URL]");

const safeBrowserValue = (value: unknown): unknown => {
  if (typeof value === "string") return browserActionText(value);
  if (Array.isArray(value)) return value.map(safeBrowserValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      (key === "url" || key === "launchUrl") && typeof item === "string"
        ? (browserActionUrl(item) ?? "[invalid URL]")
        : safeBrowserValue(item),
    ]),
  );
};

/** Apply URL scrubbing only to browser-action diagnostics, preserving other authored content. */
export const browserActionDiagnostic = (value: unknown): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  if ("_tag" in value && value._tag === "Event" && "event" in value)
    return { ...value, event: browserActionDiagnostic(value.event) };
  if (
    "type" in value &&
    value.type === "extension_ui_request" &&
    "method" in value &&
    value.method === "open_url"
  )
    return safeBrowserValue(value);
  return value;
};
