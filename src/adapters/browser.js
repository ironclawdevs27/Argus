/**
 * CdpBrowserAdapter — facade over chrome-devtools-mcp.
 *
 * All analyzer modules call browser.* methods instead of mcp.* directly.
 * This single file is the only place that knows the chrome-devtools-mcp
 * API shape, so any future API change (parameter renames, new tool versions)
 * requires editing exactly one file.
 *
 * listConsole() and listNetwork() parse the markdown-text format that
 * chrome-devtools-mcp@latest returns, so callers always receive structured
 * arrays rather than raw text.
 *
 * listConsoleRaw(args) passes arbitrary args through unparsed — used by
 * issues-analyzer.js which calls list_console_messages({ types: ['issue'] }).
 */

import { parseConsoleMsgResponse, parseNetworkReqResponse } from '../utils/mcp-parsers.js';

export class CdpBrowserAdapter {
  constructor(mcp) { this._mcp = mcp; }

  // ── Navigation ──────────────────────────────────────────────────────────────
  navigate(url)            { return this._mcp.navigate_page({ url }); }

  // ── Evaluation & snapshots ──────────────────────────────────────────────────
  evaluate(fn)             { return this._mcp.evaluate_script({ function: fn }); }
  snapshot()               { return this._mcp.take_snapshot(); }
  screenshot(opts = {})    { return this._mcp.take_screenshot(opts); }
  heapSnapshot(opts = {})  { return this._mcp.take_memory_snapshot(opts); }

  // ── Interactions ────────────────────────────────────────────────────────────
  click(uid)               { return this._mcp.click({ uid }); }
  fill(uid, value)         { return this._mcp.fill({ uid, value }); }
  type(text)               { return this._mcp.type_text({ text }); }
  pressKey(key)            { return this._mcp.press_key({ key }); }
  hover(uid)               { return this._mcp.hover({ uid }); }
  drag(src, tgt)           { return this._mcp.drag({ from_uid: src, to_uid: tgt }); }
  uploadFile(uid, filePath) { return this._mcp.upload_file({ uid, filePath }); }
  handleDialog(accept, promptText = '') { return this._mcp.handle_dialog({ accept, promptText }); }
  waitFor(opts)            { return this._mcp.wait_for(opts); }

  // ── Viewport ────────────────────────────────────────────────────────────────
  emulate(viewport)        { return this._mcp.emulate({ viewport }); }
  emulateCpu(rate)         { return this._mcp.emulate_cpu({ throttlingRate: rate }); }
  resize(w, h)             { return this._mcp.resize_page({ width: w, height: h }); }

  // ── Network & performance ───────────────────────────────────────────────────
  getNetworkRequest(reqId) { return this._mcp.get_network_request({ requestId: reqId }); }
  lighthouse(url, opts = {}) { return this._mcp.lighthouse_audit({ url, ...opts }); }
  startTrace()             { return this._mcp.performance_start_trace({}); }
  stopTrace()              { return this._mcp.performance_stop_trace({}); }
  analyzeInsight(opts)     { return this._mcp.performance_analyze_insight(opts); }

  // ── Lifecycle ───────────────────────────────────────────────────────────────
  close()                  { return this._mcp.close(); }

  // ── Console & network lists (text-parsed) ───────────────────────────────────

  /** Returns structured array from list_console_messages (parses markdown text). */
  async listConsole() {
    const raw = await this._mcp.list_console_messages({});
    return parseConsoleMsgResponse(raw);
  }

  /** Returns structured array from list_network_requests (parses markdown text). */
  async listNetwork() {
    const raw = await this._mcp.list_network_requests({});
    return parseNetworkReqResponse(raw);
  }

  /**
   * Raw pass-through to list_console_messages with custom args.
   * Used by issues-analyzer.js for the DevTools Issues panel
   * (types: ['issue']) which returns structured data, not text.
   */
  listConsoleRaw(args = {}) { return this._mcp.list_console_messages(args); }
}
