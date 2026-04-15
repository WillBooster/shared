import type React from 'react';
import { useMemo, useCallback, useEffect, useSyncExternalStore } from 'react';

export interface UseStorageOptions<T> {
  parseAfterJsonParse?: (value: unknown) => T;
  ssrJsonText?: string;
  validValues?: Set<T>;
}

export function useStorage<T>(
  nonReactiveStorageType: 'localStorage' | 'sessionStorage',
  key: string,
  initialValueOrFunc: T | (() => T),
  nonReactiveOptions: UseStorageOptions<T> = {}
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const jsonText = useSyncExternalStore(
    (callback) => {
      const newCallback = (event: StorageEvent): void => {
        if (event.key === key) callback();
      };
      globalThis.addEventListener('storage', newCallback);
      return () => {
        globalThis.removeEventListener('storage', newCallback);
      };
    },
    () => window[nonReactiveStorageType].getItem(key),
    () => 'ssrJsonText' in nonReactiveOptions && nonReactiveOptions.ssrJsonText
  );
  const value = useMemo(() => {
    try {
      if (jsonText) {
        const json = JSON.parse(jsonText) as unknown as T;
        const value = nonReactiveOptions.parseAfterJsonParse?.(json) ?? json;
        if (!nonReactiveOptions.validValues || nonReactiveOptions.validValues.has(value)) return value;
      }
    } catch {
      // do nothing
    }
    return typeof initialValueOrFunc === 'function' ? (initialValueOrFunc as () => T)() : initialValueOrFunc;
    // oxlint-disable-next-line eslint-plugin-react-hooks/exhaustive-deps -- nonReactiveOptions is intentionally fixed by the hook contract.
  }, [jsonText, initialValueOrFunc]);

  const setState = useCallback(
    (valueOrFunc: T | ((prevState: T) => T)) => {
      const nextState = typeof valueOrFunc === 'function' ? (valueOrFunc as (prevState: T) => T)(value) : valueOrFunc;

      // eslint-disable-next-line unicorn/no-null
      let newValue: string | null = null;
      if (nextState === undefined || nextState === null) {
        window[nonReactiveStorageType].removeItem(key);
      } else {
        newValue = JSON.stringify(nextState);
        window[nonReactiveStorageType].setItem(key, newValue);
      }
      globalThis.dispatchEvent(new StorageEvent('storage', { key, newValue }));
    },

    // oxlint-disable-next-line eslint-plugin-react-hooks/exhaustive-deps -- nonReactiveStorageType is intentionally fixed by the hook contract.
    [key, value]
  );

  useEffect(() => {
    const resolvedInitialValue =
      typeof initialValueOrFunc === 'function' ? (initialValueOrFunc as () => T)() : initialValueOrFunc;
    if (window[nonReactiveStorageType].getItem(key) === null && resolvedInitialValue !== undefined) {
      window[nonReactiveStorageType].setItem(key, JSON.stringify(resolvedInitialValue));
    }
    // oxlint-disable-next-line eslint-plugin-react-hooks/exhaustive-deps -- nonReactiveStorageType is intentionally fixed by the hook contract.
  }, [key, initialValueOrFunc]);

  return [value, setState];
}
