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
