import { makeRelayClientTracingLayer } from "@t3tools/shared/relayTracing";
import { SCIENT_NEXT_IDENTITY } from "@t3tools/shared/scientNextIdentity";

import { resolveRelayClientTracingConfig } from "./publicConfig.ts";

const relayClientTracingConfig = SCIENT_NEXT_IDENTITY.outboundTelemetryEnabled
  ? resolveRelayClientTracingConfig()
  : null;

export const headlessRelayClientTracingLayer = makeRelayClientTracingLayer(
  relayClientTracingConfig,
  {
    serviceName: "t3-headless-relay-client",
    runtime: "node",
    client: "headless-cli",
  },
);

export const serverRelayBrokerTracingLayer = makeRelayClientTracingLayer(relayClientTracingConfig, {
  serviceName: "t3-server",
  runtime: "node",
  client: "environment-server",
  component: "relay-broker",
});
