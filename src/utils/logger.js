/**
 * Pino structured logger for Argus.
 *
 * Usage in each module:
 *   import { childLogger } from '../utils/logger.js';
 *   const logger = childLogger('module-name');
 *
 * Environment variables:
 *   ARGUS_LOG_LEVEL  — log level (default: 'info'). Set to 'debug' for MCP call details.
 *   ARGUS_LOG_PRETTY — '1' or any truthy value: force pino-pretty human-readable output.
 *                      '0' or empty string: force JSON output (useful in CI).
 *                      Unset: auto-detect — pino-pretty when stdout is a TTY, JSON otherwise.
 *
 * JSON output (default in CI) is compatible with Datadog / Grafana Loki / CloudWatch.
 */

import pino from 'pino';

function usePrettyOutput() {
  const env = process.env.ARGUS_LOG_PRETTY;
  if (env !== undefined) return env !== '0' && env !== '';
  return process.stdout.isTTY ?? false;
}

function createLogger() {
  const level = process.env.ARGUS_LOG_LEVEL ?? 'info';
  if (usePrettyOutput()) {
    try {
      return pino({ level, transport: { target: 'pino-pretty', options: { colorize: true } } });
    } catch {
      // pino-pretty not installed or failed to load — fall back to JSON
    }
  }
  return pino({ level });
}

export const logger = createLogger();

export const childLogger = (module) => logger.child({ module });
