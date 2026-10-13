import { ORCHESTRATION_PROTOCOL_HEADER, THREAD_SNAPSHOT_FORMAT_HEADER } from "@t3tools/contracts";
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
  THREAD_SNAPSHOT_FORMAT_HEADER,
] as const;
/** Origins of the Electron renderer, packaged and dev. */
// SCIENT-FORK:START desktop-renderer-identity
export const DESKTOP_RENDERER_ORIGINS = [
  `${SCIENT_DESKTOP_IDENTITY.productionScheme}://app`,
  `${SCIENT_DESKTOP_IDENTITY.developmentScheme}://app`,
] as const;
// SCIENT-FORK:END desktop-renderer-identity
