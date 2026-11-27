import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import {
  measurementBudget,
  readyDeadline,
  startBefore,
  waitUntil,
} from "./windows-install-timing-budget.mjs";

const BUDGET_MS = 12 * 60_000;
const READY_MS = 2 * 60_000;

/** A clock that only moves when the code under test waits. */
function fakeTime() {
  const time = { now: 0 };
  return {
    time,
    clock: () => time.now,
    sleep: async (ms) => {
      time.now += ms;
    },
  };
}

NodeTest.test(
  "a launch takes its readiness deadline after its checks, never past the budget",
  async () => {
    const { time, clock } = fakeTime();
    const budget = measurementBudget(clock, BUDGET_MS);
    const checksTaking = (ms) => async () => {
      time.now += ms;
      return { port: 9222 };
    };

    // Checks that run past the budget's end leave the launch unstarted.
    time.now = BUDGET_MS - 10_000;
    NodeAssert.deepEqual(await readyDeadline(budget, READY_MS, checksTaking(10_490)), {
      spent: true,
    });

    // Checks that end inside it leave only what remains of it.
    time.now = BUDGET_MS - 10_000;
    NodeAssert.deepEqual(await readyDeadline(budget, READY_MS, checksTaking(4_000)), {
      port: 9222,
      deadline: BUDGET_MS,
    });

    // With time to spare, the readiness bound starts when the checks end.
    time.now = 0;
    NodeAssert.deepEqual(await readyDeadline(budget, READY_MS, checksTaking(30_000)), {
      port: 9222,
      deadline: 30_000 + READY_MS,
    });
  },
);

NodeTest.test(
  "readiness ends at its deadline even when every probe waits out its own bound",
  async () => {
    const fake = fakeTime();
    const deadline = 10_000;
    let probes = 0;
    const ready = await waitUntil(
      fake,
      async (left) => {
        probes += 1;
        fake.time.now += left(30_000);
        return false;
      },
      deadline,
      100,
    );
    NodeAssert.equal(ready, false);
    NodeAssert.equal(probes, 1);
    NodeAssert.equal(fake.time.now, deadline);
  },
);

NodeTest.test(
  "a clock that moves between reads never stretches the deadline past the budget",
  () => {
    // Every read of the clock advances it, as a real clock does between two calls.
    let now = 0;
    const clock = () => (now += 30);
    const budget = measurementBudget(clock, BUDGET_MS);
    now = BUDGET_MS - 1_000;
    const deadline = budget.deadline(READY_MS);
    NodeAssert.ok(deadline !== null && deadline <= 30 + BUDGET_MS, `deadline ${deadline}`);
    now = 30 + BUDGET_MS - 10;
    NodeAssert.equal(budget.deadline(READY_MS), null);
  },
);

NodeTest.test("a launch whose deadline passed before it could start does not start", () => {
  let now = 9_990;
  const clock = () => (now += 5);
  NodeAssert.equal(startBefore(clock, 10_000), 9_995);
  NodeAssert.equal(startBefore(clock, 10_000), null);
});
