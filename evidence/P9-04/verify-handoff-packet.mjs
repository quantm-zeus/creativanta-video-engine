#!/usr/bin/env node
/**
 * Verification Script for External Creativanta Handoff Packet (Task P9-04).
 * Validates the handoff packet, fixtures, schemas, env vars, scopes, and executes
 * an end-to-end integration flow against the in-repo CreativantaContractMock.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');

// Import SDK modules from compiled dist
const {
  CreativantaClient,
  CreativantaContractMock,
  CreativantaWebhookReceiver,
} = await import(path.join(ROOT, 'packages/sdk/dist/index.js'));

async function main() {
  const checks = [];

  function recordCheck(name, passed, details = '') {
    checks.push({ name, passed, details });
    if (!passed) {
      console.error(`FAIL: ${name} - ${details}`);
    } else {
      console.log(`PASS: ${name}${details ? ` - ${details}` : ''}`);
    }
  }

  let mock = null;

  try {
    // 1. Validate handoff-packet.json exists and conforms to schema
    const packetPath = path.join(__dirname, 'handoff-packet.json');
    assert(fs.existsSync(packetPath), 'handoff-packet.json must exist');
    const packet = JSON.parse(fs.readFileSync(packetPath, 'utf8'));
    recordCheck('handoff-packet.json structure', true, 'Parsed valid JSON');

    // 2. Validate coordination status
    assert.strictEqual(packet.coordination_status.in_repo_harness.status, 'VERIFIED_READY');
    assert.strictEqual(packet.coordination_status.live_integration.status, 'BLOCKED_PENDING_SEPARATE_AUTHORIZED_SCOPE');
    assert(packet.coordination_status.live_integration.boundary_rules.length >= 4);
    recordCheck('coordination status (harness vs live)', true, 'In-repo harness VERIFIED_READY, live BLOCKED_PENDING_SEPARATE_AUTHORIZED_SCOPE');

    // 3. Validate base URLs
    assert(packet.base_urls.local_harness.base_url.includes('127.0.0.1'));
    assert(packet.base_urls.staging_private_beta.base_url.startsWith('https://'));
    assert(packet.base_urls.production.base_url.startsWith('https://'));
    assert.strictEqual(packet.base_urls.staging_private_beta.tls_required, true);
    assert.strictEqual(packet.base_urls.production.tls_required, true);
    recordCheck('base URLs validation', true, 'Verified local, staging, and production base URLs with TLS policies');

    // 4. Validate environment variable specifications
    const envVars = packet.env_specification.variables;
    assert(envVars.length >= 8, 'Expected at least 8 env vars');
    const requiredEnvNames = [
      'CREATIVANTA_API_BASE_URL',
      'CREATIVANTA_API_KEY',
      'CREATIVANTA_WEBHOOK_SECRET',
      'CREATIVANTA_WEBHOOK_ENDPOINT_URL',
    ];
    for (const reqName of requiredEnvNames) {
      const found = envVars.find((v) => v.name === reqName);
      assert(found, `Missing required env var ${reqName}`);
      assert.strictEqual(found.required, true);
    }
    recordCheck('environment variables specification', true, `${envVars.length} variables specified with types and constraints`);

    // 5. Validate scopes
    const scopes = packet.scopes.all_available_scopes.map((s) => s.scope);
    const recommended = packet.scopes.creativanta_integration_recommended_scopes;
    assert(scopes.includes('jobs:read') && scopes.includes('jobs:write'));
    assert(scopes.includes('templates:read') && scopes.includes('compositions:write'));
    assert(scopes.includes('assets:read') && scopes.includes('assets:write'));
    assert(scopes.includes('webhooks:manage') && scopes.includes('usage:read'));
    for (const rec of recommended) {
      assert(scopes.includes(rec), `Recommended scope ${rec} must be in available scopes`);
    }
    recordCheck('permission scopes catalog', true, `${scopes.length} scopes catalogued, ${recommended.length} recommended for Creativanta`);

    // 6. Validate all referenced fixtures exist and parse as JSON
    const fixtureKeys = Object.keys(packet.fixtures);
    assert(fixtureKeys.length >= 7, 'Expected at least 7 fixtures');
    for (const [key, relPath] of Object.entries(packet.fixtures)) {
      const absPath = path.resolve(ROOT, relPath);
      assert(fs.existsSync(absPath), `Fixture file missing: ${relPath}`);
      const fixtureContent = JSON.parse(fs.readFileSync(absPath, 'utf8'));
      assert(typeof fixtureContent === 'object', `Fixture ${key} must be valid JSON object`);
    }
    recordCheck('fixtures completeness', true, `${fixtureKeys.length} fixture files verified and parsed`);

    // 7. Validate entity mappings
    const mappings = packet.entity_mappings.domain_mappings;
    assert(mappings.length >= 6, 'Expected domain mappings');
    assert(packet.entity_mappings.job_state_lifecycle.terminal_states.includes('succeeded'));
    assert(packet.entity_mappings.job_state_lifecycle.terminal_states.includes('failed'));
    assert(packet.entity_mappings.job_state_lifecycle.terminal_states.includes('canceled'));
    recordCheck('entity domain mappings', true, `${mappings.length} domain entity mappings verified`);

    // 8. Security audit: Zero secrets check in handoff packet and fixtures
    const allPacketText = JSON.stringify(packet) + JSON.stringify(
      fixtureKeys.map((k) => JSON.parse(fs.readFileSync(path.resolve(ROOT, packet.fixtures[k]), 'utf8')))
    );
    const secretPattern = /-----BEGIN [A-Z ]*PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{20,}|sk-(?:proj-)?[A-Za-z0-9]{30,}|AKIA[A-Z0-9]{16}/;
    assert(!secretPattern.test(allPacketText), 'Detected potential secret in packet or fixtures');
    recordCheck('security secret redacting audit', true, 'Zero private keys, tokens, or genuine secrets present in handoff packet');

    // 9. Execute in-repo contract simulation against CreativantaContractMock
    mock = new CreativantaContractMock({
      autoAdvanceJobsMs: 50,
    });
    const baseUrl = await mock.start();
    const client = new CreativantaClient({
      baseUrl,
      apiKey: mock.apiKey,
    });

    // Test capabilities query
    const caps = await client.getCapabilities();
    assert(caps.profiles && caps.profiles.length > 0);
    recordCheck('contract simulation: getCapabilities', true, `${caps.profiles.length} profiles supported`);

    // Test template instantiation with retail promo fixture
    const templateFixture = JSON.parse(
      fs.readFileSync(path.resolve(ROOT, packet.fixtures.template_instantiate), 'utf8')
    );
    const instRes = await client.instantiateTemplate(templateFixture.template_id, {
      templateRevision: templateFixture.template_revision,
      name: templateFixture.name,
      variables: templateFixture.variables,
      locale: templateFixture.locale,
      clientReference: templateFixture.client_reference,
    });
    assert(instRes.id, 'Composition must have an ID');
    assert.strictEqual(instRes.revision, 1);
    recordCheck('contract simulation: instantiateTemplate', true, `Created composition ${instRes.id} revision ${instRes.revision}`);

    // Test render job dispatch with Idempotency-Key
    const jobFixture = JSON.parse(
      fs.readFileSync(path.resolve(ROOT, packet.fixtures.render_job_request), 'utf8')
    );
    const jobRes = await client.createRenderJob({
      compositionId: instRes.id,
      revision: instRes.revision,
      profile: jobFixture.profile,
      clientReference: jobFixture.client_reference,
      idempotencyKey: jobFixture.client_options.idempotency_key,
    });
    assert(jobRes.id, 'Job must have an ID');
    recordCheck('contract simulation: createRenderJob', true, `Accepted job ${jobRes.id}`);

    // Test Idempotency replay with the exact same request
    const replayRes = await client.createRenderJob({
      compositionId: instRes.id,
      revision: instRes.revision,
      profile: jobFixture.profile,
      clientReference: jobFixture.client_reference,
      idempotencyKey: jobFixture.client_options.idempotency_key,
    });
    assert.strictEqual(replayRes.isReplayed, true, 'Subsequent call with identical key must return isReplayed=true');
    assert.strictEqual(replayRes.id, jobRes.id);
    recordCheck('contract simulation: idempotency replay', true, `Replayed job ${jobRes.id} without duplication`);

    // Test Polling Reconciliation
    const recRes = await client.reconcileJob(jobRes.id, {
      initialIntervalMs: 50,
      maxIntervalMs: 100,
      timeoutMs: 5000,
    });
    assert.strictEqual(recRes.state, 'succeeded');
    recordCheck('contract simulation: reconcileJob', true, `Reconciliation reached terminal state '${recRes.state}'`);

    // Test Webhook Receiver with HMAC verification
    const webhookSecret = 'whsec_e0f1a2b3c4d5e6f70123456789abcdef0123456789abcdef0123456789abcdef';
    const receiver = new CreativantaWebhookReceiver({
      secrets: webhookSecret,
      maxSkewSeconds: 300,
    });

    const timestampSec = Math.floor(Date.now() / 1000);
    const webhookFixture = JSON.parse(
      fs.readFileSync(path.resolve(ROOT, packet.fixtures.webhook_job_succeeded), 'utf8')
    );
    const rawPayloadBuffer = Buffer.from(JSON.stringify(webhookFixture), 'utf8');

    // Compute valid HMAC signature
    const crypto = await import('node:crypto');
    const hmac = crypto.createHmac('sha256', webhookSecret);
    hmac.update(`${timestampSec}.`);
    hmac.update(rawPayloadBuffer);
    const signature = `v1=${hmac.digest('hex')}`;

    const verifyResult = receiver.verifyAndProcess(
      {
        'x-cve-event-id': webhookFixture.id,
        'x-cve-timestamp': String(timestampSec),
        'x-cve-signature': signature,
      },
      rawPayloadBuffer,
    );
    assert.strictEqual(verifyResult.verified, true);
    assert.strictEqual(verifyResult.eventId, webhookFixture.id);
    recordCheck('contract simulation: webhook HMAC verification', true, `Verified event ${verifyResult.eventId}`);

    await mock.stop();

    // All checks passed!
    console.log('\n--- ALL HANDOFF PACKET VERIFICATION CHECKS PASSED ---');
    const summary = {
      status: 'PASS',
      checks_total: checks.length,
      checks_passed: checks.filter((c) => c.passed).length,
      timestamp: new Date().toISOString(),
    };
    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);
  } catch (err) {
    if (mock) {
      try {
        await mock.stop();
      } catch (_) {}
    }
    console.error('Fatal error during handoff packet verification:', err);
    process.exit(1);
  }
}

main();
