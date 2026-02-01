/**
 * Model handler factory
 * Returns the appropriate handler based on model type
 */

import qwen3_handler from './qwen3.js';
import llama3_handler from './llama3.js';

const handlers = {
  qwen3: qwen3_handler,
  llama3: llama3_handler
};

/**
 * Get the appropriate model handler
 * @param {string} model_type - Model type ('qwen3' or 'llama3')
 * @returns {object} Model handler with format functions
 */
export function get_handler(model_type) {
  const handler = handlers[model_type];

  if (!handler) {
    throw new Error(`Unknown model type: ${model_type}. Supported types: ${Object.keys(handlers).join(', ')}`);
  }

  return handler;
}

export { qwen3_handler, llama3_handler };
