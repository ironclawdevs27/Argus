/**
 * Argus Telemetry (v9.3)
 *
 * OpenTelemetry tracing + metrics for Argus crawl pipeline.
 *
 * Default: no-op provider — zero overhead when OTEL_EXPORTER_OTLP_ENDPOINT is not set.
 * Dev: set ARGUS_OTEL_CONSOLE=1 to print spans to stdout (no OTLP endpoint needed).
 * Production: set OTEL_EXPORTER_OTLP_ENDPOINT to ship to Jaeger / Grafana Tempo / etc.
 */

import { trace, metrics, SpanStatusCode } from '@opentelemetry/api';
import { childLogger } from './logger.js';

const logger = childLogger('telemetry');

// ── SDK bootstrap (lazy — only when an exporter endpoint is configured) ────────

let _sdkStarted = false;

async function maybeStartSdk() {
  if (_sdkStarted) return;
  _sdkStarted = true;

  const hasOtlpEndpoint = !!process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const consoleMode     = process.env.ARGUS_OTEL_CONSOLE === '1';

  if (!hasOtlpEndpoint && !consoleMode) return; // no-op path — skip SDK init entirely

  try {
    const { resourceFromAttributes } = await import('@opentelemetry/resources');
    const resource = resourceFromAttributes({
      'service.name':    'argus',
      'service.version': '9.4.4',
    });

    if (consoleMode && !hasOtlpEndpoint) {
      // Lightweight console-only mode for local development
      const { NodeTracerProvider, ConsoleSpanExporter, SimpleSpanProcessor } = await import('@opentelemetry/sdk-trace-node');
      const { PeriodicExportingMetricReader, MeterProvider, ConsoleMetricExporter } = await import('@opentelemetry/sdk-metrics');

      const provider = new NodeTracerProvider({
        resource,
        spanProcessors: [new SimpleSpanProcessor(new ConsoleSpanExporter())],
      });
      provider.register();

      const meterProvider = new MeterProvider({
        resource,
        readers: [new PeriodicExportingMetricReader({
          exporter:              new ConsoleMetricExporter(),
          exportIntervalMillis:  60_000,
        })],
      });
      metrics.setGlobalMeterProvider(meterProvider);
      logger.info('[ARGUS/telemetry] Console mode — spans printed to stdout');
      return;
    }

    // Full OTLP export
    const { NodeSDK }                          = await import('@opentelemetry/sdk-node');
    const { OTLPTraceExporter }                = await import('@opentelemetry/exporter-trace-otlp-http');
    const { OTLPMetricExporter }               = await import('@opentelemetry/exporter-metrics-otlp-http');
    const { PeriodicExportingMetricReader }     = await import('@opentelemetry/sdk-metrics');

    const sdk = new NodeSDK({
      resource,
      traceExporter: new OTLPTraceExporter(),
      metricReader: new PeriodicExportingMetricReader({
        exporter:             new OTLPMetricExporter(),
        exportIntervalMillis: 30_000,
      }),
    });

    sdk.start();
    logger.info(`[ARGUS/telemetry] OTLP tracing → ${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}`);

    process.on('beforeExit', async () => {
      try { await sdk.shutdown(); } catch {}
    });
  } catch (err) {
    // OTel SDK missing or init failure — degrade silently to no-op
    logger.warn(`[ARGUS/telemetry] SDK init failed (${err.message}) — running without tracing`);
  }
}

// ── Tracer / Meter accessors ───────────────────────────────────────────────────

function getTracer() {
  return trace.getTracer('argus', '9.3.0');
}

function getMeter() {
  return metrics.getMeter('argus', '9.3.0');
}

// ── Metric instruments (created lazily) ───────────────────────────────────────

let _findingsCounter   = null;
let _flakyCounter      = null;
let _analyzerHistogram = null;
let _crawlHistogram    = null;
let _newFindingsGauge  = null;

function findingsCounter() {
  if (!_findingsCounter) _findingsCounter = getMeter().createCounter('argus.findings', { description: 'Total findings emitted' });
  return _findingsCounter;
}

function flakyCounter() {
  if (!_flakyCounter) _flakyCounter = getMeter().createCounter('argus.flaky_findings', { description: 'Findings downgraded to flaky' });
  return _flakyCounter;
}

function analyzerHistogram() {
  if (!_analyzerHistogram) _analyzerHistogram = getMeter().createHistogram('argus.analyzer.duration', { description: 'Analyzer wall-clock ms', unit: 'ms' });
  return _analyzerHistogram;
}

function crawlHistogram() {
  if (!_crawlHistogram) _crawlHistogram = getMeter().createHistogram('argus.crawl.duration', { description: 'Per-route crawl wall-clock ms', unit: 'ms' });
  return _crawlHistogram;
}

function newFindingsGauge() {
  if (!_newFindingsGauge) _newFindingsGauge = getMeter().createUpDownCounter('argus.new_findings', { description: 'Net new findings vs baseline in this run' });
  return _newFindingsGauge;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Wrap an async function in an OTel span.
 *
 * @param {string}   spanName  - span name (e.g. 'argus.crawl_route')
 * @param {object}   attrs     - span attributes (added at creation)
 * @param {Function} fn        - async function to execute inside the span
 * @returns {*} Result of fn()
 */
export async function startSpan(spanName, attrs, fn) {
  await maybeStartSdk();
  const tracer = getTracer();
  return tracer.startActiveSpan(spanName, { attributes: attrs ?? {} }, async (span) => {
    const t0 = Date.now();
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      span.recordException(err);
      throw err;
    } finally {
      span.end();
      const ms = Date.now() - t0;
      if (spanName === 'argus.analyzer')    analyzerHistogram().record(ms, attrs ?? {});
      if (spanName === 'argus.crawl_route') crawlHistogram().record(ms, attrs ?? {});
    }
  });
}

/**
 * Record a finding metric.
 *
 * @param {string} type     - finding type (e.g. 'console_error')
 * @param {string} severity - 'critical' | 'warning' | 'info'
 * @param {string} route    - route name
 */
export function recordFinding(type, severity, route) {
  try {
    findingsCounter().add(1, { type, severity, route: route ?? '' });
  } catch { /* metrics not configured — no-op */ }
}

/**
 * Record flaky findings count.
 */
export function recordFlaky(count, route) {
  try {
    if (count > 0) flakyCounter().add(count, { route: route ?? '' });
  } catch { /* no-op */ }
}

/**
 * Record net-new findings delta from baseline.
 */
export function recordNewFindings(delta) {
  try {
    if (delta !== 0) newFindingsGauge().add(delta);
  } catch { /* no-op */ }
}
