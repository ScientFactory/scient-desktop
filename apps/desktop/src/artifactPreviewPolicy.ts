// FILE: artifactPreviewPolicy.ts
// Purpose: Pure Electron-level network and navigation policy for untrusted artifact tabs.

const DENIED_RESOURCE_TYPES = new Set([
  "subFrame",
  "webSocket",
  "object",
  "ping",
  "worker",
  "sharedWorker",
  "serviceWorker",
]);

export function artifactPreviewRequestAllowed(input: {
  url: string;
  allowedOrigin: string;
  resourceType: string;
}): boolean {
  if (DENIED_RESOURCE_TYPES.has(input.resourceType)) {
    return false;
  }
  try {
    const requestUrl = new URL(input.url);
    return (
      requestUrl.protocol === "data:" ||
      requestUrl.protocol === "blob:" ||
      requestUrl.origin === input.allowedOrigin
    );
  } catch {
    return false;
  }
}

export function artifactPreviewNavigationAllowed(input: {
  url: string;
  allowedOrigin: string;
  isMainFrame: boolean;
}): boolean {
  if (!input.isMainFrame) {
    return false;
  }
  try {
    return new URL(input.url).origin === input.allowedOrigin;
  } catch {
    return false;
  }
}
