import type React from 'react';
import { useCallback, useEffect, useSyncExternalStore } from 'react';

export function useStorage<T>(
  storageType: 'localStorage' | 'sessionStorage',
  key: string,
  initialValue: T,
  ssrValue: T,
  parseAfterJsonParse?: (value: unknown) => T
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const value = useSyncExternalStore<T>(
    subscribeStorageEvent,
    () => {
      const jsonText = window[storageType].getItem(key);
      try {
        if (jsonText) {
          const json = JSON.parse(jsonText);
          return parseAfterJsonParse ? parseAfterJsonParse(json) : json;
        }
      } catch {
        // do nothing
      }
      return initialValue;
    },
    () => ssrValue
  );

  const setState = useCallback(
    (valueOrFunc: T | ((prevState: T) => T)) => {
      try {
        const nextState = typeof valueOrFunc === 'function' ? (valueOrFunc as (prevState: T) => T)(value) : valueOrFunc;

        if (nextState === undefined || nextState === null) {
          window[storageType].removeItem(key);
        } else {
          window[storageType].setItem(key, JSON.stringify(nextState));
        }
      } catch (error) {
        console.warn(error);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, value]
  );

  useEffect(() => {
    if (window[storageType].getItem(key) === null && initialValue !== undefined) {
      window[storageType].setItem(key, JSON.stringify(initialValue));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, initialValue]);

  return [value, setState];
}

function subscribeStorageEvent(callback: (this: Window, ev: StorageEvent) => unknown) {
  window.addEventListener('storage', callback);
  return () => window.removeEventListener('storage', callback);
}
