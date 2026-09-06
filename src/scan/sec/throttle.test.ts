import { describe, expect, test } from 'bun:test';
import { createThrottle } from './throttle.ts';

/** A clock that only moves when a task or a sleep says it does. */
function fakeClock() {
  let current = 0;
  const slept: number[] = [];

  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
    sleep: (ms: number): Promise<void> => {
      slept.push(ms);
      current += ms;
      return Promise.resolve();
    },
    slept,
  };
}

describe('createThrottle', () => {
  test('the first task on a host runs without waiting', async () => {
    const clock = fakeClock();
    const throttle = createThrottle({ minIntervalMs: 1000, now: clock.now, sleep: clock.sleep });

    await throttle.run('a.example', () => Promise.resolve('done'));

    expect(clock.slept).toEqual([]);
  });

  test('the gap is measured from the end of the previous task, not its start', async () => {
    const clock = fakeClock();
    const throttle = createThrottle({ minIntervalMs: 1000, now: clock.now, sleep: clock.sleep });

    await throttle.run('a.example', () => {
      clock.advance(400);
      return Promise.resolve('slow');
    });
    await throttle.run('a.example', () => Promise.resolve('next'));

    expect(clock.slept).toEqual([1000]);
  });

  test('a host that has been quiet long enough is not made to wait', async () => {
    const clock = fakeClock();
    const throttle = createThrottle({ minIntervalMs: 1000, now: clock.now, sleep: clock.sleep });

    await throttle.run('a.example', () => Promise.resolve('first'));
    clock.advance(5000);
    await throttle.run('a.example', () => Promise.resolve('second'));

    expect(clock.slept).toEqual([]);
  });

  test('different hosts do not wait on each other', async () => {
    const clock = fakeClock();
    const throttle = createThrottle({ minIntervalMs: 1000, now: clock.now, sleep: clock.sleep });

    await throttle.run('a.example', () => Promise.resolve(1));
    await throttle.run('b.example', () => Promise.resolve(2));

    expect(clock.slept).toEqual([]);
  });

  test('tasks queued together against one host run one at a time', async () => {
    const clock = fakeClock();
    const throttle = createThrottle({ minIntervalMs: 0, now: clock.now, sleep: clock.sleep });
    const order: string[] = [];

    const task = (name: string) => async () => {
      order.push(`${name}:start`);
      await Promise.resolve();
      order.push(`${name}:end`);
    };

    await Promise.all([
      throttle.run('a.example', task('one')),
      throttle.run('a.example', task('two')),
    ]);

    expect(order).toEqual(['one:start', 'one:end', 'two:start', 'two:end']);
  });

  test('a failed task rejects its caller without deadlocking the host queue', async () => {
    const clock = fakeClock();
    const throttle = createThrottle({ minIntervalMs: 0, now: clock.now, sleep: clock.sleep });

    const failed = throttle.run('a.example', () => Promise.reject(new Error('boom')));

    await expect(failed).rejects.toThrow('boom');
    await expect(throttle.run('a.example', () => Promise.resolve('still works'))).resolves.toBe(
      'still works',
    );
  });
});
