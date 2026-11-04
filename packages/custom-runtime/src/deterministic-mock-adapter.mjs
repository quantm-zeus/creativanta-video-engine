// @ts-check
/**
 * Deterministic Mock Authoring Adapter (Task P7-03).
 *
 * Provides a 100% offline, deterministic, non-subscription-required route
 * for custom scene bundle authoring. Generates complete, valid `custom-html-v1`
 * scene files (index.html, scene.mjs, styles.css, manifest.json, parameter_schema)
 * with strict provenance, token & cost tracking, Vietnamese NFC diacritics support,
 * approved asset binding, and responsive cancellation via AbortSignal.
 */

import crypto from 'node:crypto';
import { CustomRuntimeError } from './adr-policy.mjs';
import {
  AuthoringAdapter,
  estimatePromptTokens,
  calculateAuthoringCost,
} from './authoring-adapter-contract.mjs';

/**
 * Deterministic PRNG based on a 32-bit integer seed or string hash.
 * @param {string | number} seed
 * @returns {() => number}
 */
function createDeterministicRandom(seed) {
  let h = 0x811c9dc5;
  const str = String(seed);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let s = h >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Deterministic Mock Authoring Adapter.
 */
export class DeterministicMockAuthoringAdapter extends AuthoringAdapter {
  constructor(options = {}) {
    super({
      id: 'mock-deterministic',
      name: 'Deterministic Mock Scene Authoring Adapter',
      displayName: 'Deterministic Mock (Non-Premium / Offline)',
      providerType: 'mock',
      isSubscriptionRequired: false,
      supportedModels: [
        {
          id: 'mock-creative-coder-v1',
          name: 'Mock Creative Coder V1 (Default)',
          contextTokens: 32768,
          requiresSubscription: false,
          promptCostPer1k: 0.0,
          completionCostPer1k: 0.0,
        },
        {
          id: 'mock-fast-wireframe-v1',
          name: 'Mock Fast Wireframe V1',
          contextTokens: 16384,
          requiresSubscription: false,
          promptCostPer1k: 0.0,
          completionCostPer1k: 0.0,
        },
      ],
      defaultModel: 'mock-creative-coder-v1',
      capabilities: [
        'custom-html-v1',
        'source-only',
        'cancellation',
        'token-budgeting',
        'cost-estimation',
        'deterministic-seed',
        'vietnamese-nfc',
        'asset-binding',
        'parameter-schema-generation',
      ],
      ...options,
    });
  }

  /**
   * Synthesize scene bundle source files from brief deterministically.
   *
   * @param {Record<string, unknown>} request
   * @param {{
   *   signal?: AbortSignal;
   *   tenantId: string;
   *   jobId: string;
   *   logger?: Record<string, unknown>;
   * }} context
   */
  async generateSceneSource(request, context) {
    const startTime = Date.now();

    // 1. Check for immediate cancellation
    if (context?.signal?.aborted) {
      throw new CustomRuntimeError(
        'AUTHORING_CANCELED',
        'Authoring job was canceled prior to code generation',
        false,
        { reason: context.signal.reason },
      );
    }

    const brief = String(request.brief || '').normalize('NFC');
    const briefHash = String(request.brief_hash || crypto.createHash('sha256').update(brief).digest('hex'));
    const seed = request.seed !== undefined ? String(request.seed) : briefHash.slice(0, 16);
    const rng = createDeterministicRandom(seed);

    const model = String(request.model || this.defaultModel);
    const target = /** @type {Record<string, any>} */ (request.target || {});
    const width = Number(target.width) || 1920;
    const height = Number(target.height) || 1080;
    const fps = Number(target.fps) || 30;
    const durationSeconds = Number(target.duration_seconds) || 5;
    const approvedAssetIds = Array.isArray(request.approved_asset_ids) ? request.approved_asset_ids : [];

    // Optional simulated delay to test cancellation / timeouts in tests
    const reqOptions = /** @type {Record<string, any> | undefined} */ (request.options);
    const simulatedDelayMs = Number(reqOptions?.simulatedDelayMs) || 0;
    if (simulatedDelayMs > 0) {
      const stepMs = Math.min(25, simulatedDelayMs);
      let elapsed = 0;
      while (elapsed < simulatedDelayMs) {
        if (context?.signal?.aborted) {
          throw new CustomRuntimeError(
            'AUTHORING_CANCELED',
            'Authoring job canceled during code synthesis simulation',
            false,
            { reason: context.signal.reason },
          );
        }
        await new Promise((r) => setTimeout(r, stepMs));
        elapsed += stepMs;
      }
    }

    // Check cancellation after delay
    if (context?.signal?.aborted) {
      throw new CustomRuntimeError(
        'AUTHORING_CANCELED',
        'Authoring job was canceled during execution',
        false,
        { reason: context.signal.reason },
      );
    }

    // 2. Synthesize scene parameters based on brief keywords and determinism
    const sceneTheme = /particle|stars|ambient/i.test(brief)
      ? 'particles'
      : /counter|metric|stat/i.test(brief)
      ? 'counter'
      : 'typography';

    // Derive primary theme colors deterministically
    const hue = Math.floor(rng() * 360);
    const primaryColor = `hsl(${hue}, 85%, 60%)`;
    const bgColor = '#0f172a'; // Modern slate dark theme

    // Extract or formulate headline preserving Vietnamese NFC
    let headline = 'Khám Phá Sáng Tạo';
    if (brief.includes('"')) {
      const quoted = brief.match(/"([^"]+)"/);
      if (quoted?.[1]) headline = quoted[1].normalize('NFC');
    } else if (brief.length > 5) {
      // Pick first sentence / phrase up to 40 chars
      const parts = brief.split(/[.\n,]/);
      const firstSentence = (parts[0] || '').trim();
      if (firstSentence) headline = firstSentence.slice(0, 50).normalize('NFC');
    }

    // 3. Asset binding
    let assetBindingSnippet = '// No external assets bound\n';
    let assetMarkup = '';
    if (approvedAssetIds.length > 0) {
      const firstAssetId = approvedAssetIds[0];
      assetBindingSnippet = `// Bound approved asset: ${firstAssetId}\nconst boundAssetId = "${firstAssetId}";\n`;
      assetMarkup = `  <div id="asset-slot" data-asset-id="${firstAssetId}"></div>\n`;
    }

    // 4. Generate index.html
    const indexHtml = `<!DOCTYPE html>
<html lang="${String(request.locale || 'vi-VN')}">
<head>
  <meta charset="utf-8">
  <title>Creativanta Custom Scene</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <div id="scene-container">
    <canvas id="scene-canvas" width="${width}" height="${height}"></canvas>
${assetMarkup}  </div>
  <script type="module" src="scene.mjs"></script>
</body>
</html>
`;

    // 5. Generate scene.mjs
    const sceneMjs = `/**
 * Custom Scene Animation Module - Generated by Creativanta AI Authoring Adapter
 * Seed: ${seed} | Model: ${model}
 */

${assetBindingSnippet}
export const SCENE_CONFIG = Object.freeze({
  width: ${width},
  height: ${height},
  fps: ${fps},
  durationSeconds: ${durationSeconds},
  totalFrames: ${fps * durationSeconds},
});

/**
 * Standard cubic ease-out calculation.
 * @param {number} t Normalized progress 0..1
 * @returns {number}
 */
export function easeOutCubic(t) {
  return 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 3);
}

/**
 * Procedural frame rendering function.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} frame Current frame index
 * @param {Record<string, unknown>} params Scene parameters
 */
export function renderFrame(ctx, frame, params = {}) {
  const { width, height, totalFrames } = SCENE_CONFIG;
  const progress = Math.max(0, Math.min(1, frame / (totalFrames || 1)));
  const eased = easeOutCubic(progress);

  // Background clear
  ctx.fillStyle = String(params.background_color || "${bgColor}");
  ctx.fillRect(0, 0, width, height);

  // Decorative procedural graphic element
  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.strokeStyle = String(params.accent_color || "${primaryColor}");
  ctx.lineWidth = 4;
  ctx.beginPath();
  const radius = 120 + Math.sin(progress * Math.PI * 2) * 20;
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.stroke();

  // Headline typography with Vietnamese NFC diacritics
  const text = String(params.headline || "${headline}");
  ctx.font = "bold 56px 'Inter', -apple-system, sans-serif";
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.globalAlpha = eased;
  ctx.fillText(text, 0, 0);

  ctx.restore();
}

// Auto-run if running inside browser sandbox
if (typeof window !== "undefined" && typeof document !== "undefined") {
  const canvas = document.getElementById("scene-canvas");
  if (canvas instanceof HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (ctx) {
      renderFrame(ctx, 0);
    }
  }
}
`;

    // 6. Generate styles.css
    const stylesCss = `/* Custom Scene Stylesheet - Creativanta Video Engine */
* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body, html {
  width: 100%;
  height: 100%;
  overflow: hidden;
  background-color: ${bgColor};
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}

#scene-container {
  position: relative;
  width: ${width}px;
  height: ${height}px;
  margin: auto;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}

#scene-canvas {
  width: 100%;
  height: 100%;
  display: block;
}
`;

    // 7. Generate parameter schema
    const parameterSchema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        headline: {
          type: 'string',
          title: 'Headline Text',
          description: 'Main display title supporting Vietnamese NFC diacritics',
          default: headline,
          maxLength: 120,
        },
        background_color: {
          type: 'string',
          title: 'Background Color',
          default: bgColor,
          pattern: '^#[0-9a-fA-F]{6}$',
        },
        accent_color: {
          type: 'string',
          title: 'Accent Highlight Color',
          default: primaryColor,
        },
        animation_speed: {
          type: 'number',
          title: 'Animation Speed Multiplier',
          default: 1.0,
          minimum: 0.25,
          maximum: 4.0,
        },
      },
      required: ['headline'],
      additionalProperties: false,
    };

    // 8. Generate manifest.json
    const manifestJson = JSON.stringify(
      {
        manifest_version: '1.0.0',
        bundle_type: 'custom-html-v1',
        title: headline,
        dimensions: { width, height },
        fps,
        duration_seconds: durationSeconds,
        entrypoint: 'index.html',
        declared_capabilities: ['canvas-2d', 'procedural-animation'],
        parameter_schema: parameterSchema,
      },
      null,
      2,
    );

    // Bundle files
    const files = [
      { path: 'index.html', content: indexHtml },
      { path: 'scene.mjs', content: sceneMjs },
      { path: 'styles.css', content: stylesCss },
      { path: 'manifest.json', content: manifestJson },
    ];

    // Calculate prompt and completion tokens accurately
    const promptTokens = estimatePromptTokens(brief) + 250;
    const totalSourceBytes = files.reduce((acc, f) => acc + Buffer.byteLength(f.content, 'utf-8'), 0);
    const completionTokens = Math.max(100, Math.ceil(totalSourceBytes / 4));
    const totalTokens = promptTokens + completionTokens;
    const durationMs = Date.now() - startTime;
    const costUsd = calculateAuthoringCost(model, promptTokens, completionTokens);

    /** @type {'succeeded'} */
    const status = 'succeeded';

    return {
      status,
      files,
      entrypoint: 'index.html',
      parameter_schema: parameterSchema,
      declared_capabilities: ['canvas-2d', 'procedural-animation'],
      metadata: {
        provider: this.id,
        model,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
        duration_ms: durationMs,
        cost_usd: costUsd,
        brief_hash: briefHash,
        seed,
        scene_theme: sceneTheme,
        finish_reason: 'completed',
      },
    };
  }
}
