# Scient analytics and identity

Scient sends telemetry through ScientFactory's first-party gateway at `events.scientfactory.com`. The gateway stores canonical events in a ScientFactory-owned Cloudflare D1 database before any optional PostHog forwarding.

## User controls

The server-authoritative `telemetryPrivacyLevel` setting is available under **Settings → Data & Privacy**:

| Level          | Behavior                                                                   |
| -------------- | -------------------------------------------------------------------------- |
| `off`          | No analytics events leave the installation.                                |
| `essential`    | Basic reliability events only. This is the default.                        |
| `product`      | Essential events plus product and workflow usage.                          |
| `diagnostic`   | Product events plus bounded technical diagnostics.                         |
| `contribution` | Diagnostic events plus events from separately explicit contribution flows. |

Lowering the setting immediately prevents higher-level buffered events from being sent. `SYNARA_TELEMETRY_ENABLED=false` remains an emergency and test override that disables the transport completely.

## Identity

Each installation receives a random UUID stored in Scient's state directory as `anonymous-id`; transport prefixes it with `installation:`. Each server process creates a new random `session:` UUID. Neither value is derived from the user's name, email, device fingerprint, project, files, or connected provider accounts.

Future Scient accounts may link an installation to an opaque `account:` UUID through the gateway's authenticated service-to-service endpoint. Desktop clients cannot claim account identifiers directly. ScientFactory's database remains the canonical identity map; PostHog receives only opaque aliases.

## Content boundary

The analytics layer allowlists primitive product properties. Normal telemetry excludes prompts, messages, research documents, source text, filenames, file paths, project names, thread identifiers, provider account identifiers, credentials, and generated scientific content. Contribution-level content requires a separate explicit action and must not be added to ordinary `AnalyticsService.record` properties.

## Event classification

`server.boot.heartbeat` is `essential`. Existing `provider.*` workflow events are `product`. New diagnostic or contribution events should extend the typed capture contract with an explicit required level before being introduced; event names must not silently infer a less restrictive category.
