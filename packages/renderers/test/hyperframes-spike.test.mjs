import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HyperFramesAdapterSpike } from '../dist/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const minimalManifest = JSON.parse(
  readFileSync(resolve(__dirname, '../../../fixtures/manifest-minimal.json'), 'utf-8')
);
const poc01Manifest = JSON.parse(
  readFileSync(resolve(__dirname, '../../../fixtures/manifest-poc01.json'), 'utf-8')
);

test('HyperFrames Spike: Declarative Template & Data-Attributes Translation', async () => {
  const adapter = new HyperFramesAdapterSpike();
  const session = await adapter.prepare(minimalManifest);

  const template = session.getHyperFramesTemplate();
  assert.ok(template.includes('data-schema="1.0"'));
  assert.ok(template.includes('data-width="720"'));
  assert.ok(template.includes('data-height="1280"'));
  assert.ok(template.includes('data-duration-frames="150"'));
  assert.ok(template.includes('class="hf-scene"'));
  assert.ok(template.includes('data-id="intro"'));
  assert.ok(template.includes('data-in="0"'));
  assert.ok(template.includes('data-duration="150"'));
  assert.ok(template.includes('class="hf-layer"'));
  assert.ok(template.includes('data-id="headline"'));

  await session.dispose();
});

test('HyperFrames Spike: Frame Seek & DOM Snapshot with Time Attributes', async () => {
  const adapter = new HyperFramesAdapterSpike();
  const session = await adapter.prepare(poc01Manifest);

  const frame30 = await session.seek(30);
  assert.equal(frame30.frameIndex, 30);
  assert.equal(frame30.sceneId, 'scene_intro');
  assert.ok(frame30.domSnapshot);
  assert.ok(frame30.domSnapshot.includes('data-scene-id="scene_intro"'));
  assert.ok(frame30.domSnapshot.includes('data-local-frame="30"'));
  assert.ok(frame30.domSnapshot.includes('data-layer-id='));
  assert.ok(frame30.domSnapshot.includes('data-layer-type='));

  await session.dispose();
});

test('HyperFrames Spike: Random Seek Invariance Verification', async () => {
  const adapter = new HyperFramesAdapterSpike();
  const session = await adapter.prepare(minimalManifest);

  const seekTest = await session.verifyRandomSeek([0, 25, 75, 120, 149]);
  assert.equal(seekTest.passed, true);
  assert.equal(seekTest.reproducible, true);
  assert.equal(seekTest.checksumMatches, true);
  assert.equal(seekTest.mismatches.length, 0);

  await session.dispose();
});

test('HyperFrames Spike: Formal 2-Day Blocker Review & Diagnostic Audit', () => {
  const report = HyperFramesAdapterSpike.auditBlockers();

  assert.equal(report.status, 'BLOCKED');
  assert.equal(report.candidate, 'hyperframes-v1');
  assert.ok(report.blockers.length >= 4);

  // Blocker 1: GSAP Commercial License
  const b1 = report.blockers.find((b) => b.id === 'BLOCKER-HF-01');
  assert.ok(b1, 'Must report BLOCKER-HF-01');
  assert.equal(b1.severity, 'LEGAL_BLOCKER');
  assert.ok(b1.description.includes('GreenSock'));
  assert.ok(b1.description.includes('Club GreenSock'));

  // Blocker 2: HeyGen Cloud Coupling & Zero Egress
  const b2 = report.blockers.find((b) => b.id === 'BLOCKER-HF-02');
  assert.ok(b2, 'Must report BLOCKER-HF-02');
  assert.equal(b2.severity, 'CRITICAL_BLOCKER');
  assert.ok(b2.description.includes('billing'));
  assert.ok(b2.description.includes('--network none'));

  // Blocker 3: Puppeteer Dynamic Install Script
  const b3 = report.blockers.find((b) => b.id === 'BLOCKER-HF-03');
  assert.ok(b3, 'Must report BLOCKER-HF-03');
  assert.equal(b3.severity, 'HIGH_RISK');
  assert.ok(b3.description.includes('postinstall: node install.mjs'));

  // Blocker 4: Audio CFR Offline Stepping Drift
  const b4 = report.blockers.find((b) => b.id === 'BLOCKER-HF-04');
  assert.ok(b4, 'Must report BLOCKER-HF-04');
  assert.equal(b4.severity, 'HIGH_RISK');
  assert.ok(b4.title.includes('Audio CFR'));
  assert.ok(b4.description.includes('HyperFrames relies on browser-driven'));

  // Recommendation must transition to baseline
  assert.ok(
    report.transitionRecommendation.includes('chromium-frame-v1'),
    'Recommendation must designate chromium-frame-v1 as primary production engine'
  );
});
