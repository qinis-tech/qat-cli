/**
 * Duration formatting for terminal output.
 *
 * Values appear in run summaries and diagnostics, where a raw millisecond count
 * is unreadable at a glance: `225_431` tells a reader nothing that `3m 45s` does
 * not say faster.
 */

const SECOND_MS = 1_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/**
 * Formats a duration as a compact human-readable string.
 *
 * @param totalMilliseconds Elapsed time. Must be finite and non-negative.
 * @returns Milliseconds below one second, otherwise seconds, minutes or hours
 *   as appropriate, e.g. `250ms`, `8s`, `3m 45s`, `2h 6m 3s`.
 * @throws {RangeError} If the value is not a finite, non-negative number.
 */
export function formatDuration(totalMilliseconds: number): string {
  if (!Number.isFinite(totalMilliseconds)) {
    throw new RangeError(
      `formatDuration expects a finite number, received ${String(totalMilliseconds)}`,
    );
  }

  if (totalMilliseconds < 0) {
    throw new RangeError(
      `formatDuration expects a non-negative number, received ${totalMilliseconds}`,
    );
  }

  if (totalMilliseconds < SECOND_MS) {
    return `${Math.round(totalMilliseconds)}ms`;
  }

  const hours = Math.floor(totalMilliseconds / HOUR_MS);
  const minutes = Math.floor((totalMilliseconds % HOUR_MS) / MINUTE_MS);
  const seconds = Math.floor((totalMilliseconds % MINUTE_MS) / SECOND_MS);

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}
