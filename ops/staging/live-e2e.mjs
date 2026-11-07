/**
 * Creativanta Video Engine — Operator-Invoked Non-Mock Live Staging E2E Verification Harness
 * Canonical specifications:
 *   - docs/TESTING.md (Non-mock E2E tenant isolation, MP4 decode & content integrity)
 *   - docs/SECURITY.md (Anti-IDOR HTTP isolation, signed bearer grants <= 300s, HMAC webhooks)
 *   - docs/API.md (REST API v1 contracts, idempotency replay, cancel semantics)
 *   - docs/DEPLOYMENT.md (Staging topology, fail-closed guards, custom code OFF)
 *
 * Task: P10-B (GitHub #66, parent #63)
 */

import crypto from 'node:crypto';
import http from 'node:http';
import { runStagingPreflight, validateCapabilitiesInvariants } from './preflight.mjs';
import { loadStagingE2EConfig, validateTargetEndpoint } from './config.mjs';
import { RedactedLogger, sanitizeUrl } from './redaction.mjs';
import {
  SYNTHETIC_LICENSED_SVG_BUFFER,
  SYNTHETIC_LICENSED_SVG_SHA256,
  SYNTHETIC_SVG_RIGHTS,
  verifyArtifactIntegrity,
} from './media-verify.mjs';

export const DEFAULT_MAX_JSON_RESPONSE_BYTES = 1024 * 1024; // 1 MiB cap for JSON/text API responses
export const DEFAULT_MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024; // 64 MiB cap for MP4 artifact downloads
export const DEFAULT_MAX_WEBHOOK_BODY_BYTES = 256 * 1024; // 256 KiB cap for incoming webhook payloads

/**
 * Curated system font seeded by migration 0002 (`ast_font_noto_sans_regular`).
 */
export const CURATED_FONT_NOTO_SANS = Object.freeze({
  id: 'fnt_noto_regular',
  asset_id: 'ast_font_noto_sans_regular',
  sha256: 'bf8fd5bfe62cec9cd6ce9bbbe7eab0f8772e3de8be30eb8d0ea0f97ec8452ff5',
  family: 'Noto Sans',
  weight: 400,
  style: 'normal',
});

/**
 * Canonical Scene Spec 1.0 document for live staging end-to-end verification.
 * Strictly conforms to `@creativanta/contracts` JSON Schema (`scene.schema.json`),
 * `SemanticValidator`, `CapabilityValidator` (`mp4-720p-v1`), and `compileComposition`.
 */
export const MINIMAL_STAGING_SCENE_SPEC = Object.freeze({
  schema_version: '1.0',
  canvas: Object.freeze({
    width: 720,
    height: 1280,
    background: '#0f172a',
  }),
  fps: Object.freeze({
    num: 30,
    den: 1,
  }),
  duration_frames: 90,
  seed: 42,
  locale: 'vi-VN',
  direction: 'ltr',
  fonts: Object.freeze([CURATED_FONT_NOTO_SANS]),
  scenes: Object.freeze([
    Object.freeze({
      id: 'scn_staging_01',
      revision: 1,
      start_frame: 0,
      duration_frames: 90,
      engine: 'html-v1',
      background: '#0f172a',
      transition_out: Object.freeze({
        type: 'cut',
        duration_frames: 0,
      }),
      layers: Object.freeze([
        Object.freeze({
          id: 'lyr_bg',
          type: 'shape',
          z_index: 0,
          start_frame: 0,
          duration_frames: 90,
          box: Object.freeze({
            x: 0,
            y: 0,
            width: 720,
            height: 1280,
          }),
          opacity: 1,
          transform: Object.freeze({
            translate_x: 0,
            translate_y: 0,
            scale_x: 1,
            scale_y: 1,
            rotate_deg: 0,
            origin_x: 0.5,
            origin_y: 0.5,
          }),
          animations: Object.freeze([]),
          content: Object.freeze({
            shape: 'rect',
            fill: '#0f172a',
            stroke: '#1e293b',
            stroke_width: 0,
            radius: 0,
          }),
        }),
        Object.freeze({
          id: 'lyr_headline',
          type: 'text',
          z_index: 10,
          start_frame: 0,
          duration_frames: 90,
          box: Object.freeze({
            x: 48,
            y: 430,
            width: 624,
            height: 180,
          }),
          opacity: 1,
          transform: Object.freeze({
            translate_x: 0,
            translate_y: 0,
            scale_x: 1,
            scale_y: 1,
            rotate_deg: 0,
            origin_x: 0.5,
            origin_y: 0.5,
          }),
          animations: Object.freeze([]),
          content: Object.freeze({
            text: 'Creativanta Live Staging — Ưu đãi hôm nay',
            font_id: 'fnt_noto_regular',
            font_size: 44,
            color: '#f8fafc',
            align: 'center',
            line_height: 1.25,
            max_lines: 3,
            overflow: 'shrink',
            min_font_size: 24,
            weight: 400,
          }),
        }),
        Object.freeze({
          id: 'lyr_price',
          type: 'text',
          z_index: 11,
          start_frame: 10,
          duration_frames: 80,
          box: Object.freeze({
            x: 120,
            y: 672,
            width: 480,
            height: 96,
          }),
          opacity: 1,
          transform: Object.freeze({
            translate_x: 0,
            translate_y: 0,
            scale_x: 1,
            scale_y: 1,
            rotate_deg: 0,
            origin_x: 0.5,
            origin_y: 0.5,
          }),
          animations: Object.freeze([]),
          content: Object.freeze({
            text: '199.000 ₫',
            font_id: 'fnt_noto_regular',
            font_size: 36,
            color: '#38bdf8',
            align: 'center',
            line_height: 1.2,
            max_lines: 1,
            overflow: 'ellipsis',
            min_font_size: 20,
            weight: 400,
          }),
        }),
      ]),
    }),
  ]),
  audio_tracks: Object.freeze([]),
  subtitles: Object.freeze([
    Object.freeze({
      id: 'sub_vi_01',
      locale: 'vi-VN',
      burn_in: true,
      style: Object.freeze({
        font_id: 'fnt_noto_regular',
        font_size: 28,
        color: '#ffffff',
        background: '#000000cc',
        align: 'center',
        max_lines: 2,
        safe_margin_px: 64,
      }),
      cues: Object.freeze([
        Object.freeze({
          id: 'cue_01',
          start_frame: 0,
          end_frame: 90,
          text: 'Creativanta Live Staging — Ưu đãi 199.000 ₫',
        }),
      ]),
    }),
  ]),
});

/**
 * Builds a canonical Scene Spec 1.0 document, optionally binding an uploaded SVG asset layer.
 *
 * @param {object} [options]
 * @param {string | { variable: string }} [options.svgAssetId]
 * @param {string | { variable: string }} [options.headline]
 * @param {string | { variable: string }} [options.price]
 * @returns {object}
 */
