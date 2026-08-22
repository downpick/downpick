/**
 * How long a query took, in the one place both the live timer and the finished stat read
 * from — so the number the user watched climbing and the number left behind agree.
 *
 * The unit follows the magnitude: sub-second work is only interesting in milliseconds, and
 * a query past a minute is only interesting in minutes.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes} m ${seconds} s`;
}
