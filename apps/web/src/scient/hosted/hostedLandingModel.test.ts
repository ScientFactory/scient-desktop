import { describe, expect, it } from "vite-plus/test";

import {
  type HostedComputer,
  statusFromAvailability,
  statusFromConnectionPhase,
  summarizeComputers,
} from "./hostedLandingModel";

const computer = (status: HostedComputer["status"]): HostedComputer => ({
  id: status,
  label: status,
  machineKind: "laptop",
  status,
});

describe("hosted landing model", () => {
  it("words a discovered computer by its availability", () => {
    expect(statusFromAvailability("online", true)).toBe("opening");
    expect(statusFromAvailability("offline", true)).toBe("off");
    expect(statusFromAvailability("error", true)).toBe("unreachable");
    expect(statusFromAvailability("online", false)).toBe("needs-update");
  });

  it("words an added computer by its connection", () => {
    expect(statusFromConnectionPhase("connected")).toBe("open");
    expect(statusFromConnectionPhase("reconnecting")).toBe("opening");
    expect(statusFromConnectionPhase("unsupported")).toBe("needs-update");
  });

  it("leads with the most hopeful computer", () => {
    expect(summarizeComputers([computer("off"), computer("opening")])).toBe("opening");
    expect(summarizeComputers([computer("off"), computer("unreachable")])).toBe("unreachable");
    expect(summarizeComputers([computer("off")])).toBe("off");
  });
});