export function buildStagingCompositionSpec(options = {}) {
  const headline = options.headline ?? 'Creativanta Live Staging — Ưu đãi hôm nay';
  const price = options.price ?? '199.000 ₫';
  const spec = structuredClone(MINIMAL_STAGING_SCENE_SPEC);

  const scene = spec.scenes[0];
  const headlineLayer = scene.layers.find((l) => l.id === 'lyr_headline');
  if (headlineLayer && headlineLayer.content) {
    headlineLayer.content.text = headline;
  }
  const priceLayer = scene.layers.find((l) => l.id === 'lyr_price');
  if (priceLayer && priceLayer.content) {
    priceLayer.content.text = price;
  }

  if (options.svgAssetId) {
    scene.layers.push({
      id: 'lyr_badge_svg',
      type: 'svg',
      z_index: 5,
      start_frame: 0,
      duration_frames: 90,
      box: {
        x: 260,
        y: 160,
        width: 200,
        height: 200,
      },
      opacity: 1,
      transform: {
        translate_x: 0,
        translate_y: 0,
        scale_x: 1,
        scale_y: 1,
        rotate_deg: 0,
        origin_x: 0.5,
        origin_y: 0.5,
      },
      animations: [],
      content: {
        asset_id: options.svgAssetId,
        fit: 'contain',
        anchor_x: 0.5,
        anchor_y: 0.5,
      },
    });
  }

  return spec;
}

/**
 * Builds a canonical `POST /v1/templates` request payload (`CreateTemplateRequest`)
 * with variable placeholders for `headline`, `price`, and `badge_asset_id`.
 *
 * @param {object} [options]
 * @param {string} [options.defaultSvgAssetId='ast_badge_default']
 * @returns {object}
 */
export function buildStagingTemplatePayload(options = {}) {
  const defaultSvgAssetId = options.defaultSvgAssetId || 'ast_badge_default';

  return {
    name: 'Live Staging Retail Promo Template',
    supported_locales: ['vi-VN', 'en-US'],
    variables_schema: {
      type: 'object',
      required: ['headline', 'price', 'badge_asset_id'],
      properties: {
        headline: { type: 'string', maxLength: 120 },
        price: { type: 'string', maxLength: 60 },
        badge_asset_id: { type: 'string', format: 'asset_id', asset_kind: 'svg' },
      },
    },
    defaults: {
      headline: 'Ưu đãi mặc định',
      price: '99.000 ₫',
      badge_asset_id: defaultSvgAssetId,
    },
    composition_spec: buildStagingCompositionSpec({
      headline: { variable: 'headline' },
      price: { variable: 'price' },
      svgAssetId: { variable: 'badge_asset_id' },
    }),
  };
}

/**
 * Error indicating a verification stage is BLOCKED / NOT_VERIFIED due to environment capability
 * or unverified external callback delivery (never treated as PASS).
 */
export class StageBlockedError extends Error {
  constructor(message, code = 'STAGE_BLOCKED') {
    super(message);
    this.name = 'StageBlockedError';
    this.code = code;
    this.status = 'BLOCKED';
  }
}

/**
 * Validates usage response schema and post-run settlement deltas from baseline.
 *
 * @param {object} baseline
 * @param {object} current
 * @returns {{ valid: boolean; deltas: object; errors: string[] }}
 */
export function validateUsageSettlementDelta(baseline, current) {
  const errors = [];

  if (!baseline || typeof baseline !== 'object') {
    errors.push('Baseline usage snapshot is missing or invalid');
  } else {
    if (typeof baseline.operational_attempts !== 'number' || !Number.isFinite(baseline.operational_attempts) || baseline.operational_attempts < 0) {
      errors.push(
        `Baseline usage is missing valid numeric "operational_attempts" (got ${JSON.stringify(baseline.operational_attempts)})`
      );
    }
    if (typeof baseline.billable_output_minutes !== 'number' || !Number.isFinite(baseline.billable_output_minutes) || baseline.billable_output_minutes < 0) {
      errors.push(
        `Baseline usage is missing valid numeric "billable_output_minutes" (got ${JSON.stringify(baseline.billable_output_minutes)})`
      );
    }
  }

  if (!current || typeof current !== 'object') {
    return {
      valid: false,
      deltas: {},
      errors: [...errors, 'Post-run usage response is missing or invalid'],
    };
  }

  if (typeof current.operational_attempts !== 'number' || !Number.isFinite(current.operational_attempts)) {
    errors.push(
      `Usage response is missing required numeric "operational_attempts" field (got ${JSON.stringify(current.operational_attempts)})`
    );
  }
  if (typeof current.billable_output_minutes !== 'number' || !Number.isFinite(current.billable_output_minutes)) {
    errors.push(
      `Usage response is missing required numeric "billable_output_minutes" field (got ${JSON.stringify(current.billable_output_minutes)})`
    );
  }
  if (typeof current.billable_jobs !== 'number' || !Number.isFinite(current.billable_jobs)) {
    errors.push(
      `Usage response is missing required numeric "billable_jobs" field (got ${JSON.stringify(current.billable_jobs)})`
    );
  }

  const baseAttempts = Number(baseline?.operational_attempts ?? 0);
  const currAttempts = Number(current.operational_attempts ?? 0);
  const attemptsDelta = currAttempts - baseAttempts;

  const baseMinutes = Number(baseline?.billable_output_minutes ?? 0);
  const currMinutes = Number(current.billable_output_minutes ?? 0);
  const billableMinutesDelta = Number((currMinutes - baseMinutes).toFixed(6));

  const baseBillableJobs = Number(baseline?.billable_jobs ?? 0);
  const currBillableJobs = Number(current.billable_jobs ?? 0);
  const billableJobsDelta = currBillableJobs - baseBillableJobs;

  const baseSettled = Number(baseline?.reservations?.settled_count ?? 0);
  const currSettled = Number(current.reservations?.settled_count ?? 0);
  const settledDelta = currSettled - baseSettled;

  if (currAttempts <= 0 || attemptsDelta < 1) {
    errors.push(
      `Usage ledger operational_attempts did not advance (baseline=${baseAttempts}, final=${currAttempts}, delta=${attemptsDelta})`
    );
  }

  if (currMinutes <= 0 || billableMinutesDelta <= 0) {
    errors.push(
      `Usage ledger billable_output_minutes did not advance (baseline=${baseMinutes}, final=${currMinutes}, delta=${billableMinutesDelta})`
    );
  }

  if (currBillableJobs <= 0 || billableJobsDelta < 1) {
    errors.push(
      `Usage ledger billable_jobs did not advance (baseline=${baseBillableJobs}, final=${currBillableJobs}, delta=${billableJobsDelta})`
    );
  }

  if (!current.reservations || typeof current.reservations.settled_count !== 'number' || settledDelta < 1) {
    errors.push(
      `Usage ledger reservations.settled_count did not advance (baseline=${baseSettled}, final=${currSettled}, delta=${settledDelta})`
    );
  }

  if (current.reservations && typeof current.reservations.pending_count === 'number' && current.reservations.pending_count < 0) {
    errors.push(`Usage ledger has negative pending_count (${current.reservations.pending_count})`);
  }

  if (!current.reconciliation || typeof current.reconciliation !== 'object') {
    errors.push('Usage response is missing required "reconciliation" audit block');
  } else {
    if (current.reconciliation.clean !== true) {
      errors.push(`Usage ledger reconciliation is not clean (clean=${current.reconciliation.clean})`);
    }
    if (current.reconciliation.double_debit_detected !== false) {
      errors.push(
        `Usage ledger detected double-debit anomaly (double_debit_detected=${current.reconciliation.double_debit_detected})`
      );
    }
    if (Array.isArray(current.reconciliation.discrepancies) && current.reconciliation.discrepancies.length > 0) {
      errors.push(
        `Usage ledger reconciliation reported discrepancies: ${current.reconciliation.discrepancies.join('; ')}`
      );
    }
  }

  return {
    valid: errors.length === 0,
    deltas: {
      operational_attempts: attemptsDelta,
      billable_output_minutes: billableMinutesDelta,
      billable_jobs: billableJobsDelta,
      settled_reservations: settledDelta,
    },
    errors,
  };
}

