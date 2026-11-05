import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MemoryGuard,
  MemoryBudgetExceededError,
  exportBrowserVideo,
  ExportCancelledError,
  MockServerJobDispatcher,
} from '../dist/index.js';

describe('P8-02: Memory Management & Cancellation Suite', () => {
  it('3.1 Memory Guard: calculates streaming vs unstreamed buffering footprints', () => {
    // 720p: 1280x720 @ 30fps, 1800 frames (60s)
    const guard720p = new MemoryGuard({
      width: 1280,
      height: 720,
      totalFrames: 1800,
      memoryBudgetMib: 1024, // iOS Safari limit
      maxInFlightFrames: 4,
    });

    assert.equal(guard720p.bytesPerFrame, 1280 * 720 * 4); // 3,686,400 bytes (~3.51 MiB)
    assert.equal(guard720p.estimatedRawTotalBytes, 3686400 * 1800); // ~6.17 GiB

    const eval720p = guard720p.evaluateInitialFeasibility();
    assert.equal(eval720p.fullBufferingWouldExceedBudget, true); // 6.17 GiB > 1 GiB
    assert.equal(eval720p.isSafeToStream, true); // 4 * 3.51 MiB = 14 MiB << 1 GiB
    assert.ok(eval720p.streamingBufferMib <= 15);
  });

  it('3.2 Memory Guard: maintains strictly bounded active frame memory during sequential rendering', () => {
    const guard = new MemoryGuard({
      width: 1280,
      height: 720,
      totalFrames: 300,
      memoryBudgetMib: 512,
      maxInFlightFrames: 2,
    });

    for (let i = 0; i < 300; i++) {
      guard.allocateFrame(i);
      const metrics = guard.getMetrics();
      // Active frame count is bounded
      assert.ok(metrics.activeFramesCount <= 2);
      assert.ok(metrics.activeBufferBytes <= 3686400 * 2);

      // Simulates immediate VideoFrame.close() disposal
      guard.releaseFrame();
      assert.equal(guard.getMetrics().activeFramesCount, 0);
    }

    const finalMetrics = guard.getMetrics();
    assert.equal(finalMetrics.activeFramesCount, 0);
    assert.equal(finalMetrics.activeBufferBytes, 0);
    assert.equal(finalMetrics.peakFramesCount, 1);
    assert.equal(finalMetrics.budgetExceeded, false);

    assert.doesNotThrow(() => {
      guard.assertNoLeaks();
    });
  });

  it('3.3 Memory Guard: raises MemoryBudgetExceededError when heap limit breached', () => {
    const tinyGuard = new MemoryGuard({
      width: 1920,
      height: 1080,
      totalFrames: 10,
      memoryBudgetMib: 5, // 5 MiB budget (smaller than one 1080p frame: 7.91 MiB)
      maxInFlightFrames: 4,
    });

    assert.throws(
      () => {
        tinyGuard.allocateFrame(0);
      },
      (err) => {
        assert.ok(err instanceof MemoryBudgetExceededError);
        assert.equal(err.code, 'EXCEEDS_MEMORY_BUDGET');
        return true;
      },
    );
  });

  it('3.4 Cancellation: aborts pipeline prior to start when AbortSignal already triggered', async () => {
    const controller = new AbortController();
    controller.abort(); // Pre-aborted

    const spec = {
      canvas: { width: 1280, height: 720 },
      fps: { num: 30, den: 1 },
      duration_frames: 100,
      scenes: [
        {
          id: 'scene_1',
          duration_frames: 100,
          layers: [{ id: 'txt', type: 'text', content: { text: 'Hello' } }],
        },
      ],
    };

    await assert.rejects(
      async () => {
        await exportBrowserVideo(spec, {
          signal: controller.signal,
          platform: 'chrome-desktop',
        });
      },
      (err) => {
        assert.ok(err instanceof ExportCancelledError);
        assert.equal(err.code, 'EXPORT_CANCELLED');
        return true;
      },
    );
  });

  it('3.5 Cancellation: aborts during frame render loop and cleans up active resources', async () => {
    const controller = new AbortController();
    let frameRenderCount = 0;

    const spec = {
      canvas: { width: 1280, height: 720 },
      fps: { num: 30, den: 1 },
      duration_frames: 100,
      scenes: [
        {
          id: 'scene_1',
          duration_frames: 100,
          layers: [{ id: 'txt', type: 'text', content: { text: 'Cancel test' } }],
        },
      ],
    };

    await assert.rejects(
      async () => {
        await exportBrowserVideo(spec, {
          signal: controller.signal,
          platform: 'chrome-desktop',
          onProgress: (prog) => {
            if (prog.phase === 'rendering_frames') {
              frameRenderCount += 1;
              if (prog.currentFrame >= 20) {
                // Abort during frame 20
                controller.abort();
              }
            }
          },
        });
      },
      (err) => {
        assert.ok(err instanceof ExportCancelledError);
        assert.equal(err.code, 'EXPORT_CANCELLED');
        assert.ok(err.message.includes('Export cancelled at frame'));
        return true;
      },
    );

    assert.ok(frameRenderCount >= 1);
  });

  it('3.6 Re-run capability: export pipeline runs cleanly to completion after a previous abort', async () => {
    const spec = {
      canvas: { width: 1280, height: 720 },
      fps: { num: 30, den: 1 },
      duration_frames: 30,
      scenes: [
        {
          id: 'scene_1',
          duration_frames: 30,
          layers: [{ id: 'txt', type: 'text', content: { text: 'Subsequent run' } }],
        },
      ],
    };

    // Run without abort signal
    const result = await exportBrowserVideo(spec, {
      platform: 'chrome-desktop',
      serverDispatcher: new MockServerJobDispatcher(),
    });

    assert.equal(result.action, 'export_locally');
    if (result.action === 'export_locally') {
      assert.equal(result.durationFrames, 30);
      assert.equal(result.memoryMetrics.activeFramesCount, 0);
      assert.equal(result.memoryMetrics.budgetExceeded, false);
      assert.ok(result.buffer.byteLength > 0);
    }
  });
});
