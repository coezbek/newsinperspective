import { describe, expect, it } from "vitest";
import { formatDateInTimeZone, startOfUtcDay } from "../src/lib/runtime-date.js";

describe("formatDateInTimeZone", () => {
  it("keeps the logical run date in the configured timezone", () => {
    const instant = new Date("2026-04-30T23:17:27.908Z");

    expect(formatDateInTimeZone(instant, "UTC")).toBe("2026-04-30");
    expect(formatDateInTimeZone(instant, "Australia/Sydney")).toBe("2026-05-01");
  });
});

describe("startOfUtcDay", () => {
  it("normalizes logical dates to midnight UTC", () => {
    expect(startOfUtcDay("2026-05-01").toISOString()).toBe("2026-05-01T00:00:00.000Z");
  });
});
