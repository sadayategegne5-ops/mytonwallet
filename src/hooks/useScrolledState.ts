import { useState } from '../lib/teact/teact';

import useLastCallback from './useLastCallback';

const THRESHOLD = 1;

export default function useScrolledState(threshold = THRESHOLD) {
  const [isAtBeginning, setIsAtBeginning] = useState(true);
  const [isAtEnd, setIsAtEnd] = useState(true);

  const update = useLastCallback((element?: HTMLElement | null) => {
    if (!element) return;

    const { scrollHeight, scrollTop, clientHeight } = element;

    setIsAtBeginning(scrollTop < threshold);
    setIsAtEnd(scrollHeight - scrollTop - clientHeight < threshold);
  });

  const handleScroll = useLastCallback((e: React.UIEvent<HTMLElement>) => {
    update(e.target as HTMLElement);
  });

  return {
    isAtBeginning,
    isAtEnd,
    isScrolled: !isAtBeginning,
    handleScroll,
    update,
  };
}
