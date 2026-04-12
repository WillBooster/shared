import merge from 'deepmerge';

export function overwriteMerge<T>(destinationArray: T[], sourceArray: T[]): T[] {
  return sourceArray;
}

export function combineMerge(target: unknown[], source: unknown[], options: merge.ArrayMergeOptions): unknown[] {
  const destination = [...target];

  for (const [index, item] of source.entries()) {
    if (destination[index] === undefined) {
      destination[index] = cloneUnlessOtherwiseSpecified(item, options);
    } else if (isMergeableObject(target[index], options) && isMergeableObject(item, options)) {
      destination[index] = merge(target[index], item, options);
    } else if (!target.includes(item)) {
      destination.push(item);
    }
  }
  return destination;
}

function cloneUnlessOtherwiseSpecified(value: unknown, options: merge.ArrayMergeOptions): unknown {
  return isMergeableObject(value, options) ? options.cloneUnlessOtherwiseSpecified(value, options) : value;
}

function isMergeableObject(value: unknown, options: merge.ArrayMergeOptions): value is object {
  return !!value && typeof value === 'object' && options.isMergeableObject(value);
}
