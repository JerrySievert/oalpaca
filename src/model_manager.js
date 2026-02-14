/**
 * Model Manager
 * Handles model lifecycle with LRU eviction and memory-aware loading.
 * Each model gets its own MCP server connections and tool sets.
 */

import { getLlama, readGgufFileInfo, GgufInsights } from 'node-llama-cpp';
import { McpClientManager } from './mcp_client.js';
import { detect_model_type } from './config.js';
import { get_handler } from './model_handlers/index.js';

const MAX_LOADED_MODELS = 3;
const MEMORY_RESERVE_BYTES = 512 * 1024 * 1024; // 512 MB safety buffer

/**
 * Tracks a loaded model and all its associated state
 */
class LoadedModelEntry {
  constructor({
    name,
    config,
    model,
    mcp_manager,
    handler,
    model_type,
    tools
  }) {
    this.name = name;
    this.config = config;
    this.model = model;
    this.mcp_manager = mcp_manager;
    this.handler = handler;
    this.model_type = model_type;
    this.tools = tools;
    this.loaded_at = Date.now();
    this.last_used_at = Date.now();
    this.active_contexts = 0;
  }

  touch() {
    this.last_used_at = Date.now();
  }
}

/**
 * Manages multiple models with LRU eviction and memory-aware loading
 */
export class ModelManager {
  constructor(config, debug_log) {
    this.config = config;
    this.debug_log = debug_log || (() => {});
    this.llama = null;
    this.loaded_models = new Map();
    this.gguf_insights = new Map();
    this.load_lock = Promise.resolve();
  }

  /**
   * Initialize the llama backend and pre-read GGUF file headers
   * for all configured models (fast — reads metadata only, no GPU)
   */
  async initialize() {
    this.llama = await getLlama();

    const model_names = Object.keys(this.config.models);
    console.log(`Configured models: ${model_names.join(', ')}`);

    for (const [name, entry] of Object.entries(this.config.models)) {
      try {
        const file_info = await readGgufFileInfo(entry.model_path);
        const insights = await GgufInsights.from(file_info, this.llama);
        this.gguf_insights.set(name, insights);
        const size_mb = Math.round(insights.modelSize / 1024 / 1024);
        console.log(`  ${name}: ${size_mb} MB (${entry.model_path})`);
      } catch (error) {
        console.error(
          `  ${name}: failed to read GGUF metadata: ${error.message}`
        );
      }
    }
  }

  /**
   * Get list of all configured model names
   * @returns {string[]}
   */
  get_model_names() {
    return Object.keys(this.config.models);
  }

  /**
   * Check if a model name is configured
   * @param {string} name
   * @returns {boolean}
   */
  has_model(name) {
    return name in this.config.models;
  }

  /**
   * Get the config for a specific model
   * @param {string} name
   * @returns {object|undefined}
   */
  get_model_config(name) {
    return this.config.models[name];
  }

  /**
   * Check if a model is currently loaded in memory
   * @param {string} name
   * @returns {boolean}
   */
  is_loaded(name) {
    return this.loaded_models.has(name);
  }

  /**
   * Ensure a model is loaded and return its LoadedModelEntry.
   * Serialized through load_lock to prevent concurrent load/unload races.
   * @param {string} name
   * @returns {Promise<LoadedModelEntry>}
   */
  async ensure_loaded(name) {
    // Fast path: already loaded
    const existing = this.loaded_models.get(name);
    if (existing) {
      existing.touch();
      return existing;
    }

    // Slow path: need to load. Serialize through load_lock.
    const do_load = async () => {
      // Re-check after acquiring lock (another request may have loaded it)
      if (this.loaded_models.has(name)) {
        const entry = this.loaded_models.get(name);
        entry.touch();
        return entry;
      }

      const model_config = this.config.models[name];
      if (!model_config) {
        throw new Error(`Unknown model: ${name}`);
      }

      await this._evict_if_needed(name);
      return await this._load_model(name, model_config);
    };

    this.load_lock = this.load_lock.then(do_load, do_load);
    return this.load_lock;
  }

