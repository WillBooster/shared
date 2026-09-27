export function humanizeNumber(value: number, { base = 1000, units = ['K', 'M', 'B', 'T', 'P'] } = {}): string {
  if (value < base) {
    return value.toString();
  }

  let unitIndex = -1;
  while (value >= base && unitIndex < units.length - 1) {
    value /= base;
    unitIndex++;
  }

  return value.toFixed(2) + (units[unitIndex] ?? '');
}

/**
 * Formats a duration in Japanese: to a tenth of a second under a minute (`59.9秒`), otherwise in whole minutes and
 * seconds (`1分0秒`).
 */
export function formatElapsedTimeInJapanese(milliseconds: number): string {
  // Round to the displayed precision before choosing the format, or 59.98s would be shown as `60.0秒`.
  const roundedTenths = Math.round(milliseconds / 100) / 10;
  if (roundedTenths < 60) return `${roundedTenths.toFixed(1)}秒`;

  // Round before splitting into minutes and seconds, or 119.8s would be shown as `1分60秒`.
  const roundedSeconds = Math.round(milliseconds / 1000);
  return `${Math.floor(roundedSeconds / 60)}分${roundedSeconds % 60}秒`;
}

/**
 * Formats a duration compactly in English: whole milliseconds under a second (`850ms`), a tenth of a second under a
 * minute (`12.3s`), and whole seconds above (`1m 5s`, `2h 0m 7s`).
 */
export function formatDuration(milliseconds: number): string {
  // Each branch rounds to its displayed precision before choosing the format, e.g. 59.96s is shown as `1m 0s`.
  const roundedMilliseconds = Math.round(milliseconds);
  if (roundedMilliseconds < 1000) return `${roundedMilliseconds}ms`;
  const roundedTenths = Math.round(milliseconds / 100) / 10;
  if (roundedTenths < 60) return `${roundedTenths.toFixed(1)}s`;
  const totalSeconds = Math.round(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutesAndSeconds = `${Math.floor(totalSeconds / 60) % 60}m ${totalSeconds % 60}s`;
  return hours > 0 ? `${hours}h ${minutesAndSeconds}` : minutesAndSeconds;
}
