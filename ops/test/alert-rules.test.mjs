/**
 * Test Suite: Prometheus Alerting Rules & Firing Logic
 * Canonical specification: docs/OPERATIONS.md (lines 39-40)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { AlertEvaluator } from '../alerts/alert-evaluator.mjs';

describe('Prometheus Alerting Rules Suite', () => {
  const rulesPath = path.resolve('ops/alerts/cve-alerts.rules.yml');
  const evaluator = new AlertEvaluator(rulesPath);

  it('loads all 11 required alerting rules from cve-alerts.rules.yml', () => {
    assert.ok(evaluator.rules.length >= 11, `Expected at least 11 rules, found ${evaluator.rules.length}`);

    const expectedAlerts = [
      'CveOldestQueueStalled',
      'CveWorkerHeartbeatMissing',
      'CveDiskFreeWarning',
      'CveDiskFreeCritical',
      'CveHighMemoryUsage',
      'CveTerminalFailureRateHigh',
      'CveWebhookDeliveryBacklog',
      'CveDbBackupLag',
      'CveUsageReconciliationAnomaly',
      'CveSandboxDenialsAnomaly',
      'CveAssetRejectionsAnomaly',
      'CveStalePublishRejected',
    ];

    const parsedAlertNames = new Set(evaluator.rules.map((r) => r.alert));
    for (const expected of expectedAlerts) {
      assert.ok(parsedAlertNames.has(expected), `Rule '${expected}' must be defined in rules YAML`);
    }
  });

  it('fires CveOldestQueueStalled when queue age exceeds 120s', () => {
    const alertsNormal = evaluator.evaluate({ cve_queue_oldest_seconds: 45 });
    assert.strictEqual(alertsNormal.filter((a) => a.alert === 'CveOldestQueueStalled').length, 0);

    const alertsFiring = evaluator.evaluate({ cve_queue_oldest_seconds: 130 });
    const match = alertsFiring.find((a) => a.alert === 'CveOldestQueueStalled');
    assert.ok(match);
    assert.strictEqual(match.severity, 'critical');
    assert.strictEqual(match.value, 130);
  });

  it('fires CveDiskFreeWarning and CveDiskFreeCritical at appropriate thresholds', () => {
    // Normal: 30% free
    let alerts = evaluator.evaluate({ cve_disk_free_ratio: 0.30 });
    assert.strictEqual(alerts.filter((a) => a.alert.startsWith('CveDiskFree')).length, 0);

    // Warning: 15% free (<20% and >=10%)
    alerts = evaluator.evaluate({ cve_disk_free_ratio: 0.15 });
    let warnMatch = alerts.find((a) => a.alert === 'CveDiskFreeWarning');
    assert.ok(warnMatch);
    assert.strictEqual(warnMatch.severity, 'warning');

    // Critical: 8% free (<10%)
    alerts = evaluator.evaluate({ cve_disk_free_ratio: 0.08 });
    let critMatch = alerts.find((a) => a.alert === 'CveDiskFreeCritical');
    assert.ok(critMatch);
    assert.strictEqual(critMatch.severity, 'critical');
  });

  it('fires CveTerminalFailureRateHigh when failure rate exceeds 5% with sample >= 20', () => {
    // 1 failure out of 5 jobs = 20%, but sample < 20 -> should NOT fire
    let alerts = evaluator.evaluate({
      cve_jobs_terminal_failed: 1,
      cve_jobs_terminal_total: 5,
    });
    assert.strictEqual(alerts.filter((a) => a.alert === 'CveTerminalFailureRateHigh').length, 0);

    // 2 failures out of 25 jobs = 8%, sample >= 20 -> should FIRE
    alerts = evaluator.evaluate({
      cve_jobs_terminal_failed: 2,
      cve_jobs_terminal_total: 25,
    });
    const match = alerts.find((a) => a.alert === 'CveTerminalFailureRateHigh');
    assert.ok(match);
    assert.strictEqual(match.severity, 'critical');
    assert.strictEqual(match.value, 8);
  });

  it('fires CveUsageReconciliationAnomaly immediately when reconciliation error count > 0', () => {
    let alerts = evaluator.evaluate({ cve_usage_reconcile_errors_total: 0 });
    assert.strictEqual(alerts.filter((a) => a.alert === 'CveUsageReconciliationAnomaly').length, 0);

    alerts = evaluator.evaluate({ cve_usage_reconcile_errors_total: 1 });
    const match = alerts.find((a) => a.alert === 'CveUsageReconciliationAnomaly');
    assert.ok(match);
    assert.strictEqual(match.severity, 'critical');
  });

  it('fires CveStalePublishRejected when zombie worker attempts to publish', () => {
    let alerts = evaluator.evaluate({ cve_stale_publish_rejected_total: 1 });
    const match = alerts.find((a) => a.alert === 'CveStalePublishRejected');
    assert.ok(match);
    assert.strictEqual(match.severity, 'critical');
  });
});