  /**
   * Evict LRU models until there's enough memory for the new model,
   * or until the max loaded models cap is respected.
   * @param {string} name_to_load
   */
  async _evict_if_needed(name_to_load) {
    // Check max loaded models cap
    let must_evict_count = Math.max(
      0,
      this.loaded_models.size + 1 - MAX_LOADED_MODELS
    );

    // Check memory availability
    let need_memory_eviction = false;
    const insights = this.gguf_insights.get(name_to_load);
    if (insights) {
      try {
        const vram_state = await this.llama.getVramState();
        const model_reqs = insights.estimateModelResourceRequirements({
          gpuLayers: insights.totalLayers
        });
        const context_reqs = insights.estimateContextResourceRequirements({
          contextSize: this.config.models[name_to_load].context_size,
          modelGpuLayers: insights.totalLayers
        });
        const needed = model_reqs.gpuVram + context_reqs.gpuVram;
        const available = vram_state.free - MEMORY_RESERVE_BYTES;

        this.debug_log(
          `memory check for ${name_to_load}: need ${Math.round(needed / 1024 / 1024)} MB, ` +
            `available ${Math.round(available / 1024 / 1024)} MB ` +
            `(free ${Math.round(vram_state.free / 1024 / 1024)} MB - ` +
            `reserve ${Math.round(MEMORY_RESERVE_BYTES / 1024 / 1024)} MB)`
        );

        if (needed > available) {
          need_memory_eviction = true;
        }
      } catch (error) {
        this.debug_log(
          `memory check failed: ${error.message}, proceeding anyway`
        );
      }
    }

    // Evict LRU models as needed
    while (
      (must_evict_count > 0 || need_memory_eviction) &&
      this.loaded_models.size > 0
    ) {
      const victim = this._pick_lru_victim();
      if (!victim) {
        this.debug_log('cannot evict: all loaded models have active contexts');
        break;
      }

      this.debug_log(
        `evicting LRU model: ${victim.name} (last used ${Date.now() - victim.last_used_at}ms ago)`
      );
      await this._unload_model(victim.name);
      must_evict_count--;

      // Re-check memory after eviction
      if (need_memory_eviction && insights) {
        try {
          const vram_state = await this.llama.getVramState();
          const model_reqs = insights.estimateModelResourceRequirements({
            gpuLayers: insights.totalLayers
          });
          const context_reqs = insights.estimateContextResourceRequirements({
            contextSize: this.config.models[name_to_load].context_size,
            modelGpuLayers: insights.totalLayers
          });
          const needed = model_reqs.gpuVram + context_reqs.gpuVram;
          const available = vram_state.free - MEMORY_RESERVE_BYTES;

          if (needed <= available) {
            need_memory_eviction = false;
          }
        } catch {
          need_memory_eviction = false;
        }
      }
    }
  }

  /**
   * Pick the least recently used model that has no active contexts.
   * @returns {LoadedModelEntry|null}
   */
  _pick_lru_victim() {
    let oldest = null;
    for (const entry of this.loaded_models.values()) {
      if (entry.active_contexts > 0) continue;
      if (!oldest || entry.last_used_at < oldest.last_used_at) {
        oldest = entry;
      }
    }
    return oldest;
  }

  /**
   * Load a model and its MCP servers
   * @param {string} name
   * @param {object} model_config
   * @returns {Promise<LoadedModelEntry>}
   */
  async _load_model(name, model_config) {
    console.log(`Loading model: ${name}...`);
    const load_start = Date.now();

    const model = await this.llama.loadModel({
      modelPath: model_config.model_path,
      gpuLayers: model_config.gpu_layers
    });

    const mcp_manager = new McpClientManager();
    if (model_config.mcp_servers.length > 0) {
      console.log(`  Connecting MCP servers for ${name}...`);
      await mcp_manager.connect_all(model_config.mcp_servers);
    }

    const model_type = detect_model_type(name, model_config.model_type);
    const handler = get_handler(model_type);
    const tools = mcp_manager.get_all_tools();

    const entry = new LoadedModelEntry({
      name,
      config: model_config,
      model,
      mcp_manager,
      handler,
      model_type,
      tools
    });

    this.loaded_models.set(name, entry);
    const load_ms = Date.now() - load_start;
    console.log(
      `  Model loaded: ${name} (${load_ms}ms, ${tools.length} tools)`
    );
    return entry;
  }

