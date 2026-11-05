import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  exportBrowserVideo,
  generateScopedAssetGrant,
  ScopedAssetLoader,
  MockServerJobDispatcher,
  verifyVideoContainer,
  DEFAULT_P8_01_GATE,
  BrowserExportGatePendingError,
} from '../dist/index.js';

describe('P8-02: End-to-End Browser Export Spike Integration Suite', () => {
  const pepper = 'integration_test_pepper_0123456789abcdef';
  const tenantId = 'tenant_merch_01';

  const logoBytes = Buffer.from('mock_logo_image_png_bytes');
  const logoSha256 = crypto.createHash('sha256').update(logoBytes).digest('hex');

  const approvedGateConfig = {
    gateId: 'EXT-P8-01',
    status: 'approved_by_reviewer',
    reviewer: 'Security Reviewer',
    notes: 'Approved for P8-02 browser export spike testing',
  };

  it('5.1 Gate Control: prevents execution when review gate is pending', async () => {
    const spec = {
      canvas: { width: 1280, height: 720 },
      fps: { num: 30, den: 1 },
      duration_frames: 30,
      scenes: [{ id: 's1', duration_frames: 30 }],
    };

    await assert.rejects(
      async () => {
        await exportBrowserVideo(spec, {
          gateConfig: DEFAULT_P8_01_GATE, // pending_external_review
        });
      },
      (err) => {
        assert.ok(err instanceof BrowserExportGatePendingError);
        assert.equal(err.code, 'SHIPPING_GATE_PENDING_REVIEW');
        return true;
      },
    );
  });

  it('5.2 End-to-End Export: successfully exports conforming promo scene subset locally', async () => {
    // Generate valid scoped grant for image asset
    const grant = generateScopedAssetGrant(
      {
        tenantId,
        assetId: 'ast_store_logo',
        filename: 'store_logo.png',
        mimeType: 'image/png',
        sha256: logoSha256,
        bytes: logoBytes.byteLength,
      },
      { pepper },
    );

    const assetLoader = new ScopedAssetLoader({
      pepper,
      expectedTenantId: tenantId,
      mockByteProvider: () => logoBytes,
    });

    const promoSpec = {
      canvas: { width: 1280, height: 720, background: '#0f172a' },
      fps: { num: 30, den: 1 },
      duration_frames: 60, // 2 seconds
      scenes: [
        {
          id: 'scene_promo_intro',
          duration_frames: 30,
          layers: [
            {
              id: 'layer_bg',
              type: 'shape',
              content: { shape: 'rect', fill: '#1e293b' },
            },
            {
              id: 'layer_logo',
              type: 'image',
              content: { grant_token: grant.token },
            },
            {
              id: 'layer_headline',
              type: 'text',
              content: { text: 'Siêu Sale Tháng 11', fontSize: 44, color: '#f8fafc' },
            },
          ],
        },
        {
          id: 'scene_promo_cta',
          duration_frames: 30,
          layers: [
            {
              id: 'layer_cta',
              type: 'text',
              content: { text: 'Nhận voucher 50% ngay', fontSize: 36, color: '#38bdf8' },
            },
          ],
        },
      ],
    };

    const recordedPhases = [];
    const result = await exportBrowserVideo(promoSpec, {
      platform: 'chrome-desktop',
      compositionId: 'cmp_promo_integration',
      revision: 1,
      tenantId,
      pepper,
      assetLoader,
      gateConfig: approvedGateConfig,
      onProgress: (p) => {
        recordedPhases.push(p.phase);
      },
    });

    assert.equal(result.action, 'export_locally');
    if (result.action === 'export_locally') {
      assert.equal(result.container, 'mp4');
      assert.equal(result.mimeType, 'video/mp4');
      assert.equal(result.width, 1280);
      assert.equal(result.height, 720);
      assert.equal(result.durationFrames, 60);
      assert.equal(result.durationMs, 2000);
      assert.ok(result.buffer.byteLength > 64);

      // Verify container headers
      const containerVerification = verifyVideoContainer(result.buffer);
      assert.equal(containerVerification.isValid, true);
      assert.equal(containerVerification.format, 'mp4');
      assert.equal(containerVerification.brand, 'isom');

      // Verify memory metrics
      assert.equal(result.memoryMetrics.activeFramesCount, 0); // No leaks
      assert.equal(result.memoryMetrics.budgetExceeded, false);
      assert.ok(result.memoryMetrics.peakFramesCount <= 4);

      // Verify progress phases occurred in correct order
      assert.ok(recordedPhases.includes('staging_assets'));
      assert.ok(recordedPhases.includes('rendering_frames'));
      assert.ok(recordedPhases.includes('muxing'));
      assert.ok(recordedPhases.includes('complete'));
    }
  });

  it('5.3 Fallback on Unsupported Feature: non-conforming composition triggers new server job', async () => {
    const unsupportedSpec = {
      canvas: { width: 1280, height: 720 },
      fps: { num: 30, den: 1 },
      duration_frames: 90,
      scenes: [
        {
          id: 'scene_custom_unsupported',
          engine: 'custom-html-v1', // Restricted to server microVM
          bundle: { bundle_id: 'bundle_99' },
          duration_frames: 90,
          layers: [],
        },
      ],
    };

    const dispatcher = new MockServerJobDispatcher();
    const result = await exportBrowserVideo(unsupportedSpec, {
      platform: 'chrome-desktop',
      compositionId: 'cmp_custom_code_fallback',
      revision: 2,
      serverDispatcher: dispatcher,
      gateConfig: approvedGateConfig,
    });

    assert.equal(result.action, 'fallback_to_server_job');
    if (result.action === 'fallback_to_server_job') {
      assert.equal(result.reasonCode, 'CUSTOM_CODE_ENGINE_UNSUPPORTED');
      assert.equal(result.admittedJob.state, 'queued');
      assert.equal(result.admittedJob.composition_id, 'cmp_custom_code_fallback');
      assert.equal(result.admittedJob.revision, 2);
      assert.equal(result.admittedJob.isReplayed, false);
      assert.ok(result.idempotencyKey.startsWith('idem_fb_cmp_custom_code_fallback_r2_'));

      // Verify dispatcher received payload
      assert.equal(dispatcher.dispatchedPayloads.length, 1);
      const recorded = dispatcher.dispatchedPayloads[0];
      assert.equal(recorded.payload.metadata?.['fallback_reason_code'], 'CUSTOM_CODE_ENGINE_UNSUPPORTED');
    }
  });

  it('5.4 Fallback on Platform Incompatibility: Firefox triggers server job due to missing encoder', async () => {
    const standardSpec = {
      canvas: { width: 1280, height: 720 },
      fps: { num: 30, den: 1 },
      duration_frames: 60,
      scenes: [{ id: 's1', duration_frames: 60 }],
    };

    const dispatcher = new MockServerJobDispatcher();
    const result = await exportBrowserVideo(standardSpec, {
      platform: 'firefox-desktop', // Missing VideoEncoder
      compositionId: 'cmp_firefox_fallback',
      revision: 1,
      serverDispatcher: dispatcher,
      gateConfig: approvedGateConfig,
    });

    assert.equal(result.action, 'fallback_to_server_job');
    if (result.action === 'fallback_to_server_job') {
      assert.equal(result.reasonCode, 'MISSING_VIDEO_ENCODER');
      assert.equal(result.admittedJob.state, 'queued');
      assert.equal(result.admittedJob.composition_id, 'cmp_firefox_fallback');
    }
  });
});
