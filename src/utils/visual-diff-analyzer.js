/**
 * ARGUS Visual Regression Analyzer (Sprint 3 — A8)
 *
 * Per-route visual regression detection via screenshot baseline comparison.
 * Takes a PNG screenshot, compares it pixel-by-pixel against a stored baseline,
 * and emits a finding when the diff exceeds the configured threshold.
 *
 * Works in headless Chrome — uses the Performance API screenshot path, not Lighthouse.
 *
 * Findings emitted:
 *   visual_baseline_created — info, first run for a URL (baseline saved, no prior exists)
 *   visual_regression       — warning ≥0.1%, critical ≥5% pixels changed
 *   visual_diff_summary     — info, always emitted with full diff metrics
 *
 * Baseline storage: {config.outputDir}/baselines/screenshots/{slug}.png
 * Override via opts.baselineDir for testing.
 */

import fs   from 'fs';
import path from 'path';
import os   from 'os';
import { PNG }        from 'pngjs';
import pixelmatch     from 'pixelmatch';
import { registerExpensive } from '../registry.js';
import { childLogger }       from './logger.js';
import { slugify }           from './slug.js';
import { config, thresholds } from '../config/targets.js';

const logger = childLogger('visual-diff');

// ── Thresholds ─────────────────────────────────────────────────────────────────
const WARN_PERCENT = thresholds.visual?.warnPercent ?? 0.1;  // %
const CRIT_PERCENT = thresholds.visual?.critPercent ?? 5.0;  // %

// ── PNG helpers ────────────────────────────────────────────────────────────────

function cropPng(img, width, height) {
  if (img.width === width && img.height === height) return img;
  const out = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = (y * img.width + x) * 4;
      const dst = (y * width + x) * 4;
      out.data[dst]     = img.data[src];
      out.data[dst + 1] = img.data[src + 1];
      out.data[dst + 2] = img.data[src + 2];
      out.data[dst + 3] = img.data[src + 3];
    }
  }
  return out;
}

/**
 * Compare two PNG Buffers pixel-by-pixel using pixelmatch.
 *
 * @param {Buffer} bufA
 * @param {Buffer} bufB
 * @returns {{ diffPixels: number, totalPixels: number, diffPercent: number }}
 */
function comparePngBuffers(bufA, bufB) {
  const imgA = PNG.sync.read(bufA);
  const imgB = PNG.sync.read(bufB);

  const width  = Math.min(imgA.width, imgB.width);
  const height = Math.min(imgA.height, imgB.height);

  if (width === 0 || height === 0) {
    throw new Error(`visual-diff: zero-dimension PNG (${imgA.width}×${imgA.height} vs ${imgB.width}×${imgB.height})`);
  }

  const croppedA = cropPng(imgA, width, height);
  const croppedB = cropPng(imgB, width, height);
  const diff     = new PNG({ width, height });

  const diffPixels  = pixelmatch(croppedA.data, croppedB.data, diff.data, width, height, { threshold: 0.1 });
  const totalPixels = width * height;
  const diffPercent = (diffPixels / totalPixels) * 100;

  return { diffPixels, totalPixels, diffPercent };
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Capture a screenshot of `url` and compare against the stored baseline.
 *
 * First run (no baseline): saves the screenshot as the new baseline and returns
 * a `visual_baseline_created` info finding.
 *
 * Subsequent runs: compares pixel-by-pixel and emits `visual_regression` when
 * the diff exceeds the threshold, plus always emits `visual_diff_summary`.
 *
 * @param {object}  browser          - CdpBrowserAdapter
 * @param {string}  url              - Page URL (already loaded)
 * @param {object}  [opts]
 * @param {string}  [opts.baselineDir] - Override baseline storage directory
 * @returns {Promise<object[]>}
 */
export async function analyzeVisualRegression(browser, url, opts = {}) {
  const findings = [];

  // ── 1. Take screenshot ──────────────────────────────────────────────────────
  // Use filePath so the MCP server writes the PNG to disk — take_screenshot
  // returns an image content block, not { data: base64 }, so the filePath
  // approach is the only reliable way to get raw PNG bytes in headless mode.
  const tmpPath = path.join(os.tmpdir(), `argus-visual-${Date.now()}-${slugify(url)}.png`);
  try {
    await browser.screenshot({ format: 'png', filePath: tmpPath });
  } catch (err) {
    logger.warn(`[ARGUS] visual-diff: screenshot failed for ${url}: ${err.message}`);
    return findings;
  }

  let currentBuf;
  try {
    currentBuf = fs.readFileSync(tmpPath);
  } catch (err) {
    logger.warn(`[ARGUS] visual-diff: could not read screenshot from ${tmpPath}: ${err.message}`);
    return findings;
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }

  if (!currentBuf || currentBuf.length === 0) {
    logger.warn(`[ARGUS] visual-diff: empty screenshot for ${url}`);
    return findings;
  }

  // ── 2. Resolve baseline path ────────────────────────────────────────────────
  const baselineDir = opts.baselineDir ??
    path.join(config.outputDir, 'baselines', 'screenshots');

  try {
    fs.mkdirSync(baselineDir, { recursive: true });
  } catch (err) {
    logger.warn(`[ARGUS] visual-diff: could not create baseline dir ${baselineDir}: ${err.message}`);
    return findings;
  }

  const slug         = slugify(url);
  const baselinePath = path.join(baselineDir, `${slug}.png`);

  // ── 3. First run: save baseline ─────────────────────────────────────────────
  if (!fs.existsSync(baselinePath)) {
    try {
      fs.writeFileSync(baselinePath, currentBuf);
    } catch (err) {
      logger.warn(`[ARGUS] visual-diff: could not write baseline ${baselinePath}: ${err.message}`);
      return findings;
    }

    findings.push({
      type:     'visual_baseline_created',
      message:  `Visual baseline saved for ${url} — next run will compare against this snapshot`,
      severity: 'info',
      url,
      baselinePath,
    });
    return findings;
  }

  // ── 4. Compare against existing baseline ────────────────────────────────────
  let result;
  try {
    const baselineBuf = fs.readFileSync(baselinePath);
    result = comparePngBuffers(baselineBuf, currentBuf);
  } catch (err) {
    logger.warn(`[ARGUS] visual-diff: comparison failed for ${url}: ${err.message}`);
    return findings;
  }

  const { diffPixels, totalPixels, diffPercent } = result;

  // ── 5. Emit regression finding if threshold exceeded ────────────────────────
  if (diffPercent >= WARN_PERCENT) {
    const sev = diffPercent >= CRIT_PERCENT ? 'critical' : 'warning';
    findings.push({
      type:        'visual_regression',
      diffPercent: parseFloat(diffPercent.toFixed(3)),
      diffPixels,
      totalPixels,
      threshold:   WARN_PERCENT,
      message:     `Visual regression: ${diffPercent.toFixed(2)}% pixels changed — threshold ${WARN_PERCENT}% (warning) / ${CRIT_PERCENT}% (critical)`,
      severity:    sev,
      url,
    });
  }

  // ── 6. Summary — always emitted ─────────────────────────────────────────────
  findings.push({
    type:        'visual_diff_summary',
    diffPercent: parseFloat(diffPercent.toFixed(3)),
    diffPixels,
    totalPixels,
    message:     `Visual diff: ${diffPercent.toFixed(3)}% (${diffPixels}/${totalPixels} pixels changed)`,
    severity:    'info',
    url,
  });

  return findings;
}

// ── Self-registration ──────────────────────────────────────────────────────────
registerExpensive({
  name:    'visual',
  analyze: (browser, url) => analyzeVisualRegression(browser, url),
});