  /**
   * Unload a model: dispose all resources, disconnect MCP servers
   * @param {string} name
   */
  async _unload_model(name) {
    const entry = this.loaded_models.get(name);
    if (!entry) return;

    console.log(`Unloading model: ${name}...`);
    this.loaded_models.delete(name);

    try {
      await entry.model.dispose();
    } catch (error) {
      console.error(`  Error disposing model ${name}: ${error.message}`);
    }

    try {
      await entry.mcp_manager.disconnect_all();
    } catch (error) {
      console.error(`  Error disconnecting MCP for ${name}: ${error.message}`);
    }

    console.log(`  Model unloaded: ${name}`);
  }

  /**
   * Increment active_contexts for a model (call when starting a request)
   * @param {string} name
   */
  acquire_context(name) {
    const entry = this.loaded_models.get(name);
    if (entry) entry.active_contexts++;
  }

  /**
   * Decrement active_contexts for a model (call when a request completes)
   * @param {string} name
   */
  release_context(name) {
    const entry = this.loaded_models.get(name);
    if (entry) entry.active_contexts--;
  }

  /**
   * Get model info objects for all configured models (for /api/tags)
   * @param {string[]|null} [allowed_models] - If provided, filter to only these model names
   * @returns {Array}
   */
  get_all_model_info(allowed_models) {
    const results = [];
    for (const [name, model_config] of Object.entries(this.config.models)) {
      if (allowed_models && !allowed_models.includes(name)) continue;
      const insights = this.gguf_insights.get(name);
      const model_type = detect_model_type(name, model_config.model_type);
      results.push({
        name,
        model: name,
        modified_at: new Date().toISOString(),
        size: insights ? insights.modelSize : 0,
        digest: 'sha256:' + '0'.repeat(64),
        details: {
          parent_model: '',
          format: 'gguf',
          family: model_type,
          families: [model_type],
          parameter_size: '',
          quantization_level: ''
        }
      });
    }
    return results;
  }

  /**
   * Get model info for currently loaded (running) models (for /api/ps)
   * @param {string[]|null} [allowed_models] - If provided, filter to only these model names
   * @returns {Array}
   */
  get_running_model_info(allowed_models) {
    const results = [];
    for (const entry of this.loaded_models.values()) {
      if (allowed_models && !allowed_models.includes(entry.name)) continue;
      const insights = this.gguf_insights.get(entry.name);
      results.push({
        name: entry.name,
        model: entry.name,
        size: insights ? insights.modelSize : 0,
        digest: 'sha256:' + '0'.repeat(64),
        expires_at: new Date(Date.now() + 300_000).toISOString(),
        size_vram: insights ? insights.modelSize : 0
      });
    }
    return results;
  }

  /**
   * Get detailed model info (for POST /api/show)
   * @param {string} name
   * @returns {object|null}
   */
  get_model_details(name) {
    const model_config = this.config.models[name];
    if (!model_config) return null;

    const model_type = detect_model_type(name, model_config.model_type);
    return {
      license: '',
      modelfile: `FROM ${model_config.model_path}`,
      parameters: `num_ctx ${model_config.context_size}`,
      template: '',
      details: {
        parent_model: '',
        format: 'gguf',
        family: model_type,
        families: [model_type],
        parameter_size: '',
        quantization_level: ''
      },
      model_info: {},
      modified_at: new Date().toISOString()
    };
  }

  /**
   * Graceful shutdown: unload all models, dispose llama instance
   */
  async shutdown() {
    for (const name of [...this.loaded_models.keys()]) {
      await this._unload_model(name);
    }
    if (this.llama) {
      try {
        await this.llama.dispose();
      } catch {
        // Ignore disposal errors during shutdown
      }
    }
  }
}

export default ModelManager;