/**
 * Ephemeral local HTTP webhook receiver bound strictly to loopback or approved private IP.
 * Verifies challenge handshakes (`endpoint.challenge`) and delivered job callbacks (`job.succeeded`)
 * using constant-time HMAC-SHA256 verification (`v1=HMAC_SHA256(secret, "${timestamp}.${rawBody}")`).
 */
export class StagingWebhookReceiver {
  /**
   * @param {object} [options]
   * @param {string} [options.listenHost='127.0.0.1']
   * @param {number} [options.listenPort=0]
   * @param {string} [options.advertiseHost]
   * @param {string} [options.signingSecret]
   * @param {number} [options.maxBodyBytes=DEFAULT_MAX_WEBHOOK_BODY_BYTES]
   */
  constructor(options = {}) {
    this.listenHost = options.listenHost || '127.0.0.1';
    this.listenPort = options.listenPort ?? 0;
    this.advertiseHost = options.advertiseHost || this.listenHost;
    this.signingSecret = options.signingSecret || '';
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_WEBHOOK_BODY_BYTES;
    this.server = null;
    this.port = 0;
    this.url = '';
    this.challengeVerified = false;
    this.challengeEvent = null;
    this.deliveries = [];
    this.invalidDeliveries = [];
  }

  setSigningSecret(secret) {
    this.signingSecret = secret || '';
  }

  async start() {
    // Validate target safety on receiver advertise URL before binding
    validateTargetEndpoint(`http://${this.advertiseHost}:8080/webhook/creativanta`);

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this._handleRequest(req, res).catch((err) => {
          this.invalidDeliveries.push({ reason: err.message });
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Webhook receiver error' }));
          }
        });
      });

      this.server.on('error', reject);
      this.server.listen(this.listenPort, this.listenHost, () => {
        const addr = this.server.address();
        this.port = addr.port;
        this.url = validateTargetEndpoint(
          `http://${this.advertiseHost}:${this.port}/webhook/creativanta`
        );
        resolve(this.url);
      });
    });
  }

  async close() {
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
  }

  async _handleRequest(req, res) {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    const chunks = [];
    let totalBytes = 0;
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.length;
      if (totalBytes > this.maxBodyBytes) {
        this.invalidDeliveries.push({ reason: `Webhook payload exceeded ${this.maxBodyBytes} bytes` });
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
        return;
      }
      chunks.push(buf);
    }

    const rawBody = Buffer.concat(chunks, totalBytes).toString('utf8');
    const sigHeader = String(req.headers['x-cve-signature'] || '');
    const tsHeader = String(req.headers['x-cve-timestamp'] || '');
    const eventIdHeader = String(req.headers['x-cve-event-id'] || '');
    const keyIdHeader = String(req.headers['x-cve-key-id'] || '');

    if (!this.signingSecret) {
      this.invalidDeliveries.push({ reason: 'Webhook receiver has no configured signing secret' });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Signing secret not configured' }));
      return;
    }

    const verifyResult = verifyWebhookHmacSignature({
      signingSecret: this.signingSecret,
      timestampHeader: tsHeader,
      signatureHeader: sigHeader,
      rawBody,
    });

    if (!verifyResult.valid) {
      this.invalidDeliveries.push({
        eventId: eventIdHeader,
        timestamp: tsHeader,
        signature: sigHeader,
        reason: verifyResult.error,
      });
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: verifyResult.error }));
      return;
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      this.invalidDeliveries.push({
        eventId: eventIdHeader,
        reason: 'Invalid JSON in signed webhook body',
      });
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    if (payload.type === 'endpoint.challenge' && typeof payload.data?.challenge === 'string') {
      this.challengeVerified = true;
      this.challengeEvent = payload;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ challenge: payload.data.challenge }));
      return;
    }

    this.deliveries.push({
      eventId: eventIdHeader || payload.id,
      timestamp: tsHeader,
      keyId: keyIdHeader,
      signature: sigHeader,
      signatureValid: true,
      payload,
      rawBody,
    });

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ received: true }));
  }
}

/**
 * Verifies a Creativanta webhook HMAC-SHA256 signature (`X-CVE-Signature: v1=<hex>`)
 * and timestamp replay window (`X-CVE-Timestamp`).
 *
 * @param {object} params
 * @param {string} params.signingSecret
 * @param {string} params.timestampHeader
 * @param {string} params.signatureHeader
 * @param {string} params.rawBody
 * @param {number} [params.toleranceSeconds=300]
 * @returns {{ valid: boolean; error?: string }}
 */
export function verifyWebhookHmacSignature({
  signingSecret,
  timestampHeader,
  signatureHeader,
  rawBody,
  toleranceSeconds = 300,
}) {
  if (!signingSecret || typeof signingSecret !== 'string') {
    return { valid: false, error: 'Missing webhook signing secret' };
  }
  if (!timestampHeader || !/^\d+$/.test(String(timestampHeader))) {
    return { valid: false, error: 'Missing or non-numeric X-CVE-Timestamp header' };
  }

  const tsSeconds = Number(timestampHeader);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - tsSeconds) > toleranceSeconds) {
    return {
      valid: false,
      error: `Webhook timestamp outside ${toleranceSeconds}s replay window (timestamp=${tsSeconds}, now=${nowSeconds})`,
    };
  }

  if (!signatureHeader || typeof signatureHeader !== 'string' || !signatureHeader.startsWith('v1=')) {
    return { valid: false, error: 'Missing or malformed X-CVE-Signature header (expected v1=<hex>)' };
  }

  const actualHex = signatureHeader.slice(3).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(actualHex)) {
    return { valid: false, error: 'X-CVE-Signature v1 digest must be 64 hexadecimal characters' };
  }

  const expectedHex = crypto
    .createHmac('sha256', signingSecret)
    .update(`${timestampHeader}.${rawBody}`, 'utf8')
    .digest('hex')
    .toLowerCase();

  const actualBuf = Buffer.from(actualHex, 'hex');
  const expectedBuf = Buffer.from(expectedHex, 'hex');

  if (actualBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(actualBuf, expectedBuf)) {
    return { valid: false, error: 'HMAC-SHA256 signature mismatch' };
  }

  return { valid: true };
}

