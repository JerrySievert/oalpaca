import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock node-llama-cpp before importing ModelManager
vi.mock('node-llama-cpp', () => ({
  getLlama: vi.fn(),
  readGgufFileInfo: vi.fn(),
  GgufInsights: { from: vi.fn() }
}));

// Mock McpClientManager
vi.mock('../src/mcp_client.js', () => ({
  McpClientManager: vi.fn(function () {
    return {
      connect_all: vi.fn().mockResolvedValue(undefined),
      get_all_tools: vi.fn().mockReturnValue([]),
      disconnect_all: vi.fn().mockResolvedValue(undefined)
    };
  })
}));

import { ModelManager } from '../src/model_manager.js';
import { getLlama, readGgufFileInfo, GgufInsights } from 'node-llama-cpp';

function make_config(models = {}) {
  return {
    models: {
      'test-model': {
        model_path: '/fake/model.gguf',
        context_size: 4096,
        mcp_servers: [],
        system_prompt: 'You are helpful.',
        assistant_name: 'Assistant',
        gpu_layers: undefined
      },
      ...models
    }
  };
}

function make_mock_llama() {
  return {
    loadModel: vi.fn().mockResolvedValue({
      dispose: vi.fn().mockResolvedValue(undefined)
    }),
    getVramState: vi.fn().mockResolvedValue({
      free: 8 * 1024 * 1024 * 1024, // 8 GB free
      total: 16 * 1024 * 1024 * 1024
    }),
    dispose: vi.fn().mockResolvedValue(undefined)
  };
}

function make_mock_insights(model_size = 1024 * 1024 * 1024) {
  return {
    modelSize: model_size,
    totalLayers: 32,
    estimateModelResourceRequirements: vi.fn().mockReturnValue({
      gpuVram: model_size
    }),
    estimateContextResourceRequirements: vi.fn().mockReturnValue({
      gpuVram: 256 * 1024 * 1024
    })
  };
}

