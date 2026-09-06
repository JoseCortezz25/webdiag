/**
 * Per-host throttling (spec §10).
 *
 * The unit of politeness is the host, not the process: two hosts have nothing to
 * do with each other, and serialising them would only make a `deep` run slower
 * without making anyone safer.
 *
 * Within one host the guarantee is deliberately strong — tasks run one at a
 * time, and the gap is measured from the *end* of the previous task. Spacing
 * from the start would let two slow requests overlap and still call itself
 * throttled.
 */

export type Throttle = {
  /** Queues `task` behind everything already queued for `host`. */
  run<T>(host: string, task: () => Promise<T>): Promise<T>;
};

export type ThrottleOptions = {
  /** Quiet time between the end of one task and the start of the next. */
  readonly minIntervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
};

export const DEFAULT_MIN_INTERVAL_MS = 1_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createThrottle(options: ThrottleOptions = {}): Throttle {
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;

  /** Tail of the queue per host. Always settled — never rejected. */
  const queues = new Map<string, Promise<unknown>>();
  const finishedAt = new Map<string, number>();

  async function execute<T>(host: string, task: () => Promise<T>): Promise<T> {
    const previous = finishedAt.get(host);

    if (previous !== undefined) {
      const wait = minIntervalMs - (now() - previous);
      if (wait > 0) {
        await sleep(wait);
      }
    }

    try {
      return await task();
    } finally {
      // Recorded even when the task threw: a failed request still cost the host
      // a connection, so it still buys the next one a gap.
      finishedAt.set(host, now());
    }
  }

  return {
    run<T>(host: string, task: () => Promise<T>): Promise<T> {
      const tail = queues.get(host) ?? Promise.resolve();
      const started = tail.then(() => execute(host, task));

      // The queue must survive a rejected task, or one failed request would
      // deadlock every later request to the same host.
      queues.set(
        host,
        started.catch(() => undefined),
      );

      return started;
    },
  };
}
