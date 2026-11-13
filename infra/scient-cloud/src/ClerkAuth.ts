import { createClerkClient, verifyToken } from "@clerk/backend";
import * as Effect from "effect/Effect";

import { cloudError } from "./CloudError.ts";
import type { PeopleAuth } from "./Services.ts";

const hasAudience = (audience: unknown, expected: string) =>
  typeof audience === "string"
    ? audience === expected
    : Array.isArray(audience) && audience.includes(expected);

/**
 * Clerk session JWTs from the `scient-relay` template, verified as the relay does
 * (`infra/relay/src/http/Api.ts`): signature through Clerk, audience checked again here.
 */
export const clerkPeopleAuth = (options: {
  readonly secretKey: string;
  readonly audience: string;
}): PeopleAuth["Service"] => {
  const client = createClerkClient({ secretKey: options.secretKey });
  return {
    verify: Effect.fn("ClerkPeopleAuth.verify")(function* (token: string) {
      const claims = yield* Effect.tryPromise({
        try: () => verifyToken(token, options),
        catch: () => cloudError("unauthorized", "Your sign-in has expired. Sign in again."),
      });
      if (!claims.sub || !hasAudience(claims.aud, options.audience)) {
        return yield* cloudError("unauthorized", "This sign-in is not for Scient.");
      }
      return { userId: claims.sub };
    }),
    verifiedEmails: Effect.fn("ClerkPeopleAuth.verifiedEmails")(function* (userId: string) {
      const user = yield* Effect.tryPromise({
        try: () => client.users.getUser(userId),
        catch: () => cloudError("forbidden", "Could not read this account's addresses."),
      }).pipe(Effect.option);
      if (user._tag === "None") return [];
      return user.value.emailAddresses
        .filter((address) => address.verification?.status === "verified")
        .map((address) => address.emailAddress.toLowerCase());
    }),
  };
};