export class LiveStagingE2EVerifier {
  /**
   * @param {object} [options]
   * @param {string} [options.baseUrl]
   * @param {string} [options.apiKeyA]
   * @param {string} [options.apiKeyB]
   * @param {string} [options.webhookSecret]
   * @param {number} [options.timeoutMs]
   * @param {number} [options.pollIntervalMs]
   * @param {number} [options.pollTimeoutMs]
   * @param {number} [options.webhookDeliveryTimeoutMs]
   * @param {number} [options.maxJsonResponseBytes]
   * @param {number} [options.maxDownloadBytes]
   * @param {string} [options.webhookListenHost]
   * @param {number} [options.webhookListenPort]
   * @param {string} [options.webhookAdvertiseHost]
   * @param {(buffer: Buffer) => object} [options.ffprobeRunner]
   * @param {typeof fetch} [options.customFetch]
   * @param {RedactedLogger} [options.logger]
   */
  constructor(options = {}) {
    const envConfig = loadStagingE2EConfig(process.env);

    this.baseUrl = options.baseUrl || envConfig.baseUrl;
    this.apiKeyA = options.apiKeyA || envConfig.apiKeyA;
    this.apiKeyB = options.apiKeyB || envConfig.apiKeyB;
    this.webhookSecret = options.webhookSecret || envConfig.webhookSecret;
    this.timeoutMs = options.timeoutMs || envConfig.timeoutMs;
    this.pollIntervalMs = options.pollIntervalMs || envConfig.pollIntervalMs;
    this.pollTimeoutMs = options.pollTimeoutMs || envConfig.pollTimeoutMs;
    this.webhookDeliveryTimeoutMs =
      options.webhookDeliveryTimeoutMs ?? Math.min(this.pollTimeoutMs, 5000);
    this.maxJsonResponseBytes = options.maxJsonResponseBytes ?? DEFAULT_MAX_JSON_RESPONSE_BYTES;
    this.maxDownloadBytes = options.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
    this.webhookListenHost = options.webhookListenHost || '127.0.0.1';
    this.webhookListenPort = options.webhookListenPort ?? 0;
    this.webhookAdvertiseHost = options.webhookAdvertiseHost || this.webhookListenHost;
    this.ffprobeRunner = options.ffprobeRunner;
    this.customFetch = options.customFetch ?? globalThis.fetch;

    this.logger = options.logger || new RedactedLogger(process.stdout);
    this.logger.registerSecret(this.apiKeyA);
    this.logger.registerSecret(this.apiKeyB);
    this.logger.registerSecret(this.webhookSecret);
  }

  /**
   * Performs preflight checks against target endpoint.
   * Fails closed if live services are down or absent.
   * @returns {Promise<object>}
   */
  async runPreflight() {
    return runStagingPreflight(
      {
        baseUrl: this.baseUrl,
        apiKeyA: this.apiKeyA,
        apiKeyB: this.apiKeyB,
      },
      {
        customFetch: this.customFetch,
        timeoutMs: this.timeoutMs,
      }
    );
  }

