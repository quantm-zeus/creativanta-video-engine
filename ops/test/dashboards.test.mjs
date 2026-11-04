/**
 * Test Suite: Grafana Dashboards Schema & Query Validation
 * Canonical specification: docs/OPERATIONS.md
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('Grafana Dashboards Suite', () => {
  const dashboards = [
    'cve-overview-slo.json',
    'cve-render-performance.json',
    'cve-tenant-security.json',
  ];

  for (const filename of dashboards) {
    it(`validates ${filename} JSON structure and panel queries`, () => {
      const filePath = path.resolve('ops/dashboards', filename);
      assert.ok(fs.existsSync(filePath), `Dashboard file ${filePath} must exist`);

      const content = fs.readFileSync(filePath, 'utf-8');
      const json = JSON.parse(content);

      assert.ok(json.title, 'Dashboard must have a title');
      assert.ok(json.uid, 'Dashboard must have a unique uid');
      assert.ok(Array.isArray(json.panels), 'Dashboard must have an array of panels');
      assert.ok(json.panels.length >= 4, 'Dashboard must have at least 4 panels');

      // Verify that every metric panel has valid query expressions
      for (const panel of json.panels) {
        if (panel.type === 'row') continue;
        assert.ok(panel.title, `Panel ID ${panel.id} must have a title`);
        assert.ok(Array.isArray(panel.targets), `Panel '${panel.title}' must have targets`);
        for (const target of panel.targets) {
          assert.ok(target.expr, `Panel '${panel.title}' target must have an expr PromQL string`);
          // Verify no tenant_id or job_id in PromQL expressions
          assert.ok(
            !target.expr.includes('tenant_id=') && !target.expr.includes('job_id='),
            `Panel '${panel.title}' target cannot use job_id or tenant_id labels`
          );
        }
      }
    });
  }

  it('validates SLO thresholds in cve-overview-slo.json', () => {
    const content = fs.readFileSync(path.resolve('ops/dashboards/cve-overview-slo.json'), 'utf-8');
    const json = JSON.parse(content);

    const availPanel = json.panels.find((p) => p.title.includes('API Availability'));
    assert.ok(availPanel);
    assert.strictEqual(availPanel.fieldConfig.defaults.thresholds.steps[2].value, 99.5);

    const successPanel = json.panels.find((p) => p.title.includes('Render Success'));
    assert.ok(successPanel);
    assert.strictEqual(successPanel.fieldConfig.defaults.thresholds.steps[2].value, 99.0);
  });
});
