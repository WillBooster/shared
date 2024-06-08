import { useSyncExternalStore } from 'react';

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
