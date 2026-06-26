import { useCallback, useState } from 'react';

/**
 * Cursor pagination state for AppSync `nextToken` lists. Tracks the current page's start
 * token plus a back-stack so the operator can page forward and back. The component feeds
 * the freshly-loaded `nextToken` into `goNext`.
 */
export function usePageCursor() {
  const [cursor, setCursor] = useState<string | null>(null);
  const [backStack, setBackStack] = useState<(string | null)[]>([]);

  const goNext = useCallback(
    (nextToken: string | null) => {
      if (!nextToken) return;
      setBackStack((stack) => [...stack, cursor]);
      setCursor(nextToken);
    },
    [cursor],
  );

  const goPrev = useCallback(() => {
    setBackStack((stack) => {
      if (stack.length === 0) return stack;
      const next = stack.slice(0, -1);
      setCursor(stack[stack.length - 1]);
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    setCursor(null);
    setBackStack([]);
  }, []);

  return {
    cursor,
    pageIndex: backStack.length,
    canPrev: backStack.length > 0,
    goNext,
    goPrev,
    reset,
  };
}
