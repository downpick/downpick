import { useEffect, useState } from 'react';
import { formatDuration } from '../formatDuration';

/**
 * The live "how long has this been running" readout.
 *
 * A component of its own, deliberately: it re-renders ten times a second, and the only
 * thing that may repaint at that rate is this text node. Nothing above it — not the results
 * pane, not the status bar, and above all not the store — hears the tick.
 *
 * Several instances can run against the same `startedAt` (the results pane and the status
 * bar each mount one) and still agree, because the elapsed time is derived from that
 * timestamp rather than counted up locally.
 */
export function ElapsedTime({ startedAt }: { startedAt: number }) {
  const [elapsed, setElapsed] = useState(() => Date.now() - startedAt);

  useEffect(() => {
    setElapsed(Date.now() - startedAt);
    const id = setInterval(() => setElapsed(Date.now() - startedAt), 100);
    return () => clearInterval(id);
  }, [startedAt]);

  return <>{formatDuration(elapsed)}</>;
}
