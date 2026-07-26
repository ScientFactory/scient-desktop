// FILE: localHtmlPreviewPolicy.ts
// Purpose: Pure request/navigation policy for executable local HTML preview tabs.

import { BlockList, isIP } from "node:net";

const nonPublicIpv6 = new BlockList();
nonPublicIpv6.addSubnet("::", 128, "ipv6");
nonPublicIpv6.addSubnet("::1", 128, "ipv6");
nonPublicIpv6.addSubnet("::ffff:0:0", 96, "ipv6");
nonPublicIpv6.addSubnet("fc00::", 7, "ipv6");
nonPublicIpv6.addSubnet("fe80::", 10, "ipv6");
nonPublicIpv6.addSubnet("fec0::", 10, "ipv6");
nonPublicIpv6.addSubnet("ff00::", 8, "ipv6");
nonPublicIpv6.addSubnet("100::", 64, "ipv6");
nonPublicIpv6.addSubnet("2001:2::", 48, "ipv6");
nonPublicIpv6.addSubnet("2001:db8::", 32, "ipv6");

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
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 192 && second === 0) ||
    (first === 198 && (second === 18 || second === 19 || second === 51)) ||
    (first === 203 && second === 0 && octets[2] === 113) ||
    first >= 224
  );
}

export function isPrivateOrNonPublicIpAddress(value: string): boolean {
  const address =
    value
      .trim()
      .toLowerCase()
      .replace(/^\[|\]$/g, "")
      .split("%", 1)[0] ?? "";
  const family = isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return nonPublicIpv6.check(address, "ipv6");
  return false;
}

export function isLocalOrPrivateNetworkUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = normalizedHostname(url);
    return (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "localhost.localdomain" ||
      hostname.endsWith(".localhost.localdomain") ||
      isPrivateOrNonPublicIpAddress(hostname)
    );
  } catch {
    return true;
  }
}

export function localHtmlPreviewRequestAllowed(input: {
  url: string;
  allowedOrigin: string;
  allowedExternalUrls?: readonly string[];
  method?: string;
  resourceType?: string;
}): boolean {
  try {
    const requestUrl = new URL(input.url);
    if (requestUrl.origin === input.allowedOrigin) return true;
    if (
      input.resourceType === "mainFrame" ||
      input.resourceType === "subFrame" ||
      input.resourceType === "object"
    )
      return false;
    if (requestUrl.protocol === "data:" || requestUrl.protocol === "blob:") return true;
    if (requestUrl.protocol !== "http:" && requestUrl.protocol !== "https:") {
      return false;
    }
    const method = input.method?.toUpperCase() ?? "GET";
    if (method !== "GET" && method !== "HEAD") return false;
    if (input.resourceType === "xhr") return false;
    if (input.resourceType === "ping" || input.resourceType === "webSocket") return false;
    const normalizedRequestUrl = new URL(requestUrl.toString());
    normalizedRequestUrl.hash = "";
    const explicitlyDeclared = (input.allowedExternalUrls ?? []).some((allowedUrl) => {
      try {
        const normalizedAllowedUrl = new URL(allowedUrl);
        normalizedAllowedUrl.hash = "";
        return normalizedAllowedUrl.toString() === normalizedRequestUrl.toString();
      } catch {
        return false;
      }
    });
    return explicitlyDeclared && !isLocalOrPrivateNetworkUrl(requestUrl.toString());
  } catch {
    return false;
  }
}

export function localHtmlPreviewResolvedAddressesAllowed(addresses: readonly string[]): boolean {
  return (
    addresses.length > 0 && addresses.every((address) => !isPrivateOrNonPublicIpAddress(address))
  );
}

export type LocalHtmlPreviewNavigationDisposition = "allow" | "deny";

export function localHtmlPreviewNavigationDisposition(input: {
  url: string;
  allowedOrigin: string;
  isMainFrame: boolean;
}): LocalHtmlPreviewNavigationDisposition {
  try {
    const target = new URL(input.url);
    if (target.origin === input.allowedOrigin) return "allow";
    return "deny";
  } catch {
    return "deny";
  }
}
