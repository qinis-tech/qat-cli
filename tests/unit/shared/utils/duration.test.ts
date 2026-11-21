import { describe, expect, it } from "vitest";

import { formatDuration } from "../../../../src/shared/utils/duration.js";

describe("formatDuration", () => {
  it("renders sub-second durations as whole milliseconds", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(250)).toBe("250ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  it("rounds to the nearest millisecond below one second", () => {
    expect(formatDuration(0.4)).toBe("0ms");
    expect(formatDuration(999.6)).toBe("1000ms");
  });

  it("renders whole seconds without minute or hour segments", () => {
    expect(formatDuration(1_000)).toBe("1s");
    expect(formatDuration(8_500)).toBe("8s");
    expect(formatDuration(59_999)).toBe("59s");
  });

  it("renders minutes with a seconds remainder", () => {
    expect(formatDuration(60_000)).toBe("1m 0s");
    expect(formatDuration(225_000)).toBe("3m 45s");
  });

  it("renders hours with minute and second segments", () => {
    expect(formatDuration(3_600_000)).toBe("1h 0m 0s");
    expect(formatDuration(7_563_000)).toBe("2h 6m 3s");
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
  ])("throws on %s", (_label, value) => {
    expect(() => formatDuration(value)).toThrow(RangeError);
  });

  it("throws on a negative duration", () => {
    expect(() => formatDuration(-1)).toThrow(RangeError);
    expect(() => formatDuration(-1)).toThrow(/non-negative/);
  });
});
