import { useCallback, useEffect, useRef } from 'react';

export function useInterval(nonReactiveCallback: () => void, reactiveMilliseconds?: number): () => void {
  const timerId = useRef<number | NodeJS.Timeout>();

  const clearInterval = useCallback(() => {
    globalThis.clearInterval(timerId.current);
  }, []);

  useEffect(() => {
    if (reactiveMilliseconds !== undefined) {
      timerId.current = globalThis.setInterval(nonReactiveCallback, reactiveMilliseconds);
    }
    return clearInterval;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reactiveMilliseconds]);

  return clearInterval;
}
