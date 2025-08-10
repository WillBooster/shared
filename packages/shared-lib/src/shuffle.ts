export function shuffle<T>(array: T[]): T[] {
  for (let index = array.length - 1; index > 0; index--) {
    const index_ = Math.floor(Math.random() * (index + 1));
    [array[index], array[index_]] = [array[index_], array[index]] as [T, T];
  }
  return array;
}
