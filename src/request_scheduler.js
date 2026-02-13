/**
 * Request Scheduler
 * Fair-batching queue that groups same-model requests together
 * to minimize model load/unload cycles. Sends streaming heartbeats
 * to clients while their requests are waiting in the queue.
 */

/**
 * Send a streaming response chunk (NDJSON)
 */
function send_chunk(res, data) {
  res.write(JSON.stringify(data) + '\n');
}

/**
 * A pending request waiting in the queue
 */
class PendingRequest {
  constructor(model_name, execute_fn, res, stream) {
    this.model_name = model_name;
    this.execute_fn = execute_fn;
    this.res = res;
    this.stream = stream;
    this.resolve = null;
    this.reject = null;
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    this.queued_at = Date.now();
    this.heartbeat_interval = null;
  }
}

/**
 * Fair-batching request scheduler
 */
export class RequestScheduler {
  constructor(model_manager, debug_log) {
    this.model_manager = model_manager;
    this.debug_log = debug_log || (() => {});
    this.queue = [];
    this.is_processing = false;
  }

  /**
   * Submit a request to the scheduler.
   * Returns a promise that resolves when the request completes.
   * @param {string} model_name - Which model to use
   * @param {Function} execute_fn - async (entry) => void, the actual work
   * @param {object} res - HTTP response object (for heartbeats)
   * @param {boolean} stream - Whether this is a streaming request
   * @returns {Promise<void>}
   */
  async submit(model_name, execute_fn, res, stream) {
    const pending = new PendingRequest(model_name, execute_fn, res, stream);
    this.queue.push(pending);

    this.debug_log(
      `request queued for ${model_name} (queue depth: ${this.queue.length})`
    );

    // Start heartbeat for streaming requests that will wait in queue
    if (stream && this.is_processing) {
      this._start_heartbeat(pending);
    }

    // Kick off processing if not already running
    this._process_next();

    return pending.promise;
  }

  /**
   * Main processing loop. Picks the best model to serve next,
   * loads it if necessary, then drains all queued requests for that model
   * before switching to the next.
   */
  async _process_next() {
    if (this.is_processing) return;
    if (this.queue.length === 0) return;

    this.is_processing = true;

    try {
      while (this.queue.length > 0) {
        // Remove requests for disconnected clients
        this._prune_disconnected();
        if (this.queue.length === 0) break;

        const next_model = this._pick_next_model();
        if (!next_model) break;

        this.debug_log(`scheduler: serving model ${next_model}`);

        // Ensure the model is loaded (may trigger eviction of others)
        let entry;
        try {
          entry = await this.model_manager.ensure_loaded(next_model);
        } catch (error) {
          // Model failed to load — reject all pending requests for it
          console.error(`Failed to load model ${next_model}: ${error.message}`);
          const failed_batch = this._drain_model_requests(next_model);
          for (const pending of failed_batch) {
            this._stop_heartbeat(pending);
            pending.reject(error);
          }
          continue;
        }

        // Drain and execute ALL requests for this model before switching.
        // Re-drain in a loop so requests arriving during execution also get served.
        while (true) {
          const batch = this._drain_model_requests(next_model);
          if (batch.length === 0) break;

          this.debug_log(
            `scheduler: executing batch of ${batch.length} for ${next_model}`
          );

          for (const pending of batch) {
            this._stop_heartbeat(pending);
            try {
              this.model_manager.acquire_context(next_model);
              await pending.execute_fn(entry);
              pending.resolve();
            } catch (error) {
              pending.reject(error);
            } finally {
              this.model_manager.release_context(next_model);
            }
          }
        }
      }
    } finally {
      this.is_processing = false;

      // If new requests arrived while we were finishing up, process them
      if (this.queue.length > 0) {
        this._process_next();
      }
    }
  }

  /**
   * Fair batching algorithm: pick which model to serve next.
   *
   * Priority:
   * 1. Prefer models already loaded in memory (avoids load/unload cost)
   * 2. Among loaded models, pick the one with the most pending requests
   * 3. Among unloaded models, pick the one with the most pending requests
   * 4. Tie-break by earliest queued_at (FIFO fairness)
   *
   * @returns {string|null} Model name to serve next
   */
  _pick_next_model() {
    if (this.queue.length === 0) return null;

    // Count requests and track earliest timestamp per model
    const counts = new Map();
    const earliest = new Map();
    for (const req of this.queue) {
      counts.set(req.model_name, (counts.get(req.model_name) || 0) + 1);
      if (
        !earliest.has(req.model_name) ||
        req.queued_at < earliest.get(req.model_name)
      ) {
        earliest.set(req.model_name, req.queued_at);
      }
    }

    let best_loaded = null;
    let best_unloaded = null;

    for (const [model_name, count] of counts) {
      const candidate = {
        model_name,
        count,
        earliest_at: earliest.get(model_name)
      };

      if (this.model_manager.is_loaded(model_name)) {
        if (
          !best_loaded ||
          count > best_loaded.count ||
          (count === best_loaded.count &&
            candidate.earliest_at < best_loaded.earliest_at)
        ) {
          best_loaded = candidate;
        }
      } else {
        if (
          !best_unloaded ||
          count > best_unloaded.count ||
          (count === best_unloaded.count &&
            candidate.earliest_at < best_unloaded.earliest_at)
        ) {
          best_unloaded = candidate;
        }
      }
    }

    // Prefer loaded models to avoid expensive load/unload
    return (best_loaded || best_unloaded)?.model_name || null;
  }

  /**
   * Drain all queued requests for a specific model
   * @param {string} model_name
   * @returns {PendingRequest[]}
   */
  _drain_model_requests(model_name) {
    const batch = [];
    const remaining = [];
    for (const req of this.queue) {
      if (req.model_name === model_name) {
        batch.push(req);
      } else {
        remaining.push(req);
      }
    }
    this.queue = remaining;
    return batch;
  }

  /**
   * Remove requests whose clients have disconnected
   */
  _prune_disconnected() {
    const before = this.queue.length;
    this.queue = this.queue.filter((req) => {
      if (req.res.writableEnded || req.res.destroyed) {
        this._stop_heartbeat(req);
        req.resolve(); // Silently resolve — client is gone
        return false;
      }
      return true;
    });
    const pruned = before - this.queue.length;
    if (pruned > 0) {
      this.debug_log(`scheduler: pruned ${pruned} disconnected requests`);
    }
  }

  /**
   * Start sending heartbeat chunks for a streaming request waiting in queue.
   * Opens the NDJSON response headers immediately and sends empty content
   * chunks every 3 seconds so the client doesn't timeout.
   * @param {PendingRequest} pending
   */
  _start_heartbeat(pending) {
    if (!pending.stream || pending.heartbeat_interval) return;

    // Open streaming response headers if not already sent
    if (!pending.res.headersSent) {
      pending.res.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'Transfer-Encoding': 'chunked',
        'Access-Control-Allow-Origin': '*'
      });
    }

    const created_at = new Date().toISOString();
    pending.heartbeat_interval = setInterval(() => {
      try {
        send_chunk(pending.res, {
          model: pending.model_name,
          created_at,
          message: { role: 'assistant', content: '' },
          done: false
        });
      } catch {
        // Client disconnected
        this._stop_heartbeat(pending);
      }
    }, 3000);
  }

  /**
   * Stop the heartbeat for a pending request
   * @param {PendingRequest} pending
   */
  _stop_heartbeat(pending) {
    if (pending.heartbeat_interval) {
      clearInterval(pending.heartbeat_interval);
      pending.heartbeat_interval = null;
    }
  }
}

export default RequestScheduler;