describe('ModelManager', () => {
  let config;
  let mock_llama;
  let manager;

  beforeEach(() => {
    vi.clearAllMocks();
    config = make_config();
    mock_llama = make_mock_llama();
    getLlama.mockResolvedValue(mock_llama);
    readGgufFileInfo.mockResolvedValue({});
    GgufInsights.from.mockResolvedValue(make_mock_insights());
    manager = new ModelManager(config);
  });

  describe('constructor', () => {
    it('initializes with empty loaded_models map', () => {
      expect(manager.loaded_models.size).toBe(0);
    });

    it('stores config reference', () => {
      expect(manager.config).toBe(config);
    });
  });

  describe('initialize', () => {
    it('gets llama instance and reads GGUF metadata', async () => {
      await manager.initialize();

      expect(getLlama).toHaveBeenCalled();
      expect(readGgufFileInfo).toHaveBeenCalledWith('/fake/model.gguf');
      expect(GgufInsights.from).toHaveBeenCalled();
      expect(manager.gguf_insights.has('test-model')).toBe(true);
    });

    it('handles GGUF read errors gracefully', async () => {
      const error_spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      readGgufFileInfo.mockRejectedValue(new Error('file not found'));

      await manager.initialize();

      expect(manager.gguf_insights.has('test-model')).toBe(false);
      error_spy.mockRestore();
    });
  });

  describe('get_model_names', () => {
    it('returns configured model names', () => {
      expect(manager.get_model_names()).toEqual(['test-model']);
    });
  });

  describe('has_model', () => {
    it('returns true for configured model', () => {
      expect(manager.has_model('test-model')).toBe(true);
    });

    it('returns false for unknown model', () => {
      expect(manager.has_model('unknown')).toBe(false);
    });
  });

  describe('get_model_config', () => {
    it('returns config for existing model', () => {
      const cfg = manager.get_model_config('test-model');
      expect(cfg.context_size).toBe(4096);
    });

    it('returns undefined for unknown model', () => {
      expect(manager.get_model_config('nope')).toBeUndefined();
    });
  });

  describe('is_loaded', () => {
    it('returns false when model is not loaded', () => {
      expect(manager.is_loaded('test-model')).toBe(false);
    });

    it('returns true after model is loaded', async () => {
      await manager.initialize();
      await manager.ensure_loaded('test-model');
      expect(manager.is_loaded('test-model')).toBe(true);
    });
  });

  describe('ensure_loaded', () => {
    beforeEach(async () => {
      await manager.initialize();
    });

    it('loads and returns a model entry', async () => {
      const entry = await manager.ensure_loaded('test-model');

      expect(entry.name).toBe('test-model');
      expect(entry.config).toBe(config.models['test-model']);
      expect(entry.handler).toBeDefined();
      expect(mock_llama.loadModel).toHaveBeenCalled();
    });

    it('returns cached entry on second call', async () => {
      const entry1 = await manager.ensure_loaded('test-model');
      const entry2 = await manager.ensure_loaded('test-model');

      expect(entry1).toBe(entry2);
      expect(mock_llama.loadModel).toHaveBeenCalledTimes(1);
    });

    it('updates last_used_at on subsequent calls', async () => {
      const entry1 = await manager.ensure_loaded('test-model');
      const first_used = entry1.last_used_at;

      // Small delay
      await new Promise((r) => setTimeout(r, 10));

      await manager.ensure_loaded('test-model');
      expect(entry1.last_used_at).toBeGreaterThanOrEqual(first_used);
    });

    it('throws for unknown model', async () => {
      await expect(manager.ensure_loaded('unknown')).rejects.toThrow(
        'Unknown model: unknown'
      );
    });
  });

  describe('acquire_context / release_context', () => {
    it('increments and decrements active_contexts', async () => {
      await manager.initialize();
      const entry = await manager.ensure_loaded('test-model');

      expect(entry.active_contexts).toBe(0);

      manager.acquire_context('test-model');
      expect(entry.active_contexts).toBe(1);

      manager.acquire_context('test-model');
      expect(entry.active_contexts).toBe(2);

      manager.release_context('test-model');
      expect(entry.active_contexts).toBe(1);
    });

    it('handles acquire/release for non-loaded model gracefully', () => {
      // Should not throw
      manager.acquire_context('not-loaded');
      manager.release_context('not-loaded');
    });
  });

  describe('get_all_model_info', () => {
    it('returns info for all configured models', () => {
      const infos = manager.get_all_model_info();
      expect(infos).toHaveLength(1);
      expect(infos[0].name).toBe('test-model');
      expect(infos[0].details.format).toBe('gguf');
    });

    it('filters by allowed_models when provided', () => {
      const infos = manager.get_all_model_info(['other-model']);
      expect(infos).toHaveLength(0);
    });

    it('includes model when in allowed_models', () => {
      const infos = manager.get_all_model_info(['test-model']);
      expect(infos).toHaveLength(1);
    });

    it('uses insights for size when available', async () => {
      await manager.initialize();
      const infos = manager.get_all_model_info();
      expect(infos[0].size).toBe(1024 * 1024 * 1024);
    });

    it('uses 0 for size when insights not available', () => {
      const infos = manager.get_all_model_info();
      expect(infos[0].size).toBe(0);
    });
  });

  describe('get_running_model_info', () => {
    it('returns empty when no models loaded', () => {
      expect(manager.get_running_model_info()).toEqual([]);
    });

    it('returns info for loaded models', async () => {
      await manager.initialize();
      await manager.ensure_loaded('test-model');

      const infos = manager.get_running_model_info();
      expect(infos).toHaveLength(1);
      expect(infos[0].name).toBe('test-model');
    });

    it('filters by allowed_models', async () => {
      await manager.initialize();
      await manager.ensure_loaded('test-model');

      const infos = manager.get_running_model_info(['other-model']);
      expect(infos).toHaveLength(0);
    });
  });

  describe('get_model_details', () => {
    it('returns details for configured model', () => {
      const details = manager.get_model_details('test-model');
      expect(details).not.toBeNull();
      expect(details.details.format).toBe('gguf');
      expect(details.parameters).toContain('4096');
    });

    it('returns null for unknown model', () => {
      expect(manager.get_model_details('unknown')).toBeNull();
    });
  });

  describe('_pick_lru_victim', () => {
    it('returns null when no models loaded', () => {
      expect(manager._pick_lru_victim()).toBeNull();
    });

    it('picks the model with oldest last_used_at', async () => {
      await manager.initialize();

      // Add a second model to config
      config.models['model-b'] = { ...config.models['test-model'] };

      await manager.ensure_loaded('test-model');
      await new Promise((r) => setTimeout(r, 10));
      await manager.ensure_loaded('model-b');

      const victim = manager._pick_lru_victim();
      expect(victim.name).toBe('test-model');
    });

    it('skips models with active contexts', async () => {
      await manager.initialize();

      config.models['model-b'] = { ...config.models['test-model'] };

      await manager.ensure_loaded('test-model');
      await new Promise((r) => setTimeout(r, 10));
      await manager.ensure_loaded('model-b');

      // Lock the LRU victim
      manager.acquire_context('test-model');

      const victim = manager._pick_lru_victim();
      expect(victim.name).toBe('model-b');
    });

    it('returns null if all models have active contexts', async () => {
      await manager.initialize();
      await manager.ensure_loaded('test-model');
      manager.acquire_context('test-model');

      expect(manager._pick_lru_victim()).toBeNull();
    });
  });

  describe('shutdown', () => {
    it('unloads all models and disposes llama', async () => {
      await manager.initialize();
      await manager.ensure_loaded('test-model');

      await manager.shutdown();

      expect(manager.loaded_models.size).toBe(0);
      expect(mock_llama.dispose).toHaveBeenCalled();
    });

    it('handles disposal errors gracefully', async () => {
      await manager.initialize();
      mock_llama.dispose.mockRejectedValue(new Error('dispose error'));

      // Should not throw
      await manager.shutdown();
    });
  });

  describe('_unload_model', () => {
    it('handles model dispose errors gracefully', async () => {
      const error_spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await manager.initialize();
      await manager.ensure_loaded('test-model');

      // Make dispose throw
      const entry = manager.loaded_models.get('test-model');
      entry.model.dispose = vi
        .fn()
        .mockRejectedValue(new Error('dispose boom'));

      await manager._unload_model('test-model');

      expect(manager.loaded_models.has('test-model')).toBe(false);
      expect(error_spy).toHaveBeenCalledWith(
        expect.stringContaining('Error disposing model')
      );
      error_spy.mockRestore();
    });

    it('handles MCP disconnect errors gracefully', async () => {
      const error_spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await manager.initialize();
      await manager.ensure_loaded('test-model');

      // Make MCP disconnect throw
      const entry = manager.loaded_models.get('test-model');
      entry.mcp_manager.disconnect_all = vi
        .fn()
        .mockRejectedValue(new Error('mcp boom'));

      await manager._unload_model('test-model');

      expect(manager.loaded_models.has('test-model')).toBe(false);
      expect(error_spy).toHaveBeenCalledWith(
        expect.stringContaining('Error disconnecting MCP')
      );
      error_spy.mockRestore();
    });
  });

  describe('_load_model', () => {
    it('connects MCP servers when configured', async () => {
      const mcp_config = make_config({
        'mcp-model': {
          model_path: '/fake/model.gguf',
          context_size: 4096,
          mcp_servers: [
            { name: 'srv', transport: 'stdio', command: 'node', args: [] }
          ],
          system_prompt: '',
          assistant_name: 'Assistant',
          gpu_layers: undefined
        }
      });
      // Remove the default test-model to keep things clean
      delete mcp_config.models['test-model'];
      const mcp_manager = new ModelManager(mcp_config);
      await mcp_manager.initialize();

      const entry = await mcp_manager.ensure_loaded('mcp-model');
      expect(entry.mcp_manager.connect_all).toHaveBeenCalledWith(
        mcp_config.models['mcp-model'].mcp_servers
      );
    });
  });

  describe('_evict_if_needed', () => {
    it('triggers memory-based eviction when VRAM is insufficient', async () => {
      await manager.initialize();

      // Load 2 models so we have something to evict
      config.models['model-a'] = { ...config.models['test-model'] };
      await manager.ensure_loaded('test-model');
      await new Promise((r) => setTimeout(r, 5));
      await manager.ensure_loaded('model-a');

      // Mock VRAM as nearly full
      mock_llama.getVramState.mockResolvedValue({
        free: 100 * 1024 * 1024, // Only 100 MB free
        total: 16 * 1024 * 1024 * 1024
      });

      // Mock insights to need more than available
      const tight_insights = make_mock_insights();
      tight_insights.estimateModelResourceRequirements.mockReturnValue({
        gpuVram: 2 * 1024 * 1024 * 1024
      });
      tight_insights.estimateContextResourceRequirements.mockReturnValue({
        gpuVram: 256 * 1024 * 1024
      });
      manager.gguf_insights.set('new-model', tight_insights);

      config.models['new-model'] = { ...config.models['test-model'] };

      await manager._evict_if_needed('new-model');

      // Should have evicted at least one model
      expect(manager.loaded_models.size).toBeLessThan(2);
    });
  });

  describe('eviction', () => {
    it('evicts LRU model when max loaded models exceeded', async () => {
      // Set up 4 models in config (max is 3)
      config.models['model-a'] = { ...config.models['test-model'] };
      config.models['model-b'] = { ...config.models['test-model'] };
      config.models['model-c'] = { ...config.models['test-model'] };

      await manager.initialize();

      await manager.ensure_loaded('test-model');
      await new Promise((r) => setTimeout(r, 5));
      await manager.ensure_loaded('model-a');
      await new Promise((r) => setTimeout(r, 5));
      await manager.ensure_loaded('model-b');

      expect(manager.loaded_models.size).toBe(3);

      // Loading a 4th should evict the LRU (test-model)
      await manager.ensure_loaded('model-c');

      expect(manager.loaded_models.size).toBe(3);
      expect(manager.is_loaded('test-model')).toBe(false);
      expect(manager.is_loaded('model-c')).toBe(true);
    });
  });
});
