/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */

import merge from 'deepmerge';

export function overwriteMerge<T>(destinationArray: T[], sourceArray: T[]): T[] {
  return sourceArray;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function combineMerge(target: object[], source: object[], options: any): object[] {
  const destination = [...target];

  for (const [index, item] of source.entries()) {
    if (destination[index] === undefined) {
      destination[index] = options.cloneUnlessOtherwiseSpecified(item, options);
    } else if (options.isMergeableObject(item)) {
      destination[index] = merge(target[index] as object, item, options);
    } else if (!target.includes(item)) {
      destination.push(item);
    }
  }
  return destination;
}
