import type React from 'react';

import type { UseStorageOptions } from './useStorage.js';
import { useStorage } from './useStorage.js';

export function useLocalStorage<T>(
  key: string,
  initialValue: T,
  immutableOptions: UseStorageOptions<T> = {}
): [T, React.Dispatch<React.SetStateAction<T>>] {
  return useStorage('localStorage', key, initialValue, immutableOptions);
}
