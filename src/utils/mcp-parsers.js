/**
 * Text-format parsers for chrome-devtools-mcp responses.
 *
 * chrome-devtools-mcp@latest returns list_console_messages and
 * list_network_requests as human-readable markdown text rather than JSON.
 * These parsers extract structured objects so the rest of the pipeline
 * can work with consistent data shapes regardless of MCP response format.
 *
 * Extracted from watch-mode.js and promoted to a shared module so
 * CdpBrowserAdapter can use them in listConsole() and listNetwork().
 */

import { normalizeArray } from './flow-runner.js';

/**
 * Parse the text response from list_console_messages.
 * Format: "msgid=N [level] text (N args)\n..."
 * @param {any} raw - Raw value returned by the MCP tool
 * @returns {object[]}
 */
export function parseConsoleMsgResponse(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'object') return normalizeArray(raw);
  if (typeof raw !== 'string') return [];
  const msgs = [];
  const re = /msgid=(\d+)\s+\[(\w+)\]\s+(.*?)(?:\s+\(\d+\s+args?\))?$/gm;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const [, msgid, rawLevel, text] = m;
    const level = rawLevel === 'warn' ? 'warning' : rawLevel.toLowerCase();
    msgs.push({ _msgid: Number(msgid), level, text, message: text });
  }
  return msgs;
}

/**
 * Parse the text response from list_network_requests.
 * Format: "reqid=N METHOD URL [STATUS]\n..."
 * @param {any} raw - Raw value returned by the MCP tool
 * @returns {object[]}
 */
export function parseNetworkReqResponse(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'object') return normalizeArray(raw);
  if (typeof raw !== 'string') return [];
  const reqs = [];
  const re = /reqid=(\d+)\s+(\w+)\s+(\S+)\s+\[(\d+)[^\]]*\]/gm;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const [, reqid, method, url, statusStr] = m;
    const status = parseInt(statusStr, 10);
    reqs.push({ _reqid: Number(reqid), requestId: Number(reqid), method, url, status, statusCode: status });
  }
  return reqs;
}
