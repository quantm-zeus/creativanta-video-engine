import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  generateScopedAssetGrant,
  verifyScopedAssetGrant,
  ScopedAssetLoader,
  ScopedGrantError,
  AssetIntegrityError,
  SecurityIsolationError,
} from '../dist/index.js';

describe('P8-02: Scoped Asset Grants & Offline Caching Suite', () => {
  const pepper = 'test_secret_pepper_a1b2c3d4e5f6g7h8';
  const tenantA = 'tenant_alpha';
  const tenantB = 'tenant_beta';

  const sampleImageBytes = Buffer.from('mock_png_image_binary_payload_for_testing');
  const sampleImageSha256 = crypto.createHash('sha256').update(sampleImageBytes).digest('hex');

  it('2.1 Generates and verifies a valid scoped asset grant', () => {
    const grant = generateScopedAssetGrant(
      {
        tenantId: tenantA,
        assetId: 'ast_logo_01',
        filename: 'logo.png',
        mimeType: 'image/png',
        sha256: sampleImageSha256,
        bytes: sampleImageBytes.byteLength,
        ttlSeconds: 180,
      },
      { pepper },
    );

    assert.ok(grant.token);
    assert.ok(grant.downloadUrl.includes('/assets/download/'));

    const verified = verifyScopedAssetGrant(grant.token, {
      pepper,
      expectedTenantId: tenantA,
    });

    assert.equal(verified.tenantId, tenantA);
    assert.equal(verified.assetId, 'ast_logo_01');
    assert.equal(verified.sha256, sampleImageSha256);
    assert.equal(verified.mimeType, 'image/png');
  });

  it('2.2 Enforces Tenant Boundary: cross-tenant grant access is strictly rejected (403)', () => {
    const grantA = generateScopedAssetGrant(
      {
        tenantId: tenantA,
        assetId: 'ast_private_01',
        filename: 'private.png',
        mimeType: 'image/png',
        sha256: sampleImageSha256,
        bytes: sampleImageBytes.byteLength,
      },
      { pepper },
    );

    assert.throws(
      () => {
        verifyScopedAssetGrant(grantA.token, {
          pepper,
          expectedTenantId: tenantB, // Tenant B attempting to access Tenant A's asset
        });
      },
      (err) => {
        assert.ok(err instanceof ScopedGrantError);
        assert.equal(err.code, 'CROSS_TENANT_ACCESS_DENIED');
        assert.equal(err.httpStatus, 403);
        return true;
      },
    );
  });

  it('2.3 Enforces Expiration: expired grants are rejected (410)', () => {
    const pastTime = new Date(Date.now() - 5000);
    const expiredGrant = generateScopedAssetGrant(
      {
        tenantId: tenantA,
        assetId: 'ast_expired_01',
        filename: 'expired.png',
        mimeType: 'image/png',
        sha256: sampleImageSha256,
        bytes: sampleImageBytes.byteLength,
        ttlSeconds: 0,
      },
      { pepper, now: pastTime },
    );

    assert.throws(
      () => {
        verifyScopedAssetGrant(expiredGrant.token, {
          pepper,
          now: new Date(), // current time > past expiry
        });
      },
      (err) => {
        assert.ok(err instanceof ScopedGrantError);
        assert.equal(err.code, 'GRANT_EXPIRED');
        assert.equal(err.httpStatus, 410);
        return true;
      },
    );
  });

  it('2.4 Enforces Tamper-Resistance: signature alteration is strictly rejected (403)', () => {
    const grant = generateScopedAssetGrant(
      {
        tenantId: tenantA,
        assetId: 'ast_logo_01',
        filename: 'logo.png',
        mimeType: 'image/png',
        sha256: sampleImageSha256,
        bytes: sampleImageBytes.byteLength,
      },
      { pepper },
    );

    // Tamper with envelope
    const envelope = JSON.parse(Buffer.from(grant.token, 'base64url').toString('utf8'));
    envelope.assetId = 'ast_other_asset_id'; // Modified payload without recalculating signature
    const tamperedToken = Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url');

    assert.throws(
      () => {
        verifyScopedAssetGrant(tamperedToken, { pepper, expectedTenantId: tenantA });
      },
      (err) => {
        assert.ok(err instanceof ScopedGrantError);
        assert.equal(err.code, 'INVALID_GRANT_SIGNATURE');
        assert.equal(err.httpStatus, 403);
        return true;
      },
    );
  });

  it('2.5 SSRF Protection: rejects arbitrary public URLs and local file schemes', () => {
    const maliciousUrls = [
      'https://untrusted-host.example.com/evil.png',
      'http://169.254.169.254/latest/meta-data/',
      'file:///etc/passwd',
      '../../secrets.env',
    ];

    for (const url of maliciousUrls) {
      assert.throws(
        () => {
          verifyScopedAssetGrant(url, { pepper });
        },
        (err) => {
          assert.ok(err instanceof SecurityIsolationError);
          return true;
        },
      );
    }
  });

  it('2.6 Content Integrity (SHA-256): throws AssetIntegrityError on payload hash mismatch', async () => {
    const grant = generateScopedAssetGrant(
      {
        tenantId: tenantA,
        assetId: 'ast_image_tampered',
        filename: 'image.png',
        mimeType: 'image/png',
        sha256: sampleImageSha256,
        bytes: sampleImageBytes.byteLength,
      },
      { pepper },
    );

    const loader = new ScopedAssetLoader({
      pepper,
      expectedTenantId: tenantA,
      mockByteProvider: () => Buffer.from('corrupted_or_replaced_bytes_from_network'),
    });

    await assert.rejects(
      async () => {
        await loader.loadAsset(grant.token);
      },
      (err) => {
        assert.ok(err instanceof AssetIntegrityError);
        assert.equal(err.code, 'ASSET_HASH_MISMATCH');
        assert.equal(err.expectedHash, sampleImageSha256);
        return true;
      },
    );
  });

  it('2.7 Offline Asset Caching: stores and retrieves verified assets locally', async () => {
    const grant = generateScopedAssetGrant(
      {
        tenantId: tenantA,
        assetId: 'ast_cached_logo',
        filename: 'logo.png',
        mimeType: 'image/png',
        sha256: sampleImageSha256,
        bytes: sampleImageBytes.byteLength,
      },
      { pepper },
    );

    let fetchCount = 0;
    const loader = new ScopedAssetLoader({
      pepper,
      expectedTenantId: tenantA,
      mockByteProvider: () => {
        fetchCount += 1;
        return sampleImageBytes;
      },
    });

    // First load: fetches and caches
    const loaded1 = await loader.loadAsset(grant.token);
    assert.equal(fetchCount, 1);
    assert.deepEqual(loaded1.data, sampleImageBytes);

    // Second load: served directly from offline cache without invoking byte provider
    const loaded2 = await loader.loadAsset(grant.token);
    assert.equal(fetchCount, 1); // Not incremented
    assert.deepEqual(loaded2.data, sampleImageBytes);

    // Direct cache retrieval
    const directCached = loader.getCachedAsset(tenantA, 'ast_cached_logo', sampleImageSha256);
    assert.deepEqual(directCached, sampleImageBytes);
  });
});
