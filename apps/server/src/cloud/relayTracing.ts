import * as RelayTracing from "@t3tools/shared/relayTracing";
import { SCIENT_DESKTOP_IDENTITY } from "@t3tools/shared/scientDesktopIdentity";

import { resolveRelayClientTracingConfig } from "./publicConfig.ts";

const relayClientTracingConfig = SCIENT_DESKTOP_IDENTITY.outboundTelemetryEnabled
  ? resolveRelayClientTracingConfig()
  : null;

export const layerHeadlessRelayClient = RelayTracing.layer(relayClientTracingConfig, {
  serviceName: "t3code-server",
  runtime: "node",
  client: "headless-cli",
});

export const layerServerRelayBroker = RelayTracing.layer(relayClientTracingConfig, {
  serviceName: "t3code-server",
  runtime: "node",
  client: "environment-server",
  component: "relay-broker",
});
