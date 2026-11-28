import { AccountId, PreviewTabId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import * as Redacted from "effect/Redacted";

import {
  SignInAttempts,
  layer,
  makeSignInAttempts,
  notePage,
  type Typed,
} from "./signInAttempts.ts";

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
      passwordSeen: new Map(),
      scientTyped: new Map(),
      submitted: 0,
      signedIn: false,
      seen: 0,
    });
    yield* Scope.close(scope, Exit.void);
    expect(attempts.typed.size).toBe(0);
  }),
);

it("counts the person's password refused only when the site's answer shows the form again", () => {
  const typed: Typed = {
    threadId: "thread",
    tabId: PreviewTabId.make("tab"),
    sites: ["huji.ac.il"],
    university: true,
    accountId: AccountId.make("acc_example01"),
    fieldsSeen: new Map(),
    passwordSeen: new Map(),
    scientTyped: new Map(),
    submitted: 0,
    signedIn: false,
    seen: 0,
  };
  const origin = "https://idp.huji.ac.il";
  const form = { origin, password: true, captcha: false };
  const submit = () => {
    typed.candidate = {
      origin,
      username: "person@mail.huji.ac.il",
      password: Redacted.make("synthetic"),
      at: typed.seen++,
      document: typed.documents?.get(origin),
    };
    typed.refusedBack = false;
  };
  notePage(typed, form, 1);
  submit();
  // The same page, still waiting for the site's answer.
  notePage(typed, form, 1);
  expect(typed.refusedBack).toBe(false);
  // The answer keeps a CAPTCHA: it says nothing about the password, then or once it is solved.
  notePage(typed, { ...form, captcha: true }, 2);
  notePage(typed, form, 2);
  expect(typed.refusedBack).toBe(false);
  submit();
  notePage(typed, form, 3);
  expect(typed.refusedBack).toBe(true);
});
