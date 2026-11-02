import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadEnvConfig,
  redactEnvConfig,
  redactUrlCredentials,
  parseNumber,
  parseBoolean,
} from '../dist/index.js';

describe('Environment Configuration Parser', () => {
  it('loads valid development defaults when no env is provided', () => {
    const config = loadEnvConfig({});
    assert.strictEqual(config.CVE_ENV, 'development');
    assert.strictEqual(config.CVE_PUBLIC_BASE_URL, 'http://127.0.0.1:8080/v1');
    assert.strictEqual(config.CVE_LEASE_SECONDS, 60);
    assert.strictEqual(config.CVE_HEARTBEAT_SECONDS, 15);
    assert.strictEqual(config.CVE_CUSTOM_CODE_ENABLED, false);
    assert.strictEqual(config.CVE_REMOTE_IMPORT_ENABLED, false);
    assert.strictEqual(config.CVE_RENDERER_ADAPTER, 'chromium-frame-v1');
  });

  it('rejects invalid CVE_ENV', () => {
    assert.throws(
      () => loadEnvConfig({ CVE_ENV: 'unknown' }),
      /Invalid CVE_ENV/,
    );
  });

  it('enforces HTTPS for CVE_PUBLIC_BASE_URL in production', () => {
    assert.throws(
      () =>
        loadEnvConfig({
          CVE_ENV: 'production',
          CVE_PUBLIC_BASE_URL: 'http://api.example.com/v1',
        }),
      /CVE_PUBLIC_BASE_URL must use HTTPS in production/,
    );
  });

  it('enforces heartbeat <= lease / 3 invariant', () => {
    assert.throws(
      () =>
        loadEnvConfig({
          CVE_LEASE_SECONDS: '30',
          CVE_HEARTBEAT_SECONDS: '15',
        }),
      /CVE_HEARTBEAT_SECONDS .* must be <= CVE_LEASE_SECONDS \/ 3/,
    );
  });

  it('rejects custom code enabled without runtime', () => {
    assert.throws(
      () =>
        loadEnvConfig({
          CVE_CUSTOM_CODE_ENABLED: 'true',
          CVE_CUSTOM_RUNTIME: 'disabled',
        }),
      /CVE_CUSTOM_CODE_ENABLED cannot be true while CVE_CUSTOM_RUNTIME is disabled/,
    );
  });

  it('redacts sensitive credentials in URL and secrets', () => {
    const redactedUrl = redactUrlCredentials('postgresql://user:super_secret_pw@127.0.0.1:5432/mydb');
    assert.strictEqual(redactedUrl, 'postgresql://user:REDACTED@127.0.0.1:5432/mydb');

    const config = loadEnvConfig({
      CVE_STORAGE_SECRET_ACCESS_KEY: 'super_secret_s3_key',
      CVE_API_KEY_PEPPER: 'secret_pepper_value_1234567890',
    });
    const redacted = redactEnvConfig(config);
    assert.strictEqual(redacted['CVE_STORAGE_SECRET_ACCESS_KEY'], '[REDACTED]');
    assert.strictEqual(redacted['CVE_API_KEY_PEPPER'], '[REDACTED]');
  });

  it('correctly parses numbers with bounds', () => {
    assert.strictEqual(parseNumber('100', 50, 10, 200), 100);
    assert.strictEqual(parseNumber(undefined, 50, 10, 200), 50);
    assert.throws(() => parseNumber('5', 50, 10, 200), /below minimum/);
    assert.throws(() => parseNumber('300', 50, 10, 200), /above maximum/);
  });

  it('correctly parses booleans', () => {
    assert.strictEqual(parseBoolean('true', false), true);
    assert.strictEqual(parseBoolean('1', false), true);
    assert.strictEqual(parseBoolean('yes', false), true);
    assert.strictEqual(parseBoolean('false', true), false);
    assert.strictEqual(parseBoolean('0', true), false);
    assert.strictEqual(parseBoolean(undefined, true), true);
  });
});
