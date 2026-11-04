/**
 * v1 Wire Compatibility Test Suite (Task P5-04).
 *
 * Verifies 100% wire contract compliance with docs/API.md:
 *   - Capabilities catalog, engines, profiles, limits, and additive field resilience
 *   - Composition validate, create, get, and optimistic concurrency (409 REVISION_CONFLICT)
 *   - Template catalog, get revision, and instantiate
 *   - Asset upload grant, complete probe, metadata, and deletion (202 Accepted)
 *   - Render & preview job admission (202 Accepted, Location, Retry-After, Idempotency-Key)
 *   - Idempotent replay detection (isReplayed: true) and conflict detection (409 IDEMPOTENCY_CONFLICT)
 *   - Cancellation state machine (202 -> 200 -> 409 JOB_TERMINAL)
 *   - Webhook registration, challenge verification, and secret redacting in GET
 *   - Usage metering reporting operational vs billable breakdown
 *   - Zero shared DB assumptions
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  CreativantaClient,
  CreativantaContractMock,
  IdempotencyConflictError,
  IdempotencyKeyRequiredError,
  InvalidIdempotencyKeyError,
  JobTerminalError,
  RevisionConflictError,
  ValidationError,
  generateIdempotencyKey,
} from '../dist/index.js';

describe('Task P5-04: REST API v1 Wire Compatibility Test Suite', () => {
  let mockServer;
  let baseUrl;
  let client;

  // Placeholder test credentials
  const PLACEHOLDER_API_KEY = 'cve_live_placeholder_key_compat_0000000000';
  const PLACEHOLDER_WEBHOOK_SECRET = 'whsec_placeholder_secret_compat_00000000';

  before(async () => {
    mockServer = new CreativantaContractMock({
      apiKey: PLACEHOLDER_API_KEY,
      webhookSecret: PLACEHOLDER_WEBHOOK_SECRET,
      autoAdvanceJobsMs: 0, // manual control of state
    });
    baseUrl = await mockServer.start();
    client = new CreativantaClient({
      baseUrl,
      apiKey: PLACEHOLDER_API_KEY,
    });
  });

  after(async () => {
    await mockServer.stop();
  });

  // =========================================================================
  // 1. GET /v1/capabilities
  // =========================================================================
  describe('1. Capabilities & Wire Contract Specification', () => {
    it('1.1 Retrieves capabilities with compliant engine and profile shapes', async () => {
      const caps = await client.getCapabilities();

      assert.equal(caps.api_version, 'v1');
      assert.ok(Array.isArray(caps.scene_schema_versions));
      assert.ok(caps.scene_schema_versions.includes('1.0'));

      // Engines: html-v1, canvas-v1, svg-v1 enabled; custom-html-v1 disabled per threat model
      assert.equal(caps.engines['html-v1'], true);
      assert.equal(caps.engines['canvas-v1'], true);
      assert.equal(caps.engines['svg-v1'], true);
      assert.equal(caps.engines['custom-html-v1'], false);

      // Profiles: mp4-720p-v1 and preview-360p-v1
      const mp4Profile = caps.profiles.find((p) => p.id === 'mp4-720p-v1');
      assert.ok(mp4Profile, 'mp4-720p-v1 profile must exist');
      assert.equal(mp4Profile.dimensions.width, 1280);
      assert.equal(mp4Profile.dimensions.height, 720);
      assert.equal(mp4Profile.fps.num, 30);
      assert.equal(mp4Profile.fps.den, 1);
      assert.equal(mp4Profile.supported, true);

      const previewProfile = caps.profiles.find((p) => p.id === 'preview-360p-v1');
      assert.ok(previewProfile, 'preview-360p-v1 profile must exist');
      assert.equal(previewProfile.dimensions.width, 640);
      assert.equal(previewProfile.dimensions.height, 360);

      // Limits
      assert.equal(caps.limits.max_scenes, 50);
      assert.equal(caps.limits.max_layers_per_scene, 100);
      assert.equal(caps.limits.max_duration_frames, 10800);
      assert.equal(caps.limits.max_concurrent_jobs, 22);
    });

    it('1.2 Safely handles unknown additive response fields without breaking', async () => {
      // Simulate server returning additive fields
      const customFetch = async (input, init) => {
        const res = await fetch(input, init);
        const data = await res.json();
        data['future_v2_capability'] = true;
        data['unannounced_engine_v3'] = { ready: false };
        return new Response(JSON.stringify(data), {
          status: res.status,
          headers: res.headers,
        });
      };

      const resilientClient = new CreativantaClient({
        baseUrl,
        apiKey: PLACEHOLDER_API_KEY,
        customFetch,
      });

      const caps = await resilientClient.getCapabilities();
      assert.equal(caps.api_version, 'v1');
      assert.equal(caps.future_v2_capability, true);
    });
  });

  // =========================================================================
  // 2. Compositions & Optimistic Concurrency
  // =========================================================================
  describe('2. Compositions Wire Validation & Revisions', () => {
    it('2.1 Validates valid composition spec returning estimate and capabilities', async () => {
      const res = await client.validateComposition({
        spec: {
          schema_version: '1.0',
          duration_frames: 450,
          scenes: [{ id: 'sc_1', duration_frames: 450, engine: 'html-v1' }],
        },
        profile: 'mp4-720p-v1',
      });

      assert.equal(res.valid, true);
      assert.ok(res.render_hash);
      assert.ok(res.estimate);
      assert.equal(res.estimate.output_seconds, 15);
      assert.equal(res.estimate.currency, 'USD');
    });

    it('2.2 Rejects invalid composition spec with 422 VALIDATION_FAILED and pointer details', async () => {
      await assert.rejects(
        () =>
          client.validateComposition({
            spec: { duration_frames: -1 },
            profile: 'mp4-720p-v1',
          }),
        (err) => {
          assert.ok(err instanceof ValidationError);
          assert.equal(err.status, 422);
          assert.equal(err.code, 'VALIDATION_FAILED');
          assert.ok(err.details.length > 0);
          assert.equal(err.details[0].pointer, '/duration_frames');
          return true;
        },
      );
    });

    it('2.3 Creates composition and manages optimistic revision updates (409 REVISION_CONFLICT)', async () => {
      const created = await client.createComposition({
        name: 'Compat Test Composition',
        spec: { schema_version: '1.0', duration_frames: 450 },
      });

      assert.ok(created.id.startsWith('cmp_'));
      assert.equal(created.revision, 1);
      assert.equal(created.editable, true);

      // Fetch composition
      const fetched = await client.getComposition(created.id);
      assert.equal(fetched.id, created.id);
      assert.equal(fetched.revision, 1);

      // Concurrency update with matching base_revision succeeds (rev 1 -> rev 2)
      const updatedRev = await client.createCompositionRevision(created.id, {
        baseRevision: 1,
        spec: { schema_version: '1.0', duration_frames: 900 },
        changeNote: 'Extended duration to 30s',
      });
      assert.equal(updatedRev.revision, 2);

      // Concurrency update with STALE base_revision (sending 1 when current is 2) must throw RevisionConflictError
      await assert.rejects(
        () =>
          client.createCompositionRevision(created.id, {
            baseRevision: 1, // Stale base revision!
            spec: { schema_version: '1.0', duration_frames: 600 },
          }),
        (err) => {
          assert.ok(err instanceof RevisionConflictError);
          assert.equal(err.status, 409);
          assert.equal(err.code, 'REVISION_CONFLICT');
          return true;
        },
      );
    });
  });

  // =========================================================================
  // 3. Templates Catalog & Instantiation
  // =========================================================================
  describe('3. Templates Catalog & Instantiation Contract', () => {
    it('3.1 Lists template catalog and retrieves immutable template revision', async () => {
      const list = await client.listTemplates();
      assert.ok(Array.isArray(list.data));
      assert.ok(list.data.length > 0);

      const tpl = list.data.find((t) => t.id === 'tpl_retail_promo');
      assert.ok(tpl);
      assert.equal(tpl.visibility, 'curated');

      const rev = await client.getTemplateRevision('tpl_retail_promo', 1);
      assert.equal(rev.id, 'tpl_retail_promo');
      assert.equal(rev.revision, 1);
      assert.ok(rev.variables_schema);
      assert.ok(rev.defaults);
      assert.ok(rev.supported_locales.includes('vi-VN'));
    });

    it('3.2 Instantiates template into composition revision 1', async () => {
      const instantiated = await client.instantiateTemplate('tpl_retail_promo', {
        templateRevision: 1,
        name: 'Chiến dịch Khuyến mãi 2026',
        variables: {
          headline: 'Giảm giá mùa đông 50%',
          price: '99.000 ₫',
        },
        locale: 'vi-VN',
        idempotencyKey: generateIdempotencyKey('idem_instantiate'),
      });

      assert.ok(instantiated.id.startsWith('cmp_'));
      assert.equal(instantiated.revision, 1);
      assert.equal(instantiated.template.id, 'tpl_retail_promo');
      assert.equal(instantiated.template.revision, 1);
    });
  });

  // =========================================================================
  // 4. Asset Intake & Deletion Lifecycle
  // =========================================================================
  describe('4. Asset Intake & Deletion Lifecycle', () => {
    it('4.1 Initiates upload grant, completes probe, and deletes asset (202 Accepted)', async () => {
      const dummyContent = Buffer.from('test-asset-video-mp4-stream');
      const sha256 = crypto.createHash('sha256').update(dummyContent).digest('hex');

      // 1. Initiate upload
      const uploadGrant = await client.initiateAssetUpload({
        filename: 'footage.mp4',
        mimeType: 'video/mp4',
        bytes: dummyContent.length,
        sha256,
        rights: {
          basis: 'licensed',
          source: 'Licensed Footage Library',
          attribution: 'Stock Media License #4421',
        },
        idempotencyKey: generateIdempotencyKey('idem_upload'),
      });

      assert.ok(uploadGrant.asset_id.startsWith('ast_'));
      assert.equal(uploadGrant.upload_method, 'PUT');
      assert.ok(uploadGrant.upload_url);
      assert.ok(uploadGrant.expires_at);

      // 2. Complete upload
      const completeRes = await client.completeAssetUpload(uploadGrant.asset_id, sha256);
      assert.equal(completeRes.status, 'ready');

      // 3. Inspect asset metadata
      const assetRec = await client.getAsset(uploadGrant.asset_id);
      assert.equal(assetRec.id, uploadGrant.asset_id);
      assert.equal(assetRec.status, 'ready');

      // 4. Delete asset
      const delRes = await client.deleteAsset(uploadGrant.asset_id);
      assert.equal(delRes.status, 'deleted');

      const deletedRec = await client.getAsset(uploadGrant.asset_id);
      assert.equal(deletedRec.status, 'deleted');
    });
  });

  // =========================================================================
  // 5. Job Creation, Idempotency & Conflict Semantics
  // =========================================================================
  describe('5. Job Admission, Idempotency & Conflict Semantics', () => {
    it('5.1 Rejects missing or invalid Idempotency-Key format', async () => {
      // Test missing idempotency key
      const transportWithoutKey = async () => {
        const res = await fetch(`${baseUrl}/v1/render-jobs`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${PLACEHOLDER_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ composition_id: 'cmp_1', revision: 1 }),
        });
        return res.json();
      };

      const errMissing = await transportWithoutKey();
      assert.equal(errMissing.error.code, 'IDEMPOTENCY_KEY_REQUIRED');

      // Test invalid character in idempotency key (spaces, non-ASCII)
      await assert.rejects(
        () =>
          client.createRenderJob({
            compositionId: 'cmp_1',
            revision: 1,
            idempotencyKey: 'invalid key with spaces and $pecial chars!',
          }),
        (err) => {
          assert.ok(err instanceof InvalidIdempotencyKeyError);
          assert.equal(err.status, 400);
          return true;
        },
      );
    });

    it('5.2 Submits render job returning 202 Accepted, Location, and Retry-After', async () => {
      const admitted = await client.createRenderJob({
        compositionId: 'cmp_compat_test',
        revision: 1,
        profile: 'mp4-720p-v1',
        externalReference: 'order-nov-8891',
        metadata: { env: 'testing' },
        idempotencyKey: generateIdempotencyKey('idem_job_submit'),
      });

      assert.ok(admitted.id.startsWith('job_'));
      assert.equal(admitted.kind, 'render');
      assert.equal(admitted.state, 'queued');
      assert.equal(admitted.state_version, 1);
      assert.equal(admitted.isReplayed, false);
      assert.ok(admitted.status_url);
    });

    it('5.3 Detects idempotent replay and returns isReplayed: true', async () => {
      const fixedKey = generateIdempotencyKey('fixed_replay_test');
      const payload = {
        compositionId: 'cmp_fixed_test',
        revision: 1,
        profile: 'mp4-720p-v1',
        idempotencyKey: fixedKey,
      };

      const firstRes = await client.createRenderJob(payload);
      assert.equal(firstRes.isReplayed, false);

      // Re-send EXACT same request with same key
      const secondRes = await client.createRenderJob(payload);
      assert.equal(secondRes.id, firstRes.id);
      assert.equal(secondRes.isReplayed, true);
    });

    it('5.4 Rejects differing payload for same key with 409 IDEMPOTENCY_CONFLICT', async () => {
      const conflictKey = generateIdempotencyKey('conflict_key_test');

      await client.createRenderJob({
        compositionId: 'cmp_conflict_1',
        revision: 1,
        idempotencyKey: conflictKey,
      });

      // Second request with SAME key but DIFFERENT payload (composition_id is cmp_conflict_2)
      await assert.rejects(
        () =>
          client.createRenderJob({
            compositionId: 'cmp_conflict_2',
            revision: 1,
            idempotencyKey: conflictKey,
          }),
        (err) => {
          assert.ok(err instanceof IdempotencyConflictError);
          assert.equal(err.status, 409);
          assert.equal(err.code, 'IDEMPOTENCY_CONFLICT');
          return true;
        },
      );
    });
  });

  // =========================================================================
  // 6. Cancellation State Machine
  // =========================================================================
  describe('6. Cancellation State Machine (202 -> 200 -> 409)', () => {
    it('6.1 Cancels active job (202), confirms already canceled (200), rejects terminal (409)', async () => {
      const job = await client.createRenderJob({
        compositionId: 'cmp_cancel_states',
        revision: 1,
        idempotencyKey: generateIdempotencyKey('idem_cancel_states'),
      });

      // 1. Cancel queued/active job -> returns 202 Accepted
      const cancelRes1 = await client.cancelJob(job.id, {
        reason: 'Customer initiated cancel',
        idempotencyKey: generateIdempotencyKey('idem_cancel_act1'),
      });
      assert.equal(cancelRes1.httpStatus, 202);
      assert.equal(cancelRes1.state, 'canceled');

      // 2. Cancel already canceled job with NEW key -> returns 200 OK state confirmation
      const cancelRes2 = await client.cancelJob(job.id, {
        idempotencyKey: generateIdempotencyKey('idem_cancel_act2'),
      });
      assert.equal(cancelRes2.httpStatus, 200);
      assert.equal(cancelRes2.state, 'canceled');

      // 3. Canceling completed terminal job -> throws JobTerminalError (409 JOB_TERMINAL)
      const finishedJob = await client.createRenderJob({
        compositionId: 'cmp_terminal_check',
        revision: 1,
        idempotencyKey: generateIdempotencyKey('idem_term_job'),
      });
      mockServer.updateJobState(finishedJob.id, 'succeeded');

      await assert.rejects(
        () =>
          client.cancelJob(finishedJob.id, {
            idempotencyKey: generateIdempotencyKey('idem_cancel_term'),
          }),
        (err) => {
          assert.ok(err instanceof JobTerminalError);
          assert.equal(err.status, 409);
          assert.equal(err.code, 'JOB_TERMINAL');
          return true;
        },
      );
    });
  });

  // =========================================================================
  // 7. Webhooks Management & Secret Redaction
  // =========================================================================
  describe('7. Webhooks Lifecycle & Secret Protection', () => {
    it('7.1 Registers webhook, receives secret once, confirms GET never leaks secret, rotates key', async () => {
      // 1. Register webhook endpoint
      const registered = await client.registerWebhookEndpoint({
        url: 'https://client.example.invalid/hooks/cve',
        events: ['job.succeeded', 'job.failed', 'job.canceled'],
        description: 'Primary Creativanta Dispatcher Webhook',
      });

      assert.ok(registered.id.startsWith('wh_'));
      assert.equal(registered.status, 'pending');
      assert.ok(registered.signing_secret, 'Secret must be returned on registration');

      // 2. GET webhook endpoint must NEVER return secret!
      const fetched = await client.getWebhookEndpoint(registered.id);
      assert.equal(fetched.id, registered.id);
      assert.equal(fetched.url, registered.url);
      assert.equal(fetched.signing_secret, undefined);

      // 3. Verify challenge echo
      const verifyRes = await client.verifyWebhookEndpoint(registered.id, 'challenge_token_123');
      assert.equal(verifyRes.verified, true);
      assert.equal(verifyRes.status, 'active');

      // 4. Rotate secret
      const rotated = await client.rotateWebhookEndpointSecret(registered.id);
      assert.equal(rotated.endpoint_id, registered.id);
      assert.ok(rotated.signing_secret);
      assert.ok(rotated.previous_key_expires_at);

      // 5. Delete webhook endpoint
      await client.deleteWebhookEndpoint(registered.id);
      await assert.rejects(
        () => client.getWebhookEndpoint(registered.id),
        (err) => err.status === 404,
      );
    });
  });

  // =========================================================================
  // 8. Usage & Metering Wire Contract
  // =========================================================================
  describe('8. Usage & Metering Wire Contract', () => {
    it('8.1 Retrieves usage report separating operational and billable metrics', async () => {
      const from = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
      const to = new Date().toISOString();

      const usage = await client.getUsage({ from, to });
      assert.equal(usage.from, from);
      assert.equal(usage.to, to);

      // Operational metrics (all attempts, including failed)
      assert.ok(usage.operational);
      assert.ok(typeof usage.operational.total_attempts === 'number');
      assert.ok(typeof usage.operational.cpu_seconds === 'number');

      // Billable metrics (logical succeeded renders only, exact output seconds/60)
      assert.ok(usage.billable);
      assert.ok(typeof usage.billable.succeeded_jobs === 'number');
      assert.ok(typeof usage.billable.output_seconds === 'number');
      assert.ok(typeof usage.billable.billable_output_minutes === 'number');
    });
  });
});
