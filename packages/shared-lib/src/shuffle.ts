export function shuffle<T>(array: T[]): T[] {
  return shuffleWithRandom(array, Math.random);
}

/** Shuffles an array in place, returning the same array. Equal string seeds produce equal permutations. */
export function shuffleWithSeed<T>(array: T[], seed: string): T[] {
  let state = 1_779_033_703 ^ seed.length;
  for (const character of seed) {
    state = Math.imul(state ^ character.codePointAt(0)!, 3_432_918_353);
    state = (state << 13) | (state >>> 19);
  }
  state = Math.imul(state ^ (state >>> 16), 2_246_822_507);
  state = Math.imul(state ^ (state >>> 13), 3_266_489_909);
  state ^= state >>> 16;

  return shuffleWithRandom(array, () => {
    state += 1_831_565_813;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  });
}

function shuffleWithRandom<T>(array: T[], random: () => number): T[] {
  for (let index = array.length - 1; index > 0; index--) {
    const index_ = Math.floor(random() * (index + 1));
    [array[index], array[index_]] = [array[index_], array[index]] as [T, T];
  }
  return array;
}
