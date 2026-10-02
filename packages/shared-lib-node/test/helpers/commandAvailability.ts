export function isMiseAvailable(): boolean {
  return Bun.which('mise') !== null;
}

export function isFnoxAvailable(): boolean {
  return Bun.which('fnox') !== null;
}
