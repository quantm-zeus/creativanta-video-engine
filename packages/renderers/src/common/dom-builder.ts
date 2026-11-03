/**
 * Deterministic DOM & CSS Generator for Chromium baseline and HyperFrames adapter.
 * Canonical specification: docs/SCENE-SPEC.md, docs/SECURITY.md
 */

import {
  CanonicalCompilerManifest,
  FrameEvaluationResult,
  EvaluatedLayerState,
  SceneManifest,
  LayerManifest,
  TextLayerContent,
  ShapeLayerContent,
  ImageLayerContent,
  VideoLayerContent,
  SvgLayerContent,
} from '@creativanta/contracts';

export interface DomBuilderOptions {
  cspNonce?: string;
  enableHyperFramesDataAttributes?: boolean;
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function buildFontFaces(manifest: CanonicalCompilerManifest): string {
  const fontRules: string[] = [];
  const knownFamilies = new Set<string>();

  for (const font of manifest.fonts) {
    if (knownFamilies.has(`${font.family}-${font.weight}-${font.style}`)) {
      continue;
    }
    knownFamilies.add(`${font.family}-${font.weight}-${font.style}`);
    // Local / data URL font embedding for zero egress
    fontRules.push(`
      @font-face {
        font-family: '${font.family}';
        font-weight: ${font.weight};
        font-style: ${font.style};
        src: local('${font.family}'), local('${font.family} Regular');
        font-display: block;
      }
    `);
  }

  // Ensure default fallback typography if none explicitly supplied
  if (manifest.fonts.length === 0) {
    fontRules.push(`
      @font-face {
        font-family: 'Inter';
        font-weight: 400;
        font-style: normal;
        src: local('Inter'), local('Noto Sans');
        font-display: block;
      }
    `);
  }

  return fontRules.join('\n');
}

export function buildLayerHtml(
  layer: EvaluatedLayerState,
  options: DomBuilderOptions = {}
): string {
  const { box, transform, opacity, z_index, content, type } = layer;
  const isHyperFrames = Boolean(options.enableHyperFramesDataAttributes);

  const styleParts = [
    `position: absolute`,
    `left: ${box.x}px`,
    `top: ${box.y}px`,
    `width: ${box.width}px`,
    `height: ${box.height}px`,
    `z-index: ${z_index}`,
    `opacity: ${opacity.toFixed(4)}`,
    `transform: translate(${transform.translate_x}px, ${transform.translate_y}px) scale(${transform.scale_x}, ${transform.scale_y}) rotate(${transform.rotate_deg}deg)`,
    `transform-origin: ${(transform.origin_x * 100).toFixed(1)}% ${(transform.origin_y * 100).toFixed(1)}%`,
    `box-sizing: border-box`,
    `overflow: hidden`,
  ];

  let innerHtml = '';
  let extraAttrs = '';

  if (isHyperFrames) {
    extraAttrs += ` data-layer-id="${escapeHtml(layer.layer_id)}"`;
    extraAttrs += ` data-layer-type="${escapeHtml(layer.type)}"`;
    extraAttrs += ` data-z-index="${z_index}"`;
    extraAttrs += ` data-opacity="${opacity.toFixed(4)}"`;
  }

  switch (type) {
    case 'text': {
      const textContent = content as TextLayerContent;
      const textStyle = [
        `font-family: 'Inter', 'Noto Sans', sans-serif`,
        `font-size: ${textContent.font_size}px`,
        `font-weight: ${textContent.weight ?? 400}`,
        `color: ${textContent.color}`,
        `line-height: ${textContent.line_height ?? 1.2}`,
        `text-align: ${textContent.align ?? 'left'}`,
        `white-space: pre-wrap`,
        `word-break: break-word`,
        `margin: 0`,
        `padding: 0`,
        `display: flex`,
        `align-items: center`,
        `width: 100%`,
        `height: 100%`,
      ];
      innerHtml = `<div class="cve-text-inner" style="${textStyle.join('; ')}">${escapeHtml(textContent.text)}</div>`;
      break;
    }
    case 'shape': {
      const shapeContent = content as ShapeLayerContent;
      styleParts.push(`background-color: ${shapeContent.fill}`);
      if (shapeContent.radius) {
        styleParts.push(`border-radius: ${shapeContent.radius}px`);
      }
      if (shapeContent.stroke && shapeContent.stroke_width) {
        styleParts.push(`border: ${shapeContent.stroke_width}px solid ${shapeContent.stroke}`);
      }
      break;
    }
    case 'image': {
      const imgContent = content as ImageLayerContent;
      innerHtml = `<img src="${escapeHtml(imgContent.asset_id)}" alt="${escapeHtml(imgContent.alt ?? '')}" style="width: 100%; height: 100%; object-fit: ${imgContent.fit ?? 'cover'}; display: block;" />`;
      break;
    }
    case 'video': {
      const vidContent = content as VideoLayerContent;
      innerHtml = `<div class="cve-video-placeholder" data-asset="${escapeHtml(vidContent.asset_id)}" style="width: 100%; height: 100%; background: #000;"></div>`;
      break;
    }
    case 'svg': {
      const svgContent = content as SvgLayerContent;
      innerHtml = `<div class="cve-svg-container" style="width: 100%; height: 100%;" data-asset="${escapeHtml(svgContent.asset_id)}"></div>`;
      break;
    }
  }

  return `<div class="cve-layer cve-layer-${escapeHtml(layer.type)}" id="layer-${escapeHtml(layer.layer_id)}" style="${styleParts.join('; ')}"${extraAttrs}>${innerHtml}</div>`;
}

export function buildFrameHtml(
  manifest: CanonicalCompilerManifest,
  frameEval: FrameEvaluationResult,
  options: DomBuilderOptions = {}
): string {
  const width = manifest.canvas.width;
  const height = manifest.canvas.height;
  const canvasBg = manifest.canvas.background;
  const scene = frameEval.scene;
  const isHyperFrames = Boolean(options.enableHyperFramesDataAttributes);

  const fontCss = buildFontFaces(manifest);
  const layersHtml = frameEval.layers
    .map((l: EvaluatedLayerState) => buildLayerHtml(l, options))
    .join('\n      ');

  // Vietnamese typography and zero-egress CSS rules
  const baseCss = `
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    html, body {
      width: ${width}px;
      height: ${height}px;
      overflow: hidden;
      background: ${canvasBg};
      font-family: 'Inter', 'Noto Sans', 'Roboto', sans-serif;
      text-rendering: geometricPrecision;
      -webkit-font-smoothing: antialiased;
    }
    #cve-root {
      position: relative;
      width: ${width}px;
      height: ${height}px;
      overflow: hidden;
      background: ${scene.background || canvasBg};
      opacity: ${scene.scene_alpha.toFixed(4)};
    }
    .cve-safe-zone {
      position: absolute;
      left: 48px;
      top: 48px;
      right: 48px;
      bottom: 48px;
      pointer-events: none;
    }
    ${fontCss}
  `;

  // Zero-egress CSP: no external connect, no external fonts/images, strict sandbox
  const cspHeader = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data: local:; img-src data:; media-src data:; connect-src 'none'; object-src 'none';">`;

  let sceneAttrs = `class="cve-scene" id="scene-${escapeHtml(scene.id)}"`;
  if (isHyperFrames) {
    sceneAttrs += ` data-scene-id="${escapeHtml(scene.id)}" data-local-frame="${scene.local_frame}" data-scene-alpha="${scene.scene_alpha.toFixed(4)}"`;
  }

  return `<!DOCTYPE html>
<html lang="${manifest.locale}">
<head>
  <meta charset="utf-8">
  ${cspHeader}
  <meta name="viewport" content="width=${width}, height=${height}, initial-scale=1.0">
  <title>Frame ${frameEval.frame_index}</title>
  <style>
    ${baseCss}
  </style>
</head>
<body>
  <div id="cve-root" ${sceneAttrs}>
    <div class="cve-canvas-layers">
      ${layersHtml}
    </div>
  </div>
</body>
</html>`;
}

export function buildHyperFramesTemplateManifest(
  manifest: CanonicalCompilerManifest
): string {
  // Generates HyperFrames declarative timeline HTML structure
  const width = manifest.canvas.width;
  const height = manifest.canvas.height;
  const fps = `${manifest.fps.num}/${manifest.fps.den}`;

  const sceneBlocks = manifest.scenes.map((scene: SceneManifest) => {
    const layerBlocks = scene.layers.map((layer: LayerManifest) => {
      return `    <div class="hf-layer"
         data-id="${escapeHtml(layer.id)}"
         data-type="${escapeHtml(layer.type)}"
         data-in="${layer.local_start_frame}"
         data-duration="${layer.local_duration_frames}"
         data-z="${layer.z_index}"
         data-box="${layer.box.x},${layer.box.y},${layer.box.width},${layer.box.height}">
    </div>`;
    }).join('\n');

    return `  <section class="hf-scene"
           data-id="${escapeHtml(scene.id)}"
           data-in="${scene.start_frame}"
           data-duration="${scene.duration_frames}"
           data-engine="${escapeHtml(scene.engine)}"
           data-transition="${escapeHtml(scene.transition_out.type)}">
${layerBlocks}
  </section>`;
  }).join('\n');

  return `<!-- HyperFrames Adapter Spike Template -->
<div id="hyperframes-composition"
     data-schema="1.0"
     data-width="${width}"
     data-height="${height}"
     data-fps="${fps}"
     data-duration-frames="${manifest.duration_frames}"
     data-locale="${manifest.locale}">
${sceneBlocks}
</div>`;
}
