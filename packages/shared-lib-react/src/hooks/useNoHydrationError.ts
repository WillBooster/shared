import { useSyncExternalStore } from 'react';

// eslint-disable-next-line @typescript-eslint/no-empty-function
function emptyFunction(): void {}
function emptySubscribe(): () => void {
  return emptyFunction;
}

// cf. https://tkdodo.eu/blog/avoiding-hydration-mismatches-with-use-sync-external-store
export function useNoHydrationError<T>(clientValue: T, ssrValue: T): T {
  return useSyncExternalStore(
    emptySubscribe,
    () => clientValue,
    () => ssrValue
  );
}
