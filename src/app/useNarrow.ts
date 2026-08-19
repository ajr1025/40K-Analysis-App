/**
 * Is the viewport too narrow for the matrix?
 *
 * Driven by matchMedia rather than by CSS alone because the two views are
 * genuinely different components — a twenty-column table cannot be reflowed
 * into a ranked list with styling.
 */

import { useEffect, useState } from 'react';

const QUERY = '(max-width: 760px)';

export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(QUERY).matches
  );

  useEffect(() => {
    const media = window.matchMedia(QUERY);
    const update = () => setNarrow(media.matches);
    media.addEventListener('change', update);
    update();
    return () => media.removeEventListener('change', update);
  }, []);

  return narrow;
}
