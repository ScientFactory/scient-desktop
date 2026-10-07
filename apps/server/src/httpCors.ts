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
import { ORCHESTRATION_PROTOCOL_HEADER, THREAD_SNAPSHOT_FORMAT_HEADER } from "@t3tools/contracts";