  /**
   * Executes an HTTP request with an AbortController covering headers AND entire response body
   * stream, enforcing a strict byte cap (`maxResponseBytes`).
   *
   * @private
   */
  async _fetchRaw(
    url,
    {
      method = 'GET',
      headers = {},
      body = undefined,
      timeoutMs = this.timeoutMs,
      maxResponseBytes = this.maxJsonResponseBytes,
    } = {}
  ) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    try {
      const res = await this.customFetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });

      const contentLengthHeader = res.headers?.get?.('content-length');
      if (contentLengthHeader !== null && contentLengthHeader !== undefined) {
        const declaredBytes = Number(contentLengthHeader);
        if (Number.isFinite(declaredBytes) && declaredBytes > maxResponseBytes) {
          try {
            await res.body?.cancel?.();
          } catch {
            // Ignore cancel error
          }
          throw new Error(
            `RESPONSE_BODY_TOO_LARGE: Content-Length (${declaredBytes} bytes) exceeds maximum allowed (${maxResponseBytes} bytes)`
          );
        }
      }

      let rawBuffer;
      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        const chunks = [];
        let totalBytes = 0;

        const onAbort = () => {
          reader.cancel().catch(() => {});
        };
        controller.signal.addEventListener('abort', onAbort, { once: true });

        try {
          while (true) {
            if (controller.signal.aborted) {
              throw controller.signal.reason || new Error('Request aborted');
            }
            const { done, value } = await reader.read();
            if (done) break;
            const buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
            totalBytes += buf.length;
            if (totalBytes > maxResponseBytes) {
              await reader.cancel().catch(() => {});
              throw new Error(
                `RESPONSE_BODY_TOO_LARGE: Response body stream (${totalBytes} bytes) exceeded maximum allowed (${maxResponseBytes} bytes)`
              );
            }
            chunks.push(buf);
          }
          rawBuffer = Buffer.concat(chunks, totalBytes);
        } finally {
          controller.signal.removeEventListener('abort', onAbort);
        }
      } else if (typeof res.arrayBuffer === 'function') {
        const arrayBuf = await res.arrayBuffer();
        rawBuffer = Buffer.from(arrayBuf);
        if (rawBuffer.length > maxResponseBytes) {
          throw new Error(
            `RESPONSE_BODY_TOO_LARGE: Response body (${rawBuffer.length} bytes) exceeded maximum allowed (${maxResponseBytes} bytes)`
          );
        }
      } else if (typeof res.text === 'function') {
        const txt = await res.text();
        rawBuffer = Buffer.from(txt, 'utf8');
        if (rawBuffer.length > maxResponseBytes) {
          throw new Error(
            `RESPONSE_BODY_TOO_LARGE: Response body (${rawBuffer.length} bytes) exceeded maximum allowed (${maxResponseBytes} bytes)`
          );
        }
      } else {
        rawBuffer = Buffer.alloc(0);
      }

      return {
        status: res.status,
        ok: res.ok,
        headers: res.headers,
        buffer: rawBuffer,
      };
    } catch (err) {
      if (timedOut || err?.name === 'AbortError' || err?.name === 'TimeoutError') {
        throw new Error(
          `REQUEST_TIMEOUT: HTTP ${method} ${sanitizeUrl(url)} timed out after ${timeoutMs}ms`
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Helper to make authenticated HTTP JSON requests with bounded timeout and body size cap.
   * @private
   */
  async _request(
    path,
    {
      method = 'GET',
      apiKey,
      body,
      headers = {},
      idempotencyKey,
      timeoutMs = this.timeoutMs,
      maxResponseBytes = this.maxJsonResponseBytes,
    } = {}
  ) {
    const url = `${this.baseUrl}${path}`;
    const reqHeaders = {
      Accept: 'application/json',
      ...headers,
    };

    if (apiKey) {
      reqHeaders['Authorization'] = `Bearer ${apiKey}`;
    }

    if (idempotencyKey) {
      reqHeaders['Idempotency-Key'] = idempotencyKey;
    }

    let bodyStr = undefined;
    if (body !== undefined) {
      reqHeaders['Content-Type'] = 'application/json; charset=utf-8';
      bodyStr = JSON.stringify(body);
    }

    const rawRes = await this._fetchRaw(url, {
      method,
      headers: reqHeaders,
      body: bodyStr,
      timeoutMs,
      maxResponseBytes,
    });

    let resBody = null;
    const contentType = rawRes.headers?.get?.('content-type') || '';
    const text = rawRes.buffer.toString('utf8');

    if (contentType.includes('application/json')) {
      if (text.length > 0) {
        try {
          resBody = JSON.parse(text);
        } catch {
          resBody = null;
        }
      }
    } else {
      resBody = text;
    }

    return {
      status: rawRes.status,
      ok: rawRes.ok,
      headers: rawRes.headers,
      data: resBody,
      isReplayed: rawRes.headers?.get?.('idempotency-replayed') === 'true',
    };
  }

  /**
   * Polls job status until it reaches a terminal state (succeeded, failed, canceled).
   * @private
   */
  async _pollJob(jobId, apiKey, timeoutMs = 30000) {
    const start = Date.now();
    let delay = this.pollIntervalMs;

    while (Date.now() - start < timeoutMs) {
      const res = await this._request(`/jobs/${jobId}`, { apiKey });
      if (!res.ok) {
        throw new Error(`Failed to poll job ${jobId}: HTTP ${res.status}`);
      }

      const job = res.data;
      if (job.state === 'succeeded' || job.state === 'failed' || job.state === 'canceled') {
        return job;
      }

      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(Math.floor(delay * 1.5), 5000);
    }

    throw new Error(`Polling timeout exceeded (${timeoutMs}ms) for job ${jobId}`);
  }

  /**
   * Waits for the local webhook receiver to receive a verified event matching predicate.
   * @private
   */
  async _waitForWebhookDelivery(receiver, predicate, timeoutMs) {
    const start = Date.now();
    const interval = Math.max(10, Math.min(this.pollIntervalMs, 100));

    while (Date.now() - start < timeoutMs) {
      if (receiver.invalidDeliveries.length > 0) {
        const invalid = receiver.invalidDeliveries[0];
        throw new Error(
          `Webhook callback failed HMAC-SHA256 verification: ${invalid.reason}`
        );
      }

      const found = receiver.deliveries.find(predicate);
      if (found) {
        return found;
      }

      await new Promise((resolve) => setTimeout(resolve, interval));
    }

    if (receiver.invalidDeliveries.length > 0) {
      const invalid = receiver.invalidDeliveries[0];
      throw new Error(
        `Webhook callback failed HMAC-SHA256 verification: ${invalid.reason}`
      );
    }

    return null;
  }

  /**
   * Runs the complete non-mock live staging verification suite.
   * If real dependencies are absent, returns structured NOT_READY status without mocking.
   * If dependencies are present, executes full end-to-end verification.
   *
   * @returns {Promise<object>}
   */
  async run() {
    const startedAt = Date.now();
    this.logger.info(`Starting Live Staging E2E Verifier against target: ${sanitizeUrl(this.baseUrl)}`);

    // -------------------------------------------------------------------------
    // Phase 1: Fail-Closed Preflight
    // -------------------------------------------------------------------------
    const preflight = await this.runPreflight();

    if (!preflight.ready) {
      this.logger.warn(
        `Preflight check FAILED CLOSED (Status: NOT_READY). Real external services are absent or degraded.`,
        {
          dependencies: preflight.dependencies,
          blockers: preflight.blockers,
        }
      );

      return {
        status: 'NOT_READY',
        decision: 'HOLD_SERVICES_NOT_DEPLOYED',
        targetUrl: sanitizeUrl(this.baseUrl),
        durationMs: Date.now() - startedAt,
        preflight,
        stages: [],
        totalStages: 0,
        passedStages: 0,
        failedStages: 0,
        blockedStages: 0,
        dependencies: preflight.dependencies,
        blockers: preflight.blockers,
        summary: `Preflight failed closed. Target API at ${sanitizeUrl(this.baseUrl)} does not have live operational services running. No mock server was invoked per NO-MOCK policy.`,
      };
    }

    this.logger.info(
      `Preflight passed. Target API and capabilities verified live. Proceeding with Live E2E tests.`
    );

    const stages = [];
    let passedCount = 0;
    let failedCount = 0;
    let blockedCount = 0;

    // Helper to record stage results
    const executeStage = async (id, title, fn) => {
      const stageStart = Date.now();
      try {
        const details = await fn();
        const durationMs = Date.now() - stageStart;
        stages.push({
          id,
          title,
          status: 'PASS',
          passed: true,
          durationMs,
          details: details || 'Passed',
        });
        passedCount++;
        this.logger.info(`Stage ${id} (${title}) PASSED in ${durationMs}ms`);
      } catch (err) {
        const durationMs = Date.now() - stageStart;
        if (err instanceof StageBlockedError || err?.status === 'BLOCKED') {
          stages.push({
            id,
            title,
            status: 'BLOCKED',
            passed: false,
            durationMs,
            error: err.message,
          });
          blockedCount++;
          this.logger.warn(`Stage ${id} (${title}) BLOCKED in ${durationMs}ms: ${err.message}`);
        } else {
          stages.push({
            id,
            title,
            status: 'FAIL',
            passed: false,
            durationMs,
            error: err.message,
          });
          failedCount++;
          this.logger.error(`Stage ${id} (${title}) FAILED in ${durationMs}ms: ${err.message}`);
        }
        throw err;
      }
    };

    const webhookReceiver = new StagingWebhookReceiver({
      listenHost: this.webhookListenHost,
      listenPort: this.webhookListenPort,
      advertiseHost: this.webhookAdvertiseHost,
    });

    let webhookEndpointId = null;
    const usageWindowFrom = new Date(Date.now() - 3600000).toISOString();
    let baselineUsage = null;

    try {
      await webhookReceiver.start();

      // -----------------------------------------------------------------------
      // STAGE 01: Preflight Record & Usage Baseline Capture
      // -----------------------------------------------------------------------
      await executeStage('LIVE-01', 'Preflight & Security Guardrails + Usage Baseline', async () => {
        const usageTo = new Date(Date.now() + 60000).toISOString();
        const baseRes = await this._request(
          `/usage?from=${encodeURIComponent(usageWindowFrom)}&to=${encodeURIComponent(usageTo)}`,
          {
            method: 'GET',
            apiKey: this.apiKeyA,
          }
        );

        if (!baseRes.ok || !baseRes.data || typeof baseRes.data !== 'object') {
          throw new Error(`Failed to capture baseline usage snapshot: HTTP ${baseRes.status}`);
        }

        if (
          typeof baseRes.data.operational_attempts !== 'number' ||
          typeof baseRes.data.billable_output_minutes !== 'number'
        ) {
          throw new Error(
            `Baseline usage response is missing canonical fields operational_attempts / billable_output_minutes`
          );
        }

        baselineUsage = baseRes.data;
        return `Target: ${sanitizeUrl(this.baseUrl)}, Custom Code: OFF, VideoFlow/Remote Import: OFF, Baseline attempts=${baselineUsage.operational_attempts}`;
      });

      // -----------------------------------------------------------------------
      // STAGE 02: Multi-Tenant HTTP Authentication & Anti-IDOR Boundary
      // -----------------------------------------------------------------------
      let tenantACompositionId = null;
      await executeStage('LIVE-02', 'Multi-Tenant Authentication & Anti-IDOR Isolation', async () => {
        // Validate canonical Scene Spec 1.0 against /compositions/validate
        const valRes = await this._request('/compositions/validate', {
          method: 'POST',
          apiKey: this.apiKeyA,
          body: {
            spec: MINIMAL_STAGING_SCENE_SPEC,
            profile: 'mp4-720p-v1',
          },
        });

        if (!valRes.ok || valRes.data?.valid !== true) {
          throw new Error(
            `Canonical composition spec validation failed: HTTP ${valRes.status} (${JSON.stringify(valRes.data?.errors || valRes.data)})`
          );
        }

        // Tenant A creates a private composition
        const compRes = await this._request('/compositions', {
          method: 'POST',
          apiKey: this.apiKeyA,
          idempotencyKey: `comp_idor_a_${crypto.randomUUID()}`,
          body: {
            name: 'Tenant A Private Composition',
            spec: MINIMAL_STAGING_SCENE_SPEC,
          },
        });

        if (!compRes.ok || !compRes.data?.id) {
          throw new Error(`Tenant A failed to create composition: HTTP ${compRes.status}`);
        }
        tenantACompositionId = compRes.data.id;

        // Tenant B attempts to read Tenant A's private composition
        const idorRes = await this._request(`/compositions/${tenantACompositionId}`, {
          method: 'GET',
          apiKey: this.apiKeyB,
        });

        // Anti-IDOR assertion: Foreign ID must return HTTP 404 NOT_FOUND (never 200 or 403)
        if (idorRes.status !== 404) {
          throw new Error(
            `CRITICAL ANTI-IDOR FAILURE: Tenant B accessing Tenant A resource returned HTTP ${idorRes.status}, expected 404 NOT_FOUND`
          );
        }

        return `Anti-IDOR verified: Tenant B received 404 NOT_FOUND when accessing Tenant A composition (${tenantACompositionId})`;
      });

      // -----------------------------------------------------------------------
      // STAGE 03: Synthetic Licensed Media Intake & Quarantine Completion
      // -----------------------------------------------------------------------
      let uploadedAssetId = null;
      await executeStage('LIVE-03', 'Media Upload Grant, S3 PUT & Quarantine Complete', async () => {
        const uploadRes = await this._request('/assets/uploads', {
          method: 'POST',
          apiKey: this.apiKeyA,
          idempotencyKey: `asset_up_${crypto.randomUUID()}`,
          body: {
            filename: 'synthetic-promo-badge.svg',
            mime_type: 'image/svg+xml',
            bytes: SYNTHETIC_LICENSED_SVG_BUFFER.length,
            sha256: SYNTHETIC_LICENSED_SVG_SHA256,
            rights: SYNTHETIC_SVG_RIGHTS,
          },
        });

        if (!uploadRes.ok || !uploadRes.data?.asset_id || !uploadRes.data?.upload_url) {
          throw new Error(`Failed to initiate asset upload: HTTP ${uploadRes.status}`);
        }

        uploadedAssetId = uploadRes.data.asset_id;
        const uploadUrl = uploadRes.data.upload_url;
        const requiredHeaders = uploadRes.data.required_headers || {};

        // PUT raw bytes to quarantine upload URL with bounded timeout
        const putRes = await this._fetchRaw(uploadUrl, {
          method: 'PUT',
          headers: {
            ...requiredHeaders,
            'Content-Type': 'image/svg+xml',
            'Content-Length': String(SYNTHETIC_LICENSED_SVG_BUFFER.length),
          },
          body: SYNTHETIC_LICENSED_SVG_BUFFER,
          timeoutMs: this.timeoutMs,
        });

        if (!putRes.ok && putRes.status !== 200 && putRes.status !== 204) {
          throw new Error(`Direct PUT to upload_url failed: HTTP ${putRes.status}`);
        }

        // Complete asset upload
        const completeRes = await this._request(`/assets/${uploadedAssetId}/complete`, {
          method: 'POST',
          apiKey: this.apiKeyA,
          idempotencyKey: `asset_cmpl_${crypto.randomUUID()}`,
          body: { sha256: SYNTHETIC_LICENSED_SVG_SHA256 },
        });

        if (!completeRes.ok && completeRes.status !== 202) {
          throw new Error(`Asset completion returned status ${completeRes.status}`);
        }

        return `Asset ${uploadedAssetId} uploaded (SHA-256 verified) and complete acknowledged (HTTP ${completeRes.status})`;
      });

      // -----------------------------------------------------------------------
      // STAGE 04: Template Creation, Variable Instantiation & Composition Setup
      // -----------------------------------------------------------------------
      let activeCompositionId = null;
      let activeRevision = 1;
      await executeStage('LIVE-04', 'Template Creation & Variable Instantiation', async () => {
        const templatePayload = buildStagingTemplatePayload({
          defaultSvgAssetId: uploadedAssetId,
        });

        const createTplRes = await this._request('/templates', {
          method: 'POST',
          apiKey: this.apiKeyA,
          idempotencyKey: `tpl_create_${crypto.randomUUID()}`,
          body: templatePayload,
        });

        if (!createTplRes.ok || !createTplRes.data?.id) {
          throw new Error(
            `Failed to create staging template: HTTP ${createTplRes.status} (${JSON.stringify(createTplRes.data)})`
          );
        }

        const templateId = createTplRes.data.id;
        const templateRevision = createTplRes.data.revision || 1;

        const instantiateRes = await this._request(`/templates/${templateId}/instantiate`, {
          method: 'POST',
          apiKey: this.apiKeyA,
          idempotencyKey: `instantiate_${crypto.randomUUID()}`,
          body: {
            template_revision: templateRevision,
            name: 'Live Staging Retail Promo vi-VN',
            locale: 'vi-VN',
            variables: {
              headline: 'Ưu đãi hôm nay',
              price: '199.000 ₫',
              badge_asset_id: uploadedAssetId,
            },
          },
        });

        if (!instantiateRes.ok || !instantiateRes.data?.id) {
          throw new Error(
            `Template instantiation failed: HTTP ${instantiateRes.status} (${JSON.stringify(instantiateRes.data)})`
          );
        }

        activeCompositionId = instantiateRes.data.id;
        activeRevision = instantiateRes.data.revision || 1;
        return `Template ${templateId} (rev ${templateRevision}) instantiated into composition ${activeCompositionId} rev ${activeRevision}`;
      });

      // -----------------------------------------------------------------------
      // STAGE 05: Preview Job Submission & Reconciliation
      // -----------------------------------------------------------------------
      let previewJobId = null;
      await executeStage('LIVE-05', 'Preview Job Execution (preview-360p-v1)', async () => {
        const previewRes = await this._request('/previews', {
          method: 'POST',
          apiKey: this.apiKeyA,
          idempotencyKey: `preview_${crypto.randomUUID()}`,
          body: {
            composition_id: activeCompositionId,
            revision: activeRevision,
            mode: 'clip',
            start_frame: 0,
            duration_frames: 30,
            profile: 'preview-360p-v1',
          },
        });

        if (previewRes.status !== 202 || !previewRes.data?.id) {
          throw new Error(`Preview job submission returned HTTP ${previewRes.status}, expected 202`);
        }

        previewJobId = previewRes.data.id;
        const job = await this._pollJob(previewJobId, this.apiKeyA, this.pollTimeoutMs);

        if (job.state !== 'succeeded') {
          throw new Error(`Preview job ended in state "${job.state}": ${JSON.stringify(job.error)}`);
        }

        return `Preview job ${previewJobId} succeeded. Artifacts: ${(job.artifacts || []).length}`;
      });

      // -----------------------------------------------------------------------
      // STAGE 06: Pre-Job Webhook Registration/Challenge, Render Job, Idempotency & Cancel Drill
      // -----------------------------------------------------------------------
      let renderJobId = null;
      let videoArtifactId = null;
      await executeStage('LIVE-06', 'Render Job Submission, Idempotency & Cancellation Drill', async () => {
        // 1. Register and verify webhook endpoint BEFORE submitting the render job
        const whRes = await this._request('/webhook-endpoints', {
          method: 'POST',
          apiKey: this.apiKeyA,
          idempotencyKey: `wh_reg_${crypto.randomUUID()}`,
          body: {
            url: webhookReceiver.url,
            events: ['job.succeeded', 'job.failed', 'job.canceled'],
          },
        });

        if (!whRes.ok || !whRes.data?.id || !whRes.data?.signing_secret) {
          throw new Error(
            `Webhook endpoint registration failed before render job: HTTP ${whRes.status}`
          );
        }

        webhookEndpointId = whRes.data.id;
        const signingSecret = whRes.data.signing_secret;
        this.logger.registerSecret(signingSecret);
        webhookReceiver.setSigningSecret(signingSecret);

        // Execute challenge verification handshake before submitting job
        const verifyRes = await this._request(`/webhook-endpoints/${webhookEndpointId}/verify`, {
          method: 'POST',
          apiKey: this.apiKeyA,
          idempotencyKey: `wh_verify_${crypto.randomUUID()}`,
          body: { echo_handshake: true },
        });

        if (!verifyRes.ok || verifyRes.data?.state !== 'active' || !webhookReceiver.challengeVerified) {
          throw new Error(
            `Webhook challenge verification failed before render job: HTTP ${verifyRes.status}, state=${verifyRes.data?.state}, challengeVerified=${webhookReceiver.challengeVerified}`
          );
        }

        // 2. Mandatory cancellation drill on an auxiliary preview job
        const auxJobRes = await this._request('/previews', {
          method: 'POST',
          apiKey: this.apiKeyA,
          idempotencyKey: `aux_cancel_${crypto.randomUUID()}`,
          body: {
            composition_id: activeCompositionId,
            revision: activeRevision,
            mode: 'frame',
            frame_index: 0,
            profile: 'preview-360p-v1',
          },
        });

        if (auxJobRes.status !== 202 || !auxJobRes.data?.id) {
          throw new Error(
            `Cancellation drill failed: auxiliary job creation returned HTTP ${auxJobRes.status}, expected 202`
          );
        }

        const auxJobId = auxJobRes.data.id;
        const cancelRes = await this._request(`/jobs/${auxJobId}/cancel`, {
          method: 'POST',
          apiKey: this.apiKeyA,
          idempotencyKey: `cancel_req_${crypto.randomUUID()}`,
          body: {},
        });

        if (cancelRes.status === 404 || cancelRes.status === 405 || cancelRes.status === 501) {
          throw new StageBlockedError(
            `Cancellation drill blocked: POST /jobs/${auxJobId}/cancel unsupported (HTTP ${cancelRes.status})`,
            'CANCEL_UNSUPPORTED'
          );
        }

        if (cancelRes.status !== 200 && cancelRes.status !== 202) {
          throw new Error(`Job cancellation returned unexpected HTTP ${cancelRes.status}`);
        }

        const auxTerminalJob = await this._pollJob(auxJobId, this.apiKeyA, this.pollTimeoutMs);
        if (auxTerminalJob.state !== 'canceled') {
          throw new Error(
            `Cancellation drill not honored: auxiliary job ${auxJobId} reached terminal state "${auxTerminalJob.state}", expected "canceled"`
          );
        }

        // 3. Submit primary render job bound to the verified active webhook endpoint
        const renderIdempotencyKey = `live_stg_render_${crypto.randomUUID()}`;
        const renderBody = {
          composition_id: activeCompositionId,
          revision: activeRevision,
          profile: 'mp4-720p-v1',
          webhook_endpoint_id: webhookEndpointId,
          client_reference: 'live-staging-audit-job-001',
        };

        const renderRes1 = await this._request('/render-jobs', {
          method: 'POST',
          apiKey: this.apiKeyA,
          idempotencyKey: renderIdempotencyKey,
          body: renderBody,
        });

        if (renderRes1.status !== 202 || !renderRes1.data?.id) {
          throw new Error(`Render job submission returned HTTP ${renderRes1.status}`);
        }
        renderJobId = renderRes1.data.id;

        // 4. Idempotency replay check
        const renderRes2 = await this._request('/render-jobs', {
          method: 'POST',
          apiKey: this.apiKeyA,
          idempotencyKey: renderIdempotencyKey,
          body: renderBody,
        });

        if (!renderRes2.isReplayed || renderRes2.data?.id !== renderJobId) {
          throw new Error(`Idempotency replay failed: expected replayed job ${renderJobId}`);
        }

        // 5. Wait for primary render job to complete
        const job = await this._pollJob(renderJobId, this.apiKeyA, this.pollTimeoutMs * 2);
        if (job.state !== 'succeeded') {
          throw new Error(
            `Render job ${renderJobId} ended in state "${job.state}": ${JSON.stringify(job.error)}`
          );
        }

        const artifacts = job.artifacts || [];
        const video = artifacts.find((a) => a.kind === 'video' || a.mime_type === 'video/mp4');
        if (!video) {
          throw new Error(`Render job completed without a video artifact in manifest`);
        }
        videoArtifactId = video.id;

        return `Render job ${renderJobId} succeeded (idempotency & cancel drill on ${auxJobId} -> canceled confirmed). Video artifact: ${videoArtifactId}`;
      });

      // -----------------------------------------------------------------------
      // STAGE 07: Signed Webhook Challenge & Delivered Callback Verification
      // -----------------------------------------------------------------------
      await executeStage('LIVE-07', 'Signed Webhook Registration & HMAC-SHA256 Delivery Verification', async () => {
        if (!webhookEndpointId || ! webhookReceiver.challengeVerified) {
          throw new Error('Webhook endpoint was not registered and challenge-verified prior to job execution');
        }

        const delivered = await this._waitForWebhookDelivery(
          webhookReceiver,
          (d) =>
            d.payload?.type === 'job.succeeded' &&
            (d.payload?.data?.job_id === renderJobId || d.payload?.data?.id === renderJobId),
          this.webhookDeliveryTimeoutMs
        );

        if (!delivered) {
          throw new StageBlockedError(
            `WEBHOOK_CALLBACK_NOT_VERIFIED: No signed job.succeeded callback was delivered to receiver ${sanitizeUrl(webhookReceiver.url)} for job ${renderJobId} within ${this.webhookDeliveryTimeoutMs}ms`,
            'WEBHOOK_NOT_VERIFIED'
          );
        }

        if (!delivered.signatureValid) {
          throw new Error(`Delivered webhook callback for job ${renderJobId} did not pass HMAC verification`);
        }

        if (delivered.payload?.data?.state && delivered.payload.data.state !== 'succeeded') {
          throw new Error(
            `Delivered webhook callback reported unexpected job state "${delivered.payload.data.state}"`
          );
        }

        // Clean up registered webhook endpoint
        const delRes = await this._request(`/webhook-endpoints/${webhookEndpointId}`, {
          method: 'DELETE',
          apiKey: this.apiKeyA,
        });

        if (!delRes.ok && delRes.status !== 204 && delRes.status !== 200) {
          throw new Error(`Failed to delete webhook endpoint ${webhookEndpointId}: HTTP ${delRes.status}`);
        }
        webhookEndpointId = null;

        return `Webhook challenge + signed job.succeeded delivery (${delivered.eventId}) HMAC-SHA256 verified from live callback payload`;
      });

      // -----------------------------------------------------------------------
      // STAGE 08: Download Grant & Real MP4 Buffer + ffprobe Decode Integrity
      // -----------------------------------------------------------------------
      await executeStage('LIVE-08', 'Download Grant Expiry (<=300s) & Real MP4 Decode Integrity', async () => {
        if (!videoArtifactId) {
          throw new Error('No video artifact available for download test');
        }

        const grantRes = await this._request(`/artifacts/${videoArtifactId}/download`, {
          method: 'GET',
          apiKey: this.apiKeyA,
        });

        if (!grantRes.ok || !grantRes.data?.url) {
          throw new Error(`Failed to obtain download grant: HTTP ${grantRes.status}`);
        }

        const grant = grantRes.data;
        const expiresAt = Date.parse(grant.expires_at);
        const now = Date.now();
        const ttlSeconds = (expiresAt - now) / 1000;

        if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
          throw new Error(`Download grant is already expired or has invalid expires_at (${grant.expires_at})`);
        }

        if (ttlSeconds > 300) {
          throw new Error(
            `Download grant TTL exceeds 300 seconds security cap (actual: ${ttlSeconds.toFixed(1)}s)`
          );
        }

        // Download artifact bytes via signed URL with bounded timeout and byte cap
        const downloadRes = await this._fetchRaw(grant.url, {
          method: 'GET',
          timeoutMs: this.timeoutMs,
          maxResponseBytes: this.maxDownloadBytes,
        });

        if (!downloadRes.ok) {
          throw new Error(`Failed to download video bytes from grant URL: HTTP ${downloadRes.status}`);
        }

        const videoBuffer = downloadRes.buffer;

        // Verify artifact integrity (SHA-256, byte count, ISOBMFF video track boxes, and fail-closed ffprobe decode)
        const integrity = verifyArtifactIntegrity(videoBuffer, {
          expectedBytes: grant.bytes,
          expectedSha256: grant.sha256,
          isMp4: true,
          requireFfprobe: true,
          ffprobeRunner: this.ffprobeRunner,
        });

        if (!integrity.valid) {
          throw new Error(`Artifact integrity validation failed: ${integrity.errors.join('; ')}`);
        }

        return `Downloaded ${videoBuffer.length} bytes (SHA-256 match, ISOBMFF vide/${integrity.boxAnalysis?.videoCodec} + ffprobe decode verified, grant TTL ${ttlSeconds.toFixed(0)}s)`;
      });

      // -----------------------------------------------------------------------
      // STAGE 09: Post-Restore / Rollback Safety Invariant Audit
      // -----------------------------------------------------------------------
      await executeStage('LIVE-09', 'Rollback & Safety Invariants Audit (Custom Code OFF)', async () => {
        const capsRes = await this._request('/capabilities', {
          method: 'GET',
          apiKey: this.apiKeyA,
        });

        if (!capsRes.ok) {
          throw new Error(`Capabilities re-probe failed: HTTP ${capsRes.status}`);
        }

        const { valid, violations } = validateCapabilitiesInvariants(capsRes.data);
        if (!valid) {
          throw new Error(`CRITICAL SECURITY FAILURE: ${violations.join('; ')}`);
        }

        return `Invariants held: custom_code=false, remote_import=false, tts=false, authoring_adapter=false`;
      });

      // -----------------------------------------------------------------------
      // STAGE 10: Usage Metering & Settlement Delta Audit
      // -----------------------------------------------------------------------
      await executeStage('LIVE-10', 'Usage Ledger & Settlement Delta Audit', async () => {
        const usageTo = new Date(Date.now() + 60000).toISOString();

        const usageRes = await this._request(
          `/usage?from=${encodeURIComponent(usageWindowFrom)}&to=${encodeURIComponent(usageTo)}`,
          {
            method: 'GET',
            apiKey: this.apiKeyA,
          }
        );

        if (!usageRes.ok) {
          throw new Error(`Usage query returned HTTP ${usageRes.status}`);
        }

        const usage = usageRes.data;
        const audit = validateUsageSettlementDelta(baselineUsage, usage);
        if (!audit.valid) {
          throw new Error(`Usage settlement audit failed: ${audit.errors.join('; ')}`);
        }

        return `Usage settlement verified: operational_attempts=${usage.operational_attempts} (delta +${audit.deltas.operational_attempts}), billable_output_minutes=${usage.billable_output_minutes} (delta +${audit.deltas.billable_output_minutes}), settled_reservations=${usage.reservations?.settled_count} (delta +${audit.deltas.settled_reservations}), reconciliation.clean=true`;
      });
    } catch {
      // Stage failure/blocker recorded in executeStage
    } finally {
      if (webhookEndpointId) {
        try {
          await this._request(`/webhook-endpoints/${webhookEndpointId}`, {
            method: 'DELETE',
            apiKey: this.apiKeyA,
          });
        } catch {
          // Ignore best-effort cleanup error
        }
      }
      await webhookReceiver.close();
    }

    const totalDurationMs = Date.now() - startedAt;
    const allPassed = failedCount === 0 && blockedCount === 0 && passedCount === 10;
    const isBlocked = failedCount === 0 && blockedCount > 0;

    return {
      status: allPassed ? 'PASS' : isBlocked ? 'BLOCKED' : 'FAIL',
      decision: allPassed
        ? 'STAGING_LIVE_E2E_VERIFIED'
        : isBlocked
        ? 'HOLD_WEBHOOK_CALLBACK_NOT_VERIFIED'
        : 'STAGING_LIVE_E2E_FAILED',
      targetUrl: sanitizeUrl(this.baseUrl),
      durationMs: totalDurationMs,
      preflight,
      stages,
      totalStages: stages.length,
      passedStages: passedCount,
      failedStages: failedCount,
      blockedStages: blockedCount,
      dependencies: preflight.dependencies,
      summary: allPassed
        ? `All 10 live non-mock staging stages PASSED in ${totalDurationMs}ms.`
        : isBlocked
        ? `Live staging verification BLOCKED / NOT_VERIFIED (${blockedCount} stage(s) blocked).`
        : `Live staging verification FAILED (${failedCount} stage(s) failed).`,
    };
  }
}
