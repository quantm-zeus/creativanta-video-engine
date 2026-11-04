/**
 * Test Suite: 24h Soak Beta Invariants & Fault Injection
 *
 * Canonical specifications:
 *   - docs/TESTING.md ("Reliability/load và CI", line 72)
 *   - docs/OPERATIONS.md ("SLO mục tiêu và ownership", lines 11-15)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runSoakTest } from '../load/soak-runner.mjs';

describe('24h Soak Beta Invariants Suite', () => {
  it('executes 1000 valid jobs soak simulation and verifies all core invariants', async () => {
    const result = await runSoakTest({
      totalJobCount: 1000,
      faultInjectionRate: 0.05,
    });

    assert.strictEqual(result.verdict, 'PASS');
    assert.strictEqual(result.totalJobs, 1000);
    assert.strictEqual(result.validJobCount, 980);
    assert.strictEqual(result.succeededJobsCount, 980);
    assert.strictEqual(result.failedJobsCount, 10); // invalid inputs
    assert.strictEqual(result.canceledJobsCount, 10); // customer cancels

    // INVARIANT 1: Zero Lost Accepted Jobs
    assert.strictEqual(result.invariants.zeroLostAcceptedJobs, true);

    // INVARIANT 2: Zero Duplicate Published Artifacts
    assert.strictEqual(result.invariants.zeroDuplicatePublishedArtifacts, true);

    // INVARIANT 3: Zero Duplicate Billed Units
    assert.strictEqual(result.invariants.zeroDuplicateBilledEntries, true);

    // INVARIANT 4: Stale Worker Fencing Enforced
    assert.strictEqual(result.invariants.staleWorkerFencingEnforced, true);
    assert.ok(result.stalePublishAttemptsBlockedCount > 0);

    // INVARIANT 5: Success rate >= 99% for valid eligible jobs
    assert.strictEqual(result.invariants.meetsSuccessRateSlo, true);
    assert.ok(result.validSuccessRatePercent >= 99.0);

    // INVARIANT 6: Bounded Memory & Cleaned Temp Storage
    assert.strictEqual(result.invariants.memoryBounded, true);
    assert.strictEqual(result.invariants.tempStorageCleaned, true);
    assert.ok(result.memoryProfile.memoryGrowthFactor < 3.0);

    // INVARIANT 7: Webhook Outbox Consistency
    assert.strictEqual(result.invariants.webhookOutboxConsistent, true);
  });

  it('verifies that every fault boundary is exercised during soak test', async () => {
    const result = await runSoakTest({
      totalJobCount: 200,
      faultInjectionRate: 0.20,
    });

    const stats = result.faultInjectionStats;
    assert.ok(stats.prepare_kill > 0, 'prepare_kill should be tested');
    assert.ok(stats.render_kill > 0, 'render_kill should be tested');
    assert.ok(stats.encode_kill > 0, 'encode_kill should be tested');
    assert.ok(stats.verify_kill > 0, 'verify_kill should be tested');
    assert.ok(stats.publish_stale_fencing > 0, 'publish_stale_fencing should be tested');
    assert.ok(stats.storage_transient_error > 0, 'storage_transient_error should be tested');
    assert.ok(stats.webhook_outage > 0, 'webhook_outage should be tested');
    assert.ok(stats.db_reconnect > 0, 'db_reconnect should be tested');
  });
});
