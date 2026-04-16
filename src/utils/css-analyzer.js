/**
 * ARGUS CSS Analyzer
 *
 * Works with React + SCSS projects. SCSS is compiled to CSS before the browser
 * sees it, so this analyzer works on the live compiled output.
 *
 * React-aware features:
 *   - CSS Modules: detects hashed class names (_button_abc123) and maps them
 *     back to readable component names from data-* attributes and element context
 *   - Inline style conflicts: detects React inline style props that override
 *     stylesheet declarations on the same element
 *   - SCSS compiled source: reads sourceMappingURL comments to attribute rules
 *     back to original .scss files where possible
 *   - CSS-in-JS (styled-components/emotion): inline <style> tags are analyzed
 *     the same way as external stylesheets
 *
 * Injected via evaluate_script into the live page to analyze:
 *   1. Which CSS rules are actually applied to matched elements
 *   2. Which properties are overridden (cascade conflicts)
 *   3. Which styles are leaking from unexpected components/sources
 *   4. Unused rules — declared but no element matches them
 *   5. React inline style conflicts with stylesheet declarations
 *   6. CSS Modules health (hashed class name leakage across components)
 *
 * Returns a structured JSON report that Claude Code processes into bug entries.
 */

/**
 * JavaScript string injected into the page via mcp.evaluate_script.
 * Runs entirely in the page context — no Node.js APIs available here.
 */
