import type React from 'react';

import { useStorage } from './useStorage.js';

export function useSessionStorage<T>(
  key: string,
  initialValue: T,
  ssrValue: T,
  parseAfterJsonParse?: (value: unknown) => T
): [T, React.Dispatch<React.SetStateAction<T>>] {
  return useStorage('sessionStorage', key, initialValue, ssrValue, parseAfterJsonParse);
}
