import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ChromiumBaselineRenderer,
  HyperFramesAdapterSpike,
} from '../dist/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const minimalManifest = JSON.parse(
  readFileSync(resolve(__dirname, '../../../fixtures/manifest-minimal.json'), 'utf-8')
);

test('Adapter Contract: Lifecycle & Status Transitions', async (t) => {
  const adapters = [
    { name: 'ChromiumBaselineRenderer', adapter: new ChromiumBaselineRenderer() },
    { name: 'HyperFramesAdapterSpike', adapter: new HyperFramesAdapterSpike() },
  ];

  for (const { name, adapter } of adapters) {
    await t.test(`${name} implements full lifecycle on same manifest`, async () => {
      // 1. Prepare
      const session = await adapter.prepare(minimalManifest, { quality: 'preview' });
      assert.equal(session.getStatus(), 'prepared');
      assert.equal(session.manifest.composition_id, 'cmp_minimal');

      // 2. Seek valid frame
      const frame0 = await session.seek(0);
      assert.equal(frame0.frameIndex, 0);
      assert.equal(typeof frame0.checksumSha256, 'string');
      assert.equal(frame0.checksumSha256.length, 64);
      assert.equal(frame0.renderedWidth, 720);
      assert.equal(frame0.renderedHeight, 1280);

      // 3. Render range
      const frames = await session.renderRange(0, 5);
      assert.equal(frames.length, 5);
      assert.equal(session.getStatus(), 'prepared'); // Restores after rendering

      // 4. Dispose
      await session.dispose();
      assert.equal(session.getStatus(), 'disposed');

      // 5. Subsequent seek throws
      await assert.rejects(
        async () => session.seek(0),
        /Renderer session is disposed/
      );
    });
  }
});

test('Adapter Contract: Bounds & Error Validation', async (t) => {
  const renderer = new ChromiumBaselineRenderer();
  const session = await renderer.prepare(minimalManifest);

  // Negative frame index
  await assert.rejects(
    async () => session.seek(-1),
    RangeError
  );

  // Frame index out of upper bound
  await assert.rejects(
    async () => session.seek(minimalManifest.duration_frames),
    RangeError
  );

  // Invalid end frame in range
  await assert.rejects(
    async () => session.renderRange(10, 5),
    RangeError
  );

  await session.dispose();

  // Invalid manifest
  await assert.rejects(
    async () => renderer.prepare(null),
    /Cannot prepare renderer with invalid or empty manifest/
  );
  await assert.rejects(
    async () => renderer.prepare({ scenes: [] }),
    /Cannot prepare renderer with invalid or empty manifest/
  );
});
