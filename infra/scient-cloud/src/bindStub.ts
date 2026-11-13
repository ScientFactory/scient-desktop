import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { CloudError } from "./CloudError.ts";

const isCloudError = Schema.is(CloudError);

type Method = (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown, Error>;

/**
 * A Durable Object stub as its plain API: calls run in the Worker's runtime context, and
 * anything but a revived `CloudError` (an RPC or storage failure) is a defect.
 */
export const bindStub = <Api extends object>(stub: Api, context: Alchemy.BaseRuntimeContext): Api =>
  new Proxy(stub, {
    get: (target, property) => {
      const method = Reflect.get(target, property) as Method;
      return (...args: ReadonlyArray<unknown>) =>
        method(...args).pipe(
          Effect.provideService(Alchemy.RuntimeContext, context),
          Effect.catchIf(
            (error) => !isCloudError(error),
            (error) => Effect.die(error),
          ),
        );
    },
  });
