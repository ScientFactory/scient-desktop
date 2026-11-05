import { AccountId, PreviewTabId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import { SignInAttempts, layer, makeSignInAttempts } from "./signInAttempts.ts";

it.effect("runs one attempt per key at a time, and drops a lock nobody holds or waits for", () =>
  Effect.gen(function* () {
    const attempts = makeSignInAttempts();
    const gate = yield* Deferred.make<void>();
    const order: string[] = [];
    const first = yield* attempts
      .exclusive(
        "github|person",
        Deferred.await(gate).pipe(Effect.andThen(Effect.sync(() => order.push("first")))),
      )
      .pipe(Effect.forkChild);
    const second = yield* attempts
      .exclusive(
        "github|person",
        Effect.sync(() => order.push("second")),
      )
      .pipe(Effect.forkChild);
    yield* attempts.exclusive(
      "overleaf|person",
      Effect.sync(() => order.push("other site")),
    );
    yield* Effect.yieldNow;
    expect(order).toEqual(["other site"]);
    expect(attempts.lockedKeys()).toEqual(["github|person"]);
    yield* Deferred.succeed(gate, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    expect(order).toEqual(["other site", "first", "second"]);
    expect(attempts.lockedKeys()).toEqual([]);
  }),
);

it.effect("drops what a person typed when the server shuts down", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(layer, scope);
    const attempts = Context.get(context, SignInAttempts);
    attempts.typed.set("attempt", {
      threadId: "thread",
      tabId: PreviewTabId.make("tab"),
      sites: ["example.com"],
      university: false,
      accountId: AccountId.make("acc_example01"),
      fieldsSeen: new Map(),
      visited: new Set(),
      passwordSeen: new Map(),
      scientTyped: new Set(),
      submitted: 0,
      signedIn: false,
      seen: 0,
    });
    yield* Scope.close(scope, Exit.void);
    expect(attempts.typed.size).toBe(0);
  }),
);