export const CSS_ANALYSIS_SCRIPT = `
() => {
  const report = {
    stylesheetSources: [],
    overriddenProperties: [],
    unusedRules: [],
    componentLeaks: [],
    inlineStyleConflicts: [],
    cssModulesDetected: false,
    scssSourceFiles: [],
    summary: { totalRules: 0, appliedRules: 0, unusedRules: 0, overrides: 0, leaks: 0, inlineConflicts: 0 }
  };

  // ── 1. Collect all stylesheets and their sources ───────────────────────────
  const sheets = Array.from(document.styleSheets);
  for (const sheet of sheets) {
    try {
      const source = sheet.href ?? (sheet.ownerNode?.tagName === 'STYLE' ? 'inline' : 'unknown');
      const ruleCount = sheet.cssRules?.length ?? 0;
      report.stylesheetSources.push({ source, ruleCount });
      report.summary.totalRules += ruleCount;
    } catch {
      // Cross-origin stylesheet — can't access cssRules
      report.stylesheetSources.push({ source: sheet.href ?? 'cross-origin', ruleCount: -1, blocked: true });
    }
  }

  // ── 2. Flatten all accessible CSS rules ───────────────────────────────────
  const allRules = [];
  for (const sheet of sheets) {
    let rules;
    try { rules = Array.from(sheet.cssRules ?? []); } catch { continue; }
    const sheetSource = sheet.href ?? 'inline';

    for (const rule of rules) {
      if (rule.type === CSSRule.STYLE_RULE) {
        allRules.push({ selector: rule.selectorText, declarations: rule.style, source: sheetSource, rule });
      }
      // Handle @media rules — flatten their contents
      if (rule.type === CSSRule.MEDIA_RULE) {
        try {
          for (const mediaRule of Array.from(rule.cssRules ?? [])) {
            if (mediaRule.type === CSSRule.STYLE_RULE) {
              allRules.push({ selector: mediaRule.selectorText, declarations: mediaRule.style, source: sheetSource + ' (@media)', rule: mediaRule });
            }
          }
        } catch {}
      }
    }
  }

  // ── 3. Check each rule: does it match any element? ─────────────────────────
  for (const { selector, declarations, source, rule } of allRules) {
    if (!selector) continue;
    let matched = false;
    try {
      matched = document.querySelectorAll(selector).length > 0;
    } catch {
      // Invalid selector (e.g. vendor-prefixed pseudo-elements) — skip
      continue;
    }

    if (!matched) {
      report.unusedRules.push({
        selector,
        source,
        propertyCount: declarations.length,
      });
      report.summary.unusedRules++;
    } else {
      report.summary.appliedRules++;
    }
  }

  // ── 4. Detect property overrides (cascade conflicts) ──────────────────────
  // For each matched element, collect all rules that apply and find properties
  // declared more than once (the losers are overridden).
  const keyElements = [
    ...Array.from(document.querySelectorAll('h1,h2,h3,p,button,a,input,nav,header,footer,main,section,article')).slice(0, 50)
  ];

  for (const el of keyElements) {
    const elementRules = []; // { property, value, source, priority, selector }

    for (const { selector, declarations, source } of allRules) {
      let matches = false;
      try { matches = el.matches(selector); } catch { continue; }
      if (!matches) continue;

      for (let i = 0; i < declarations.length; i++) {
        const prop = declarations.item(i);
        const value = declarations.getPropertyValue(prop);
        const priority = declarations.getPropertyPriority(prop);
        elementRules.push({ property: prop, value, source, priority, selector });
      }
    }

    // Group by property — more than one entry = override
    const byProp = {};
    for (const entry of elementRules) {
      if (!byProp[entry.property]) byProp[entry.property] = [];
      byProp[entry.property].push(entry);
    }

    for (const [property, entries] of Object.entries(byProp)) {
      if (entries.length <= 1) continue;

      const tag = el.tagName.toLowerCase();
      const id = el.id ? '#' + el.id : '';
      const cls = el.className && typeof el.className === 'string'
        ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.')
        : '';
      const elementDesc = tag + id + cls;

      // Detect !important overrides — higher severity
      const hasImportant = entries.some(e => e.priority === 'important');

      report.overriddenProperties.push({
        element: elementDesc,
        property,
        declarations: entries.map(e => ({ selector: e.selector, value: e.value, source: e.source, important: e.priority === 'important' })),
        hasImportant,
        overrideCount: entries.length,
      });
      report.summary.overrides++;
    }
  }

  // ── 5. CSS Modules detection ───────────────────────────────────────────────
  // Detect if the project uses CSS Modules by checking for hashed class names
  // on DOM elements (pattern: _ComponentName_classname_hash or ComponentName_class_hash)
  const allClassNames = Array.from(document.querySelectorAll('[class]'))
    .flatMap(el => Array.from(el.classList));
  const cssModulePattern = /^_?[A-Za-z][\\w-]*_[A-Za-z][\\w-]*_[A-Za-z0-9]{4,}$/;
  const hashedClasses = allClassNames.filter(c => cssModulePattern.test(c));
  report.cssModulesDetected = hashedClasses.length > 0;

  if (report.cssModulesDetected) {
    // Extract readable component names from the hash pattern
    // e.g. _Button_primary_abc123 → component = "Button"
    const moduleComponents = new Set();
    for (const cls of hashedClasses) {
      const parts = cls.replace(/^_/, '').split('_');
      if (parts.length >= 2) moduleComponents.add(parts[0]);
    }
    report.cssModulesComponents = Array.from(moduleComponents);
  }

  // ── 6. Component style leak detection (global SCSS / BEM only) ────────────
  // Skip for CSS Modules — hashed class names are intentionally scoped.
  // Only check BEM selectors in non-hashed, non-CSS-Modules stylesheets.
  const componentPatterns = [
    /\\.([\\w-]+)__([\\w-]+)/,         // BEM: .block__element
    /\\.([\\w-]+)--([\\w-]+)/,         // BEM modifier: .block--modifier
    /\\[data-component="([^"]+)"\\]/,  // data-component attribute selectors
  ];

  for (const { selector, source } of allRules) {
    if (!selector) continue;
    // Skip CSS Modules hashed selectors entirely
    if (/\\._?[A-Z][\\w]*_[\\w-]+_[A-Za-z0-9]{4,}/.test(selector)) continue;
    for (const pattern of componentPatterns) {
      const match = selector.match(pattern);
      if (!match) continue;
      const componentName = match[1];
      const sourceFile = source.split('/').pop() ?? source;
      if (!sourceFile.toLowerCase().includes(componentName.toLowerCase()) && source !== 'inline') {
        report.componentLeaks.push({
          selector,
          componentHint: componentName,
          foundInSource: source,
          description: \`Selector "\${selector}" suggests component "\${componentName}" but was found in "\${sourceFile}"\`,
        });
        report.summary.leaks++;
      }
      break;
    }
  }

  // ── 7. SCSS source file detection ─────────────────────────────────────────
  // Read sourceMappingURL comments from inline <style> tags to trace compiled
  // CSS back to original .scss source files where source maps are available.
  const styleTags = Array.from(document.querySelectorAll('style'));
  for (const tag of styleTags) {
    const content = tag.textContent ?? '';
    const sourceMapMatch = content.match(/\\/\\*#\\s*sourceMappingURL=([^\\s*]+)/);
    if (sourceMapMatch) {
      report.scssSourceFiles = report.scssSourceFiles || [];
      report.scssSourceFiles.push({ sourceMap: sourceMapMatch[1], inline: true });
    }
  }

  // ── 8. React inline style conflicts ───────────────────────────────────────
  // Find React elements with style="" attributes where the inline value
  // overrides a stylesheet declaration on the same property.
  // Common source of hard-to-debug style issues in React components.
  report.inlineStyleConflicts = [];
  const elementsWithInlineStyles = Array.from(
    document.querySelectorAll('[style]')
  ).slice(0, 100);

  for (const el of elementsWithInlineStyles) {
    const inlineProps = {};
    for (let i = 0; i < el.style.length; i++) {
      const prop = el.style.item(i);
      inlineProps[prop] = el.style.getPropertyValue(prop);
    }

    for (const { selector, declarations, source } of allRules) {
      let matches = false;
      try { matches = el.matches(selector); } catch { continue; }
      if (!matches) continue;

      for (const prop of Object.keys(inlineProps)) {
        const sheetValue = declarations.getPropertyValue(prop);
        if (!sheetValue || sheetValue === inlineProps[prop]) continue;

        const tag = el.tagName.toLowerCase();
        const id = el.id ? '#' + el.id : '';
        const cls = el.className && typeof el.className === 'string'
          ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.')
          : '';
        const isReactEl = Object.keys(el).some(k =>
          k.startsWith('__reactFiber') || k.startsWith('__reactProps')
        );

        report.inlineStyleConflicts.push({
          element: tag + id + cls,
          property: prop,
          inlineValue: inlineProps[prop],
          stylesheetValue: sheetValue,
          stylesheetSource: source.split('/').pop(),
          selector,
          isReactComponent: isReactEl,
          description: \`React inline style overrides stylesheet on <\${tag + id + cls}>: "\${prop}: \${inlineProps[prop]}" (inline) wins over "\${prop}: \${sheetValue}" from \${source.split('/').pop()}\`,
        });
        report.summary.inlineConflicts++;
      }
    }
  }

  return JSON.stringify(report);
}
`;

