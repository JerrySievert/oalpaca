import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RequestScheduler } from '../src/request_scheduler.js';

/**
 * Build a minimal mock ModelManager.
 * @param {object} overrides - Override individual methods
 */
function make_model_manager(overrides = {}) {
  return {
    is_loaded: vi.fn().mockReturnValue(false),
    ensure_loaded: vi.fn().mockResolvedValue({ name: 'test-model' }),
    acquire_context: vi.fn(),
    release_context: vi.fn(),
    ...overrides
  };
}

/**
 * Build a mock HTTP response object.
 */
function make_res({ writable_ended = false, destroyed = false } = {}) {
  return {
    writableEnded: writable_ended,
    destroyed,
    headersSent: false,
    writeHead: vi.fn(),
    write: vi.fn(),
    end: vi.fn()
  };
}

describe('RequestScheduler', () => {
  let manager;
  let scheduler;

  beforeEach(() => {
    manager = make_model_manager();
    scheduler = new RequestScheduler(manager);
  });

  describe('submit', () => {
    it('executes a simple request', async () => {
      const execute_fn = vi.fn();
      const res = make_res();

      await scheduler.submit('test-model', execute_fn, res, false);

      expect(manager.ensure_loaded).toHaveBeenCalledWith('test-model');
      expect(execute_fn).toHaveBeenCalledWith({ name: 'test-model' });
    });

    it('acquires and releases context around execution', async () => {
      const call_order = [];
      manager.acquire_context = vi.fn(() => call_order.push('acquire'));
      manager.release_context = vi.fn(() => call_order.push('release'));

      const execute_fn = vi.fn(() => call_order.push('execute'));
      const res = make_res();

      await scheduler.submit('test-model', execute_fn, res, false);

      expect(call_order).toEqual(['acquire', 'execute', 'release']);
    });

    it('releases context even when execute_fn throws', async () => {
      const execute_fn = vi.fn().mockRejectedValue(new Error('boom'));
      const res = make_res();

      await expect(
        scheduler.submit('test-model', execute_fn, res, false)
      ).rejects.toThrow('boom');

      expect(manager.release_context).toHaveBeenCalledWith('test-model');
    });

    it('rejects all requests for a model that fails to load', async () => {
      manager.ensure_loaded = vi.fn().mockRejectedValue(new Error('load fail'));
      const execute_fn = vi.fn();
      const res = make_res();

      await expect(
        scheduler.submit('bad-model', execute_fn, res, false)
      ).rejects.toThrow('load fail');

      expect(execute_fn).not.toHaveBeenCalled();
    });
  });

  describe('_pick_next_model', () => {
    it('returns null for empty queue', () => {
      expect(scheduler._pick_next_model()).toBeNull();
    });

    it('picks the only model in queue', () => {
      scheduler.queue.push({
        model_name: 'model-a',
        queued_at: Date.now()
      });
      expect(scheduler._pick_next_model()).toBe('model-a');
    });

    it('prefers loaded model over unloaded', () => {
      manager.is_loaded = vi.fn((name) => name === 'loaded-model');

      scheduler.queue.push(
        { model_name: 'unloaded-model', queued_at: 100 },
        { model_name: 'loaded-model', queued_at: 200 }
      );

      expect(scheduler._pick_next_model()).toBe('loaded-model');
    });

    it('prefers model with more pending requests among loaded', () => {
      manager.is_loaded = vi.fn().mockReturnValue(true);

      scheduler.queue.push(
        { model_name: 'model-a', queued_at: 100 },
        { model_name: 'model-b', queued_at: 100 },
        { model_name: 'model-b', queued_at: 200 }
      );

      expect(scheduler._pick_next_model()).toBe('model-b');
    });

    it('breaks ties by earliest queued_at (FIFO)', () => {
      manager.is_loaded = vi.fn().mockReturnValue(false);

      scheduler.queue.push(
        { model_name: 'model-a', queued_at: 200 },
        { model_name: 'model-b', queued_at: 100 }
      );

      expect(scheduler._pick_next_model()).toBe('model-b');
    });

    it('prefers loaded over unloaded even with fewer requests', () => {
      manager.is_loaded = vi.fn((name) => name === 'loaded');

      scheduler.queue.push(
        { model_name: 'unloaded', queued_at: 100 },
        { model_name: 'unloaded', queued_at: 200 },
        { model_name: 'unloaded', queued_at: 300 },
        { model_name: 'loaded', queued_at: 400 }
      );

      expect(scheduler._pick_next_model()).toBe('loaded');
    });
  });

  describe('_drain_model_requests', () => {
    it('removes and returns requests for the given model', () => {
      scheduler.queue = [
        { model_name: 'a' },
        { model_name: 'b' },
        { model_name: 'a' },
        { model_name: 'c' }
      ];

      const batch = scheduler._drain_model_requests('a');
      expect(batch).toHaveLength(2);
      expect(batch.every((r) => r.model_name === 'a')).toBe(true);
      expect(scheduler.queue).toHaveLength(2);
      expect(scheduler.queue.map((r) => r.model_name)).toEqual(['b', 'c']);
    });

    it('returns empty array when no requests match', () => {
      scheduler.queue = [{ model_name: 'a' }];
      expect(scheduler._drain_model_requests('z')).toEqual([]);
      expect(scheduler.queue).toHaveLength(1);
    });
  });

  describe('_prune_disconnected', () => {
    it('removes requests with writableEnded', () => {
      const resolve_fn = vi.fn();
      scheduler.queue = [
        {
          model_name: 'a',
          res: { writableEnded: true, destroyed: false },
          resolve: resolve_fn,
          heartbeat_interval: null
        },
        {
          model_name: 'b',
          res: { writableEnded: false, destroyed: false },
          resolve: vi.fn(),
          heartbeat_interval: null
        }
      ];

      scheduler._prune_disconnected();

      expect(scheduler.queue).toHaveLength(1);
      expect(scheduler.queue[0].model_name).toBe('b');
      expect(resolve_fn).toHaveBeenCalled();
    });

    it('removes requests with destroyed response', () => {
      scheduler.queue = [
        {
          model_name: 'a',
          res: { writableEnded: false, destroyed: true },
          resolve: vi.fn(),
          heartbeat_interval: null
        }
      ];

      scheduler._prune_disconnected();
      expect(scheduler.queue).toHaveLength(0);
    });
  });

  describe('_start_heartbeat / _stop_heartbeat', () => {
    it('starts sending heartbeat chunks for streaming requests', () => {
      vi.useFakeTimers();

      const res = make_res();
      const pending = {
        stream: true,
        res,
        model_name: 'test',
        heartbeat_interval: null
      };

      scheduler._start_heartbeat(pending);

      expect(pending.heartbeat_interval).not.toBeNull();
      expect(res.writeHead).toHaveBeenCalled();

      // Advance timer to trigger heartbeat
      vi.advanceTimersByTime(3000);
      expect(res.write).toHaveBeenCalled();

      scheduler._stop_heartbeat(pending);
      expect(pending.heartbeat_interval).toBeNull();

      vi.useRealTimers();
    });

    it('does not start heartbeat for non-streaming requests', () => {
      const pending = {
        stream: false,
        res: make_res(),
        heartbeat_interval: null
      };

      scheduler._start_heartbeat(pending);
      expect(pending.heartbeat_interval).toBeNull();
    });

    it('does not start heartbeat if already running', () => {
      const existing_interval = 42;
      const pending = {
        stream: true,
        res: make_res(),
        heartbeat_interval: existing_interval
      };

      scheduler._start_heartbeat(pending);
      expect(pending.heartbeat_interval).toBe(existing_interval);
    });
  });

  describe('_pick_next_model (unloaded models)', () => {
    it('picks best unloaded model when no models are loaded', () => {
      manager.is_loaded = vi.fn().mockReturnValue(false);

      scheduler.queue.push(
        { model_name: 'model-a', queued_at: 100 },
        { model_name: 'model-b', queued_at: 50 },
        { model_name: 'model-b', queued_at: 200 }
      );

      // model-b has more requests and is unloaded
      expect(scheduler._pick_next_model()).toBe('model-b');
    });

    it('breaks ties among unloaded models by earliest queued_at', () => {
      manager.is_loaded = vi.fn().mockReturnValue(false);

      scheduler.queue.push(
        { model_name: 'model-a', queued_at: 200 },
        { model_name: 'model-b', queued_at: 100 }
      );

      expect(scheduler._pick_next_model()).toBe('model-b');
    });
  });

  describe('heartbeat on queued streaming requests', () => {
    it('starts heartbeat for streaming requests when scheduler is busy', async () => {
      vi.useFakeTimers();

      // Make the first request take a while
      let first_resolve;
      const first_promise = new Promise((resolve) => {
        first_resolve = resolve;
      });

      const slow_execute = vi.fn(async () => {
        await first_promise;
      });
      const fast_execute = vi.fn();

      const res1 = make_res();
      const res2 = make_res();

      // Submit first request (will hold the lock)
      const p1 = scheduler.submit('model-a', slow_execute, res1, false);

      // Let the scheduler start processing
      await vi.advanceTimersByTimeAsync(0);

      // Submit second streaming request while first is running
      const p2 = scheduler.submit('model-b', fast_execute, res2, true);

      // Advance timer to trigger heartbeat
      await vi.advanceTimersByTimeAsync(3000);

      // res2 should have received heartbeat headers and a chunk
      expect(res2.writeHead).toHaveBeenCalled();

      // Complete the first request
      first_resolve();
      await vi.advanceTimersByTimeAsync(0);
      await Promise.all([p1, p2]);

      vi.useRealTimers();
    });
  });

  describe('heartbeat error handling', () => {
    it('stops heartbeat when write throws (client disconnect)', () => {
      vi.useFakeTimers();

      const res = make_res();
      res.write = vi.fn(() => {
        throw new Error('write after end');
      });

      const pending = {
        stream: true,
        res,
        model_name: 'test',
        heartbeat_interval: null
      };

      scheduler._start_heartbeat(pending);
      expect(pending.heartbeat_interval).not.toBeNull();

      // Trigger the heartbeat — it should catch the error and stop
      vi.advanceTimersByTime(3000);
      expect(pending.heartbeat_interval).toBeNull();

      vi.useRealTimers();
    });
  });

  describe('batch execution', () => {
    it('executes multiple requests for the same model in one batch', async () => {
      const execution_order = [];

      const make_execute = (id) =>
        vi.fn(async () => {
          execution_order.push(id);
        });

      const res1 = make_res();
      const res2 = make_res();

      // Submit two requests for same model — they should batch
      const p1 = scheduler.submit('model-a', make_execute('req1'), res1, false);
      const p2 = scheduler.submit('model-a', make_execute('req2'), res2, false);

      await Promise.all([p1, p2]);

      expect(execution_order).toEqual(['req1', 'req2']);
      // Model should only be loaded once
      expect(manager.ensure_loaded).toHaveBeenCalledTimes(1);
    });
  });
});
