import type React from 'react';

import type { UseStorageOptions } from './useStorage.js';
import { useStorage } from './useStorage.js';

export function useSessionStorage<T>(
  key: string,
  initialValueOrFunc: T | (() => T),
  nonReactiveOptions: UseStorageOptions<T> = {}
): [T, React.Dispatch<React.SetStateAction<T>>] {
  return useStorage('sessionStorage', key, initialValueOrFunc, nonReactiveOptions);
}
