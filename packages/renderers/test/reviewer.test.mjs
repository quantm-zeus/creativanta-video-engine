import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

import { executeComprehensiveReview } from '../dist/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');

test('P2-05 Reviewer: Comprehensive Quality Audit & Gate G2 Sign-Off', async () => {
  const report = await executeComprehensiveReview({
    repoRoot,
    gitCommit: 'de0bfb0',
    forceRerenderPoc03: false,
  });

  // 1. Overall status & schema
  assert.equal(report.schemaVersion, '1.0.0');
  assert.equal(report.overallStatus, 'PASS');
  assert.ok(report.timestamp);

  // 2. Fixture POC-01 (Promo 15s)
  const poc01 = report.fixtures['POC-01'];
  assert.ok(poc01);
  assert.equal(poc01.fixtureId, 'POC-01');
  assert.equal(poc01.spec.durationFrames, 450);
  assert.equal(poc01.spec.durationSeconds, 15);
  assert.equal(poc01.spec.width, 720);
  assert.equal(poc01.spec.height, 1280);
  assert.equal(poc01.revision1.decodeReport.valid, true);
  assert.equal(poc01.revision1.decodeReport.videoFrameCount, 450);
  assert.equal(poc01.revision1.decodeReport.faststartMoovBeforeMdat, true);
  assert.equal(poc01.revision2.decodeReport.valid, true);
  assert.equal(poc01.revision2.decodeReport.videoFrameCount, 450);
  assert.equal(poc01.typography.valid, true);
  assert.equal(poc01.typography.currencySymbolFound, true);
  assert.ok(poc01.visualGoldens.count >= 20);
  assert.equal(poc01.humanReview.verdict, 'PASS');
  assert.equal(poc01.status, 'PASS');

  // 3. Fixture POC-02 (Explainer 30s)
  const poc02 = report.fixtures['POC-02'];
  assert.ok(poc02);
  assert.equal(poc02.fixtureId, 'POC-02');
  assert.equal(poc02.spec.durationFrames, 900);
  assert.equal(poc02.spec.durationSeconds, 30);
  assert.equal(poc02.spec.width, 1280);
  assert.equal(poc02.spec.height, 720);
  assert.equal(poc02.revision1.decodeReport.valid, true);
  assert.equal(poc02.revision1.decodeReport.videoFrameCount, 900);
  assert.equal(poc02.revision1.decodeReport.tracks.length, 2); // video + audio
  assert.equal(poc02.revision1.decodeReport.faststartMoovBeforeMdat, true);
  assert.equal(poc02.revision2.decodeReport.valid, true);
  assert.equal(poc02.revision2.decodeReport.videoFrameCount, 900);
  assert.equal(poc02.typography.valid, true);
  assert.ok(poc02.visualGoldens.count >= 20);
  assert.equal(poc02.humanReview.verdict, 'PASS');
  assert.equal(poc02.status, 'PASS');

  // 4. Fixture POC-03 (Footage 45s)
  const poc03 = report.fixtures['POC-03'];
  assert.ok(poc03);
  assert.equal(poc03.fixtureId, 'POC-03');
  assert.equal(poc03.spec.durationFrames, 1350);
  assert.equal(poc03.spec.durationSeconds, 45);
  assert.equal(poc03.spec.width, 720);
  assert.equal(poc03.spec.height, 1280);
  assert.equal(poc03.revision1.decodeReport.valid, true);
  assert.equal(poc03.revision1.decodeReport.videoFrameCount, 1350);
  assert.equal(poc03.revision1.decodeReport.tracks.length, 2); // video + audio
  assert.equal(poc03.revision1.decodeReport.faststartMoovBeforeMdat, true);
  assert.equal(poc03.revision2.decodeReport.valid, true);
  assert.equal(poc03.revision2.decodeReport.videoFrameCount, 1350);
  assert.equal(poc03.typography.valid, true);
  assert.ok(poc03.visualGoldens.count >= 20);
  assert.equal(poc03.audioMetrics?.zeroClipping, true);
  assert.ok(poc03.audioMetrics?.truePeakDbtp <= -1.0);
  assert.ok(poc03.audioMetrics?.syncAnchorDiscrepancyMs <= 33.34);
  assert.equal(poc03.humanReview.verdict, 'PASS');
  assert.equal(poc03.status, 'PASS');

  // 5. Gate G2 Sign-Off Decision
  const g2 = report.g2SignOff;
  assert.equal(g2.gate, 'G2');
  assert.equal(g2.status, 'PASS');
  assert.equal(g2.decision, 'APPROVED_FOR_STAGING');
  assert.equal(g2.adrAmendmentRequired, false);
  assert.equal(g2.adrAmendmentReason, null);
  assert.equal(g2.engineSelection.primary, 'chromium-frame-v1');
  assert.equal(g2.engineSelection.fallback, 'none');

  // Verify all criteria checklist items are true
  for (const [criterion, passed] of Object.entries(g2.criteriaChecklist)) {
    assert.equal(passed, true, `Gate G2 checklist item "${criterion}" must pass`);
  }

  // 6. Verify Files on Disk
  assert.ok(existsSync(resolve(repoRoot, 'evidence/P2-05/poc03.mp4')));
  assert.ok(existsSync(resolve(repoRoot, 'evidence/P2-05/poc03-v2.mp4')));
});
