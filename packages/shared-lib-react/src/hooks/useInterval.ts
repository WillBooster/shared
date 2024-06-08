import { useCallback, useEffect, useRef } from 'react';

export function useInterval(nonReactiveCallback: () => void, milliseconds: number): () => void {
  const timerId = useRef<number>();

  const clearInterval = useCallback(() => {
    window.clearInterval(timerId.current);
  }, []);

  useEffect(() => {
    timerId.current = window.setInterval(nonReactiveCallback, milliseconds);
    return clearInterval;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [milliseconds]);

  return clearInterval;
}
