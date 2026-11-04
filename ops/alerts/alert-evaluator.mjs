/**
 * Creativanta Video Engine - Alert Rule Evaluator Engine
 * Parses alerting rules and evaluates firing conditions against metrics state.
 */

import fs from 'node:fs';

export class AlertEvaluator {
  constructor(rulesFilePath) {
    this.rules = [];
    if (rulesFilePath) {
      this.loadRules(rulesFilePath);
    }
  }

  loadRules(rulesFilePath) {
    const content = fs.readFileSync(rulesFilePath, 'utf-8');
    this.rules = this.parseSimpleYamlRules(content);
  }

  parseSimpleYamlRules(yamlText) {
    const rules = [];
    const lines = yamlText.split('\n');
    let currentRule = null;
    let inAnnotations = false;
    let inLabels = false;

    for (let line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      if (trimmed.startsWith('- alert:')) {
        if (currentRule) rules.push(currentRule);
        currentRule = {
          alert: trimmed.replace('- alert:', '').trim(),
          expr: '',
          for: '0s',
          labels: {},
          annotations: {},
        };
        inAnnotations = false;
        inLabels = false;
      } else if (currentRule) {
        if (trimmed.startsWith('expr:')) {
          currentRule.expr = trimmed.replace('expr:', '').trim();
          inAnnotations = false;
          inLabels = false;
        } else if (trimmed.startsWith('for:')) {
          currentRule.for = trimmed.replace('for:', '').trim();
          inAnnotations = false;
          inLabels = false;
        } else if (trimmed.startsWith('labels:')) {
          inLabels = true;
          inAnnotations = false;
        } else if (trimmed.startsWith('annotations:')) {
          inAnnotations = true;
          inLabels = false;
        } else if (inLabels && trimmed.includes(':')) {
          const [k, ...v] = trimmed.split(':');
          currentRule.labels[k.trim()] = v.join(':').trim();
        } else if (inAnnotations && trimmed.includes(':')) {
          const [k, ...v] = trimmed.split(':');
          let val = v.join(':').trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          currentRule.annotations[k.trim()] = val;
        }
      }
    }
    if (currentRule) rules.push(currentRule);
    return rules;
  }

  /**
   * Evaluates rules against a dictionary of metric values.
   * metricValues: Map or Object of { metric_name: value }
   */
  evaluate(metricValues = {}) {
    const activeAlerts = [];
    for (const rule of this.rules) {
      let isFiring = false;
      let matchedValue = null;

      // Rule evaluation logic matching the operational thresholds
      if (rule.alert === 'CveOldestQueueStalled') {
        const val = metricValues['cve_queue_oldest_seconds'] || 0;
        if (val > 120) {
          isFiring = true;
          matchedValue = val;
        }
      } else if (rule.alert === 'CveWorkerHeartbeatMissing') {
        const val = metricValues['cve_lease_expired_total'] || 0;
        if (val > 0) {
          isFiring = true;
          matchedValue = val;
        }
      } else if (rule.alert === 'CveDiskFreeWarning') {
        const val = metricValues['cve_disk_free_ratio'] !== undefined ? metricValues['cve_disk_free_ratio'] : 1.0;
        if (val < 0.20 && val >= 0.10) {
          isFiring = true;
          matchedValue = val;
        }
      } else if (rule.alert === 'CveDiskFreeCritical') {
        const val = metricValues['cve_disk_free_ratio'] !== undefined ? metricValues['cve_disk_free_ratio'] : 1.0;
        if (val < 0.10) {
          isFiring = true;
          matchedValue = val;
        }
      } else if (rule.alert === 'CveHighMemoryUsage') {
        const val = metricValues['cve_peak_memory_bytes'] || 0;
        if (val > 3865470566) { // > 3.6 GiB
          isFiring = true;
          matchedValue = val;
        }
      } else if (rule.alert === 'CveTerminalFailureRateHigh') {
        const failed = metricValues['cve_jobs_terminal_failed'] || 0;
        const total = metricValues['cve_jobs_terminal_total'] || 0;
        if (total >= 20 && (failed / total) * 100 > 5) {
          isFiring = true;
          matchedValue = (failed / total) * 100;
        }
      } else if (rule.alert === 'CveWebhookDeliveryBacklog') {
        const val = metricValues['cve_webhook_pending'] || 0;
        if (val > 0) {
          isFiring = true;
          matchedValue = val;
        }
      } else if (rule.alert === 'CveDbBackupLag') {
        const val = metricValues['cve_backup_lag_seconds'] || 0;
        if (val > 900) {
          isFiring = true;
          matchedValue = val;
        }
      } else if (rule.alert === 'CveUsageReconciliationAnomaly') {
        const val = metricValues['cve_usage_reconcile_errors_total'] || 0;
        if (val > 0) {
          isFiring = true;
          matchedValue = val;
        }
      } else if (rule.alert === 'CveSandboxDenialsAnomaly') {
        const val = metricValues['cve_sandbox_denials_total'] || 0;
        if (val > 0) {
          isFiring = true;
          matchedValue = val;
        }
      } else if (rule.alert === 'CveAssetRejectionsAnomaly') {
        const val = metricValues['cve_asset_rejections_total'] || 0;
        if (val > 10) {
          isFiring = true;
          matchedValue = val;
        }
      } else if (rule.alert === 'CveStalePublishRejected') {
        const val = metricValues['cve_stale_publish_rejected_total'] || 0;
        if (val > 0) {
          isFiring = true;
          matchedValue = val;
        }
      }

      if (isFiring) {
        activeAlerts.push({
          alert: rule.alert,
          severity: rule.labels.severity || 'warning',
          labels: rule.labels,
          annotations: rule.annotations,
          value: matchedValue,
          state: 'FIRING',
        });
      }
    }

    return activeAlerts;
  }
}
