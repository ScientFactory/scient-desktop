import { assert, describe, it } from "vite-plus/test";

import { installSupervisedDevelopmentHandoff } from "./coldDevelopmentHandoff.ts";

const files = [
  {
    path: "/tmp/reviewed.scic",
    identity: { dev: "1", ino: "2", size: "3", mtimeNs: "4" },
    readOnly: false as const,
  },
];

describe("supervised development handoff failure boundary", () => {
  it("starts only after a valid receipt is installed", async () => {
    let installed = false;
    const allowed = await installSupervisedDevelopmentHandoff(
      async (received) => {
        assert.deepEqual(received, files);
        installed = true;
      },
      { take: () => files, reportFailure: () => assert.fail("unexpected failure") },
    );
    assert.isTrue(allowed);
    assert.isTrue(installed);
  });

  it("reports a missing or malformed receipt and refuses startup", async () => {
    const errors: string[] = [];
    let installed = false;
    const allowed = await installSupervisedDevelopmentHandoff(
      async () => {
        installed = true;
      },
      {
        take: () => {
          throw new Error("private receipt missing");
        },
        reportFailure: (message) => errors.push(message),
      },
    );
    assert.isFalse(allowed);
    assert.isFalse(installed);
    assert.deepEqual(errors, ["private receipt missing"]);
  });

  it("reports a changed file and refuses startup after validation fails", async () => {
    const errors: string[] = [];
    const allowed = await installSupervisedDevelopmentHandoff(
      async () => {
        throw new Error("The reviewed conversation changed. Open it again.");
      },
      { take: () => files, reportFailure: (message) => errors.push(message) },
    );
    assert.isFalse(allowed);
    assert.match(errors[0] ?? "", /changed/u);
  });
});