/**
 * Parse the raw JSON string result from CSS_ANALYSIS_SCRIPT into bug entries.
 *
 * @param {string} rawResult - JSON string returned by evaluate_script
 * @param {string} url - URL that was analyzed
 * @returns {object[]} Array of bug-report-compatible error objects
 */
export function parseCssAnalysisResult(rawResult, url) {
  let data;
  try {
    const str = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult);
    data = JSON.parse(str);
  } catch {
    return [{
      type: 'css_analysis_error',
      message: 'CSS analysis script failed to return valid JSON',
      severity: 'info',
      url,
    }];
  }

  const bugs = [];

  // ── Overridden properties ──────────────────────────────────────────────────
  for (const override of (data.overriddenProperties ?? [])) {
    // Only report if there are many overrides or !important is involved
    if (override.overrideCount < 2) continue;

    const severity = override.hasImportant ? 'warning' : 'info';
    const sources = [...new Set(override.declarations.map(d => d.source.split('/').pop()))].join(', ');
    bugs.push({
      type: 'css_override',
      element: override.element,
      property: override.property,
      overrideCount: override.overrideCount,
      hasImportant: override.hasImportant,
      message: `CSS override: "${override.property}" declared ${override.overrideCount}x on <${override.element}>${override.hasImportant ? ' — includes !important' : ''} (sources: ${sources})`,
      declarations: override.declarations,
      severity,
      url,
    });
  }

  // ── Unused rules ──────────────────────────────────────────────────────────
  // Only report if there are a notable number — a few unused rules is normal
  const unusedCount = (data.unusedRules ?? []).length;
  if (unusedCount > 10) {
    bugs.push({
      type: 'css_unused_rules',
      count: unusedCount,
      message: `${unusedCount} CSS rules matched no elements on this page — possible dead styles or wrong component loaded`,
      examples: (data.unusedRules ?? []).slice(0, 5).map(r => r.selector),
      severity: unusedCount > 50 ? 'warning' : 'info',
      url,
    });
  }

  // ── Component leaks ───────────────────────────────────────────────────────
  for (const leak of (data.componentLeaks ?? [])) {
    bugs.push({
      type: 'css_component_leak',
      selector: leak.selector,
      componentHint: leak.componentHint,
      source: leak.foundInSource,
      message: leak.description,
      severity: 'warning',
      url,
    });
  }

  // ── React inline style conflicts ──────────────────────────────────────────
  for (const conflict of (data.inlineStyleConflicts ?? [])) {
    bugs.push({
      type: 'react_inline_style_conflict',
      element: conflict.element,
      property: conflict.property,
      inlineValue: conflict.inlineValue,
      stylesheetValue: conflict.stylesheetValue,
      source: conflict.stylesheetSource,
      isReactComponent: conflict.isReactComponent,
      message: conflict.description,
      severity: 'warning',
      url,
    });
  }

  // ── CSS Modules info ───────────────────────────────────────────────────────
  if (data.cssModulesDetected) {
    bugs.push({
      type: 'css_modules_detected',
      components: data.cssModulesComponents ?? [],
      message: `CSS Modules detected — ${(data.cssModulesComponents ?? []).length} scoped component(s): ${(data.cssModulesComponents ?? []).join(', ')}. BEM leak detection skipped for hashed selectors.`,
      severity: 'info',
      url,
    });
  }

  // ── Summary entry ─────────────────────────────────────────────────────────
  if (data.summary) {
    const parts = [
      `${data.summary.totalRules} total rules`,
      `${data.summary.appliedRules} applied`,
      `${data.summary.unusedRules} unused`,
      `${data.summary.overrides} cascade overrides`,
      `${data.summary.leaks} component leaks`,
      `${data.summary.inlineConflicts ?? 0} inline style conflicts`,
    ];
    bugs.push({
      type: 'css_summary',
      message: `CSS analysis (${data.cssModulesDetected ? 'CSS Modules + ' : ''}${data.scssSourceFiles?.length ? 'SCSS' : 'CSS'}): ${parts.join(', ')}`,
      severity: 'info',
      url,
      summary: data.summary,
      cssModulesDetected: data.cssModulesDetected,
      cssModulesComponents: data.cssModulesComponents,
      scssSourceFiles: data.scssSourceFiles,
      stylesheetSources: data.stylesheetSources,
    });
  }

  return bugs;
}
