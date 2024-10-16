import { useCallback, useEffect, useRef } from 'react';

/**
 * A custom React hook that sets up an interval and returns a function to clear it.
 *
 * This hook ensures that the latest callback is always used, even if it changes between renders.
 * The interval can be dynamically started, stopped, or adjusted by changing the `milliseconds` parameter.
 *
 * @param callback - The function to be called at each interval. It is guaranteed to be the most recent version.
 * @param milliseconds - The interval duration in milliseconds. If undefined, the interval is cleared.
 * @returns A function to manually clear the interval.
 *
 * @example
 * const clearInterval = useInterval(() => {
 *   console.log('This will run every 1000ms');
 * }, 1000);
 *
 * // To manually stop the interval:
 * clearInterval();
 */
export function useInterval(callback: () => void, milliseconds?: number): () => void {
  const timerId = useRef<number | NodeJS.Timeout>();
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  const clearInterval = useCallback(() => {
    globalThis.clearInterval(timerId.current);
  }, []);

  useEffect(() => {
    if (milliseconds !== undefined) {
      timerId.current = globalThis.setInterval(() => callbackRef.current(), milliseconds);
    }
    return clearInterval;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [milliseconds]);

  return clearInterval;
}
