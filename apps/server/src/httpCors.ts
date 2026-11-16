import { ORCHESTRATION_PROTOCOL_HEADER } from "@t3tools/contracts";
// SCIENT-FORK:START desktop-renderer-identity
import { SCIENT_DESKTOP_IDENTITY } from "@t3tools/shared/scientDesktopIdentity";
// SCIENT-FORK:END desktop-renderer-identity

export const browserApiCorsAllowedMethods = ["GET", "HEAD", "POST", "OPTIONS"] as const;
export const browserApiCorsAllowedHeaders = [
  "authorization",
  "b3",
  "traceparent",
  "content-type",
  "dpop",
  "range",
  ORCHESTRATION_PROTOCOL_HEADER,
] as const;
// SCIENT-FORK:START desktop-renderer-identity
export const DESKTOP_RENDERER_ORIGINS = [
  `${SCIENT_DESKTOP_IDENTITY.productionScheme}://app`,
  `${SCIENT_DESKTOP_IDENTITY.developmentScheme}://app`,
] as const;
// SCIENT-FORK:END desktop-renderer-identity

/** MCP refuses every browser Origin with 403, so the browser CORS layer must not answer for it. */
export const MCP_HTTP_PATH = "/mcp";
