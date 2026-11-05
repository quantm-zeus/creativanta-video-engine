/**
 * Test Suite: Exact Staging Smoke Test Suite
 *
 * Canonical specifications:
 *   - docs/IMPLEMENTATION_PLAN.md (Task P6-05: "exact staging smoke")
 *   - docs/DEPLOYMENT.md ("Môi trường và topology" & "Startup contract khi code tồn tại", lines 52-57)
 *   - docs/TESTING.md ("G4 private beta", line 13 & "Smoke fixture", line 55)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StagingSmokeRunner, STAGING_ENVIRONMENT_CONFIG } from '../release/staging-smoke-runner.mjs';

describe('Exact Staging Smoke Test Suite', () => {
  it('executes full 10-stage staging smoke suite and achieves 100% pass', async () => {
    const runner = new StagingSmokeRunner();
    const result = await runner.runSmoke();

    assert.strictEqual(result.status, 'PASS');
    assert.strictEqual(result.totalStages, 10);
    assert.strictEqual(result.passedStages, 10);
    assert.strictEqual(result.failedStages, 0);

    for (const stage of result.stages) {
      assert.strictEqual(
        stage.passed,
        true,
        `Staging smoke stage ${stage.id} (${stage.title}) failed: ${stage.details}`
      );
      assert.ok(stage.durationMs >= 0);
    }
  });

  it('validates staging configuration preflight constraints', () => {
    const cfg = STAGING_ENVIRONMENT_CONFIG;

    assert.strictEqual(cfg.CVE_ENV, 'staging');
    assert.strictEqual(cfg.CVE_CUSTOM_CODE_ENABLED, false);
    assert.strictEqual(cfg.CVE_CUSTOM_RUNTIME, 'disabled');
    assert.strictEqual(cfg.CVE_REMOTE_IMPORT_ENABLED, false);
    assert.strictEqual(cfg.CVE_TTS_PROVIDER, 'disabled');
    assert.strictEqual(cfg.CVE_AUTHORING_PROVIDER, 'disabled');
    assert.ok(cfg.CVE_SIGNED_DOWNLOAD_TTL_SECONDS <= 300);
    assert.strictEqual(cfg.CVE_RENDER_SLOTS, 2);
    assert.strictEqual(cfg.CVE_LEASE_SECONDS, 60);
    assert.strictEqual(cfg.CVE_MAX_ATTEMPTS, 3);
  });

  it('confirms individual stage identifiers STG-01 through STG-10', async () => {
    const runner = new StagingSmokeRunner();
    const result = await runner.runSmoke();

    const expectedStageIds = [
      'STG-01',
      'STG-02',
      'STG-03',
      'STG-04',
      'STG-05',
      'STG-06',
      'STG-07',
      'STG-08',
      'STG-09',
      'STG-10',
    ];

    const actualStageIds = result.stages.map((s) => s.id);
    assert.deepStrictEqual(actualStageIds, expectedStageIds);
  });
});
