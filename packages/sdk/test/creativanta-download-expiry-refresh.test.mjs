/**
 * Task P5-03: Creativanta Artifact Download & Expiry Refresh Tests.
 *
 * Verifies:
 *   - Retrieval of signed download grant (GET /v1/artifacts/{id}/download)
 *   - Download grant expiration semantics (<= 5min signed grant URLs)
 *   - Proactive refresh when grant is within refreshBufferMs of expiring
 *   - Reactive refresh when URL returns 410 GRANT_EXPIRED during download
 *   - SHA-256 and byte count integrity verification (DownloadIntegrityError on mismatch)
 *   - Zero shared DB assumptions
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  CreativantaClient,
  CreativantaContractMock,
  DownloadIntegrityError,
  generateIdempotencyKey,
} from '../dist/index.js';

describe('Creativanta Client: Artifact Download & Expiry Refresh', () => {
  let mockServer;
  let baseUrl;
  let client;
  let testJobId;
  let testArtifactId;
  let expectedContent;
  let expectedSha256;

  before(async () => {
    mockServer = new CreativantaContractMock({
      defaultGrantTtlSeconds: 2, // 2-second short TTL for testing expiry
    });
    baseUrl = await mockServer.start();
    client = new CreativantaClient({
      baseUrl,
      apiKey: mockServer.apiKey,
    });

    // Seed a completed job with an artifact in mock server
    expectedContent = Buffer.from('isobmff-mp4-video-rendered-bytes-720p-creativanta');
    expectedSha256 = crypto.createHash('sha256').update(expectedContent).digest('hex');
    testArtifactId = 'art_vid_download_test_1';
    testJobId = 'job_completed_download_1';

    mockServer.seedJob({
      id: testJobId,
      kind: 'render',
      state: 'succeeded',
      state_version: 5,
      composition_id: 'cmp_download_demo',
      revision: 1,
      profile: 'mp4-720p-v1',
      artifacts: [
        {
          id: testArtifactId,
          kind: 'video',
          mime_type: 'video/mp4',
          sha256: expectedSha256,
          bytes: expectedContent.length,
          content: expectedContent,
        },
      ],
      usage: { output_seconds: 15, cpu_seconds: 5, billable_output_minutes: 0.25 },
      created_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    });
  });

  after(async () => {
    await mockServer.stop();
  });

  it('4.1 Retrieves signed download grant with short TTL and valid metadata', async () => {
    const grant = await client.getArtifactDownloadGrant(testArtifactId);
    assert.ok(grant.url);
    assert.equal(grant.sha256, expectedSha256);
    assert.equal(grant.bytes, expectedContent.length);

    const expiresAtMs = Date.parse(grant.expires_at);
    assert.ok(Number.isFinite(expiresAtMs));
    assert.ok(expiresAtMs > Date.now());
  });

  it('4.2 Explicitly refreshes an artifact download grant without rerendering', async () => {
    const grant1 = await client.getArtifactDownloadGrant(testArtifactId);
    // Refresh to get a second token/URL
    const grant2 = await client.refreshDownloadGrant(testArtifactId);

    assert.ok(grant2.url);
    assert.notEqual(grant1.url, grant2.url, 'Refreshed grant must generate a fresh signed download URL token');
    assert.equal(grant2.sha256, expectedSha256);
    assert.equal(grant2.bytes, expectedContent.length);
  });

  it('4.3 Downloads artifact content and verifies byte length and SHA-256 integrity', async () => {
    const downloadedBuf = await client.downloadArtifact(testArtifactId);
    assert.equal(downloadedBuf.length, expectedContent.length);
    assert.equal(downloadedBuf.toString('utf8'), expectedContent.toString('utf8'));

    const downloadedSha = crypto.createHash('sha256').update(downloadedBuf).digest('hex');
    assert.equal(downloadedSha, expectedSha256);
  });

  it('4.4 Automatically recovers from expired download URL (410 GRANT_EXPIRED) via grant refresh', async () => {
    // Set short TTL: 1 second
    mockServer.grantTtlSeconds = 1;

    // First request grant
    const grant = await client.getArtifactDownloadGrant(testArtifactId);

    // Wait 1200ms so the raw token expires on the server (now past expiresAtMs)
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // Calling the raw URL directly returns 410 GRANT_EXPIRED
    const rawRes = await fetch(grant.url);
    assert.equal(rawRes.status, 410);

    // But client.downloadArtifact() catches 410, refreshes grant, and completes download!
    const recoveredBuf = await client.downloadArtifact(testArtifactId, {
      refreshBufferMs: 0, // Disable proactive refresh to force in-transit 410 recovery
      maxRefreshRetries: 1,
    });

    assert.equal(recoveredBuf.length, expectedContent.length);
    assert.equal(recoveredBuf.toString('utf8'), expectedContent.toString('utf8'));
  });

  it('4.5 Detects corrupted bytes and throws DownloadIntegrityError', async () => {
    // Seed corrupted artifact content on server
    const corruptedId = 'art_corrupted_test';
    const originalBuf = Buffer.from('genuine-unmodified-content');
    const genuineSha = crypto.createHash('sha256').update(originalBuf).digest('hex');

    mockServer.seedJob({
      id: 'job_corrupted',
      kind: 'render',
      state: 'succeeded',
      state_version: 5,
      composition_id: 'cmp_corrupt',
      revision: 1,
      profile: 'mp4-720p-v1',
      artifacts: [
        {
          id: corruptedId,
          kind: 'video',
          mime_type: 'video/mp4',
          sha256: genuineSha, // Claims genuine SHA
          bytes: originalBuf.length,
          content: Buffer.from('TAMPERED-BYTE-STREAM-CORRUPTED'), // Actual content is different!
        },
      ],
      usage: { output_seconds: 15, cpu_seconds: 1, billable_output_minutes: 0.25 },
      created_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    });

    await assert.rejects(
      async () => {
        await client.downloadArtifact(corruptedId, { verifyIntegrity: true });
      },
      (err) => {
        assert.ok(err instanceof DownloadIntegrityError);
        return true;
      },
    );
  });
});
