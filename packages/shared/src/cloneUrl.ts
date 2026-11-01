export type CloneProtocol = "ssh" | "https";

// SCIENT-FORK:START public-remote-url-redaction
/** Removes URL credentials and query tokens from public clone and repository metadata. */
export function redactRemoteUrl(remoteUrl: string): string {
  try {
    const url = new URL(remoteUrl);
    // Clone URLs have no legitimate query; when one is present it is a token.
    if (url.username.length === 0 && url.password.length === 0 && url.search.length === 0) {
      return remoteUrl;
    }
    url.username = "";
    url.password = "";
    url.search = "";
    return url.toString();
  } catch {
    return remoteUrl;
  }
}
// SCIENT-FORK:END public-remote-url-redaction

const SCP_LIKE_URL = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/;
const SSH_URL = /^ssh:\/\/(?:[^@/\s]+@)?([^:/\s]+)(:\d+)?\/(.+)$/;
const HTTPS_URL = /^https?:\/\/(?:[^@/\s]+@)?([^:/\s]+)(:\d+)?\/(.+)$/;

function parseCloneUrl(
  url: string,
): { protocol: CloneProtocol; host: string; path: string; customPort: boolean } | null {
  const trimmed = url.trim();
  const ssh = SSH_URL.exec(trimmed);
  if (ssh) return { protocol: "ssh", host: ssh[1]!, path: ssh[3]!, customPort: !!ssh[2] };
  const https = HTTPS_URL.exec(trimmed);
  if (https) return { protocol: "https", host: https[1]!, path: https[3]!, customPort: !!https[2] };
  const scp = SCP_LIKE_URL.exec(trimmed);
  if (scp) return { protocol: "ssh", host: scp[1]!, path: scp[2]!, customPort: false };
  return null;
}

export function cloneUrlProtocol(url: string): CloneProtocol | null {
  return parseCloneUrl(url)?.protocol ?? null;
}

/**
 * Rewrites a clone URL to the other protocol, because the target machine may
 * only have SSH keys or only an HTTPS credential helper. Returns null when the
 * URL cannot be rewritten safely, such as a custom port.
 */
export function cloneUrlForProtocol(url: string, protocol: CloneProtocol): string | null {
  const parsed = parseCloneUrl(url);
  if (!parsed) return null;
  if (parsed.protocol === protocol) return url.trim();
  if (parsed.customPort) return null;
  return protocol === "ssh"
    ? `git@${parsed.host}:${parsed.path}`
    : `https://${parsed.host}/${parsed.path}`;
}
