// This expression runs inside the packaged renderer through Electron's
// executeJavaScript boundary. Keep it data-only so the release verifier can
// exercise the exact expression without importing the Electron main process.
export const PACKAGED_RENDERER_READINESS_EXPRESSION =
  "document.readyState === 'complete' && document.documentElement.dataset.scientRendererReady === 'true'";
