import { describe, expect, it } from "vitest";
import { createReleaseVersion } from "../scripts/release-version.mjs";

const semver = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return Math.sign(a[i] - b[i]);
  }
  return 0;
}

describe("RFS-style release versions", () => {
  it.each([
    ["2026-07-09T20:01:11Z", "2026.709.200111"],
    ["2026-01-01T00:00:00Z", "2026.101.0"],
    ["2026-01-09T00:00:01Z", "2026.109.1"],
    ["2026-02-03T04:05:06Z", "2026.203.40506"],
    ["2026-12-31T23:59:59Z", "2026.1231.235959"],
    ["2026-07-09T22:01:11+02:00", "2026.709.200111"],
  ])("encodes %s as %s without leading zeroes", (instant, expected) => {
    const version = createReleaseVersion(new Date(instant));
    expect(version).toBe(expected);
    expect(version).toMatch(semver);
  });

  it.each([
    ["2026-07-09T20:01:11Z", "2026-07-09T20:01:12Z"],
    ["2026-07-09T20:01:59Z", "2026-07-09T20:02:00Z"],
    ["2026-07-09T20:59:59Z", "2026-07-09T21:00:00Z"],
    ["2026-07-09T23:59:59Z", "2026-07-10T00:00:00Z"],
    ["2026-07-31T23:59:59Z", "2026-08-01T00:00:00Z"],
    ["2026-12-31T23:59:59Z", "2027-01-01T00:00:00Z"],
  ])("increases between %s and %s", (before, after) => {
    expect(compareVersions(createReleaseVersion(new Date(after)), createReleaseVersion(new Date(before)))).toBe(1);
  });

  it("rejects invalid release times", () => {
    expect(() => createReleaseVersion(new Date("invalid"))).toThrow("valid date");
    expect(() => createReleaseVersion(new Date("-000001-01-01T00:00:00Z"))).toThrow("non-negative year");
  });
});
