import * as Alchemy from "alchemy";
import { adopt } from "alchemy/AdoptPolicy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { retain } from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import * as NodeURL from "node:url";

export const workerName = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;
  return stage === "prod" ? "scient-feedback" : `scient-feedback-${stage}`;
});

/** Reports and the installations that sent them. Kept when the stack is removed. */
export const Reports = workerName.pipe(
  Effect.flatMap((name) =>
    Cloudflare.D1.Database("Reports", {
      name,
      migrations: NodeURL.fileURLToPath(new URL("../migrations", import.meta.url)),
    }).pipe(adopt(true), retain()),
  ),
);

/** Screenshots, logs and conversations people attached. Private; kept when the stack is removed. */
export const Attachments = workerName.pipe(
  Effect.flatMap((name) =>
    Cloudflare.R2.Bucket("Attachments", { name }).pipe(adopt(true), retain()),
  ),
);
