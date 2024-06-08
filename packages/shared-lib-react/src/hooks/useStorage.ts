import type React from 'react';
import { useMemo, useCallback, useEffect, useSyncExternalStore } from 'react';

export type UseStorageOptions<T> =
  | {
      parseAfterJsonParse?: (value: unknown) => T;
      ssrJsonText: string;
    }
  | { parseAfterJsonParse?: (value: unknown) => T };

export function useStorage<T>(
  nonReactiveStorageType: 'localStorage' | 'sessionStorage',
  key: string,
  initialValue: T,
  nonReactiveOptions: UseStorageOptions<T> = {}
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const jsonText = useSyncExternalStore(
    subscribeStorageEvent,
    () => window[nonReactiveStorageType].getItem(key),
    () => 'ssrJsonText' in nonReactiveOptions && nonReactiveOptions.ssrJsonText
  );
  const value = useMemo(() => {
    try {
      if (jsonText) {
        const json = JSON.parse(jsonText);
        return nonReactiveOptions?.parseAfterJsonParse ? nonReactiveOptions?.parseAfterJsonParse(json) : json;
      }
    } catch {
      // do nothing
    }
    return initialValue;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jsonText, initialValue]);

  const setState = useCallback(
    (valueOrFunc: T | ((prevState: T) => T)) => {
      try {
        const nextState = typeof valueOrFunc === 'function' ? (valueOrFunc as (prevState: T) => T)(value) : valueOrFunc;

        if (nextState === undefined || nextState === null) {
          window[nonReactiveStorageType].removeItem(key);
        } else {
          window[nonReactiveStorageType].setItem(key, JSON.stringify(nextState));
        }
      } catch (error) {
        console.warn(error);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, value]
  );

  useEffect(() => {
    if (window[nonReactiveStorageType].getItem(key) === null && initialValue !== undefined) {
      window[nonReactiveStorageType].setItem(key, JSON.stringify(initialValue));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, initialValue]);

  return [value, setState];
}

function subscribeStorageEvent(callback: (this: Window, ev: StorageEvent) => unknown) {
  window.addEventListener('storage', callback);
  return () => window.removeEventListener('storage', callback);
}
