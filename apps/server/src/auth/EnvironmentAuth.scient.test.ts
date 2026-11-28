import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

const desktopToken = "synthetic-desktop-bootstrap-token";

const layerEnvironmentAuth = EnvironmentAuth.layer.pipe(
  Layer.provide(ManagedPolicy.layerTest()),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(
    Layer.effect(
      ServerConfig.ServerConfig,
      ServerConfig.ServerConfig.pipe(
        Effect.map((config) => ({ ...config, desktopBootstrapToken: desktopToken })),
      ),
    ).pipe(
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "scient-auth-subject-test-" })),
    ),
  ),
);

it.layer(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer))(
  "EnvironmentAuth, Scient",
  (it) => {
    it.effect("only the desktop app's own sign-in issues its subject", () =>
      Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        // regression: `scient auth session issue --subject desktop-bootstrap` minted a bearer
        // that Accounts took for this computer's desktop.
        const refused = yield* Effect.flip(
          auth.issueSession({ subject: EnvironmentAuth.DESKTOP_APP_SUBJECT }),
        );
        expect(refused._tag).toBe("ServerAuthReservedSubjectError");
        expect(refused.message).toBe(
          'The session subject "desktop-bootstrap" is reserved for the desktop app\'s own sign-in.',
        );
        expect(
          (yield* auth.listSessions()).some(
            (session) => session.subject === EnvironmentAuth.DESKTOP_APP_SUBJECT,
          ),
        ).toBe(false);
        // Any other subject still issues; the desktop's verified sign-in still has its own.
        expect((yield* auth.issueSession({ subject: "cli" })).subject).toBe("cli");
        const desktop = yield* auth.exchangeBootstrapCredentialForAccessToken(
          desktopToken,
          ["orchestration:read"],
          { deviceType: "desktop" },
        );
        const session = yield* auth.authenticateHttpRequest({
          cookies: {},
          headers: { authorization: `Bearer ${desktop.access_token}` },
        } as unknown as Parameters<typeof auth.authenticateHttpRequest>[0]);
        expect(session.subject).toBe(EnvironmentAuth.DESKTOP_APP_SUBJECT);
      }).pipe(Effect.provide(layerEnvironmentAuth)),
    );
  },
);
