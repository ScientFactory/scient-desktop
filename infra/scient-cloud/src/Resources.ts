import * as Alchemy from "alchemy";
import { adopt } from "alchemy/AdoptPolicy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { retain } from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";

export const workerName = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;
  return stage === "prod" ? "scient-cloud" : `scient-cloud-${stage}`;
});

/** Synced copies (encrypted per user) and shared-link objects. Kept when the stack is removed. */
export const Storage = workerName.pipe(
  Effect.flatMap((name) =>
    Cloudflare.R2.Bucket("Storage", {
      name,
      lifecycleRules: [
        {
          id: "abandoned-uploads",
          abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 86400 } },
        },
      ],
    }).pipe(adopt(true), retain()),
  ),
);
