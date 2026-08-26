import { describe, expect, it, vi } from 'vitest';
import { CallRouter } from '@panorama/mcp';
import type { AgentCall } from '@panorama/mcp';

/** A router whose clock the test holds, so a timeout is not a wait. */
const manual = (): {
  router: CallRouter;
  fire: () => void;
  cleared: number;
} => {
  const timers: (() => void)[] = [];
  let cleared = 0;
  const router = new CallRouter({
    timeoutMs: 5_000,
    setTimer: (run) => {
      timers.push(run);
      return timers.length;
    },
    clearTimer: () => {
      cleared += 1;
    },
  });
  return {
    router,
    fire: (): void => {
      for (const run of timers.splice(0)) run();
    },
    get cleared() {
      return cleared;
    },
  };
};

describe('CallRouter', () => {
  it('says so when there is no session to ask', async () => {
    const { router } = manual();
    expect(router.attached).toBe(0);
    // The one error an agent will meet first, so it says what to do about it.
    await expect(router.call('overview', {})).rejects.toThrow(
      /No Panorama session is attached.*npm run dev|browser/su,
    );
  });

  it('sends a call to the attached page and resolves with its answer', async () => {
    const { router } = manual();
    const sent: AgentCall[] = [];
    router.attach((call) => sent.push(call));
    const answer = router.call('entities', { a: 1 });
    expect(sent).toEqual([{ id: 1, name: 'entities', args: { a: 1 } }]);
    expect(router.deliver({ id: 1, ok: true, value: ['a table'] })).toBe(true);
    await expect(answer).resolves.toEqual(['a table']);
  });

  it('rejects with what the application said went wrong', async () => {
    const { router } = manual();
    router.attach(() => {});
    const answer = router.call('entity', {});
    router.deliver({ id: 1, ok: false, error: 'there is no entity table:9' });
    await expect(answer).rejects.toThrow('there is no entity table:9');
    const second = router.call('entity', {});
    router.deliver({ id: 2, ok: false });
    await expect(second).rejects.toThrow(/did not say what went wrong/u);
  });

  it('goes to the newest page, and falls back when it goes away', async () => {
    const { router } = manual();
    const first: AgentCall[] = [];
    const second: AgentCall[] = [];
    router.attach((call) => first.push(call));
    const detach = router.attach((call) => second.push(call));
    expect(router.attached).toBe(2);
    void router.call('overview', {});
    expect(second).toHaveLength(1);
    expect(first).toHaveLength(0);
    // A reloaded tab should be invisible to an agent mid-conversation.
    detach();
    detach();
    expect(router.attached).toBe(1);
    void router.call('overview', {});
    expect(first).toHaveLength(1);
  });

  it('gives up on a call the page never answers', async () => {
    const timing = manual();
    timing.router.attach(() => {});
    const answer = timing.router.call('rows', {});
    timing.fire();
    await expect(answer).rejects.toThrow(/rows did not answer within 5s/u);
    // And an answer that turns up afterwards is dropped rather than thrown at
    // nobody: the page was doing as it was told, only slowly.
    expect(timing.router.deliver({ id: 1, ok: true, value: 1 })).toBe(false);
  });

  it('clears the timer of a call that was answered', async () => {
    const timing = manual();
    timing.router.attach(() => {});
    const answer = timing.router.call('overview', {});
    timing.router.deliver({ id: 1, ok: true, value: {} });
    await answer;
    expect(timing.cleared).toBe(1);
  });

  it('fails everything in flight when it is shutting down', async () => {
    const { router } = manual();
    router.attach(() => {});
    const answer = router.call('overview', {});
    router.abandon('the dev server stopped');
    await expect(answer).rejects.toThrow('the dev server stopped');
  });

  it('uses real timers when it is not given any', async () => {
    vi.useFakeTimers();
    try {
      const router = new CallRouter({ timeoutMs: 10 });
      router.attach(() => {});
      const answer = router.call('overview', {});
      const caught = answer.catch((error: unknown) => (error as Error).message);
      await vi.advanceTimersByTimeAsync(20);
      expect(await caught).toContain('did not answer');
      // And clears them: a second call answered promptly leaves nothing behind.
      const second = router.call('overview', {});
      router.deliver({ id: 2, ok: true, value: 'x' });
      expect(await second).toBe('x');
    } finally {
      vi.useRealTimers();
    }
  });
});
