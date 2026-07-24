// FILE: localHtmlPreviewPolicy.ts
// Purpose: Pure request/navigation policy for executable local HTML preview tabs.

function normalizedHostname(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }
  const [first = -1, second = -1] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

export function isLocalOrPrivateNetworkUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = normalizedHostname(url);
    return (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "::" ||
      hostname === "::1" ||
      hostname.startsWith("fc") ||
      hostname.startsWith("fd") ||
      hostname.startsWith("fe8") ||
      hostname.startsWith("fe9") ||
      hostname.startsWith("fea") ||
      hostname.startsWith("feb") ||
      isPrivateIpv4(hostname)
    );
  } catch {
    return true;
  }
}

export function localHtmlPreviewRequestAllowed(input: {
  url: string;
  allowedOrigin: string;
}): boolean {
  try {
    const requestUrl = new URL(input.url);
    if (requestUrl.origin === input.allowedOrigin) return true;
    if (requestUrl.protocol === "data:" || requestUrl.protocol === "blob:") return true;
    if (
      requestUrl.protocol !== "http:" &&
      requestUrl.protocol !== "https:" &&
      requestUrl.protocol !== "ws:" &&
      requestUrl.protocol !== "wss:"
    ) {
      return false;
    }
    return !isLocalOrPrivateNetworkUrl(requestUrl.toString());
  } catch {
    return false;
  }
}

export type LocalHtmlPreviewNavigationDisposition = "allow" | "open-web" | "deny";

export function localHtmlPreviewNavigationDisposition(input: {
  url: string;
  allowedOrigin: string;
  isMainFrame: boolean;
}): LocalHtmlPreviewNavigationDisposition {
  if (!input.isMainFrame) return "allow";
  try {
    const target = new URL(input.url);
    if (target.origin === input.allowedOrigin) return "allow";
    if (
      (target.protocol === "http:" || target.protocol === "https:") &&
      !isLocalOrPrivateNetworkUrl(target.toString())
    ) {
      return "open-web";
    }
    return "deny";
  } catch {
    return "deny";
  }
}
