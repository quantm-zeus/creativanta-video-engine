/**
 * Beta Sample Pack Generator for Creativanta Video Engine.
 * Exports fully localized, production-ready beta samples for the 3 curated families
 * with verified commercial rights, subtitle sidecars (SRT & WebVTT), and Vietnamese typography.
 * Canonical specification: docs/IMPLEMENTATION_PLAN.md (P5-05), docs/SCENE-SPEC.md, docs/TESTING.md.
 */

import { CompositionSpec } from '@creativanta/contracts';
import {
  exportSubtitleSidecars,
  calculateSubtitleLayout,
  ContentRightsRegistry,
  RightsAuditReport,
} from '@creativanta/sdk';
import { CURATED_TEMPLATE_FAMILIES } from './catalog.js';
import { CuratedTemplateFamilyId } from './types.js';

export interface BetaSampleItem {
  id: string;
  name: string;
  family: CuratedTemplateFamilyId;
  aspectRatio: '9:16' | '16:9';
  durationSeconds: number;
  durationFrames: number;
  locale: string;
  spec: CompositionSpec;
  sidecars?: {
    srt: string;
    vtt: string;
    cuesCount: number;
    durationMs: number;
  };
  rightsAudit: RightsAuditReport;
  subtitleLayoutResults?: Array<{
    cueId: string;
    linesCount: number;
    fitsMaxLines: boolean;
    fitsSafeMargin: boolean;
    overflowDetected: boolean;
  }>;
}

export interface BetaSamplePack {
  generatedAt: string;
  samples: BetaSampleItem[];
  overallRightsAudit: {
    valid: boolean;
    totalAssetsChecked: number;
    violationsCount: number;
  };
}

/**
 * Builds and validates the 3 official Beta Samples matching P5-05 acceptance.
 */
export function generateBetaSamples(): BetaSamplePack {
  const registry = new ContentRightsRegistry();
  const samples: BetaSampleItem[] = [];

  // Sample 1: Retail Promo (9:16 vertical)
  const promoFamily = CURATED_TEMPLATE_FAMILIES.retail_promo;
  if (!promoFamily) throw new Error('retail_promo family not found in catalog');
  const promoSpec = JSON.parse(JSON.stringify(promoFamily.latest.composition_spec)) as CompositionSpec;

  // Add promo promotional subtitle track (dual workflow: burn-in + sidecar)
  promoSpec.subtitles = [
    {
      id: 'sub_vi_promo',
      locale: 'vi-VN',
      burn_in: true,
      style: {
        font_id: 'font_promo_bold',
        font_size: 32,
        color: '#FFFFFF',
        background: '#1A1A2ECC',
        align: 'center',
        max_lines: 2,
        safe_margin_px: 48,
      },
      cues: [
        {
          id: 'cue_promo_01',
          start_frame: 0,
          end_frame: 150,
          text: 'Khuyến mãi đặc biệt hôm nay!',
        },
        {
          id: 'cue_promo_02',
          start_frame: 150,
          end_frame: 300,
          text: 'Chỉ từ 149.000 ₫ — Giảm tới 70%!',
        },
        {
          id: 'cue_promo_03',
          start_frame: 300,
          end_frame: 450,
          text: 'Chớp cơ hội ngay hôm nay!',
        },
      ],
    },
  ];

  const promoRightsAudit = registry.auditComposition(promoSpec);
  const promoSidecars = exportSubtitleSidecars(promoSpec.subtitles[0]!, promoSpec.fps);
  const promoLayoutResults = promoSpec.subtitles[0]!.cues.map((cue) => {
    const layout = calculateSubtitleLayout(
      cue,
      promoSpec.subtitles[0]!.style!,
      promoSpec.canvas.width,
      promoSpec.canvas.height
    );
    return {
      cueId: cue.id,
      linesCount: layout.lineCount,
      fitsMaxLines: layout.fitsMaxLines,
      fitsSafeMargin: layout.fitsSafeMargin,
      overflowDetected: layout.overflowDetected,
    };
  });

  samples.push({
    id: 'beta_sample_retail_promo_v1',
    name: 'Khuyến Mãi Mùa Hè — Flash Sale Tai Nghe Không Dây',
    family: 'retail_promo',
    aspectRatio: '9:16',
    durationSeconds: 15,
    durationFrames: 450,
    locale: 'vi-VN',
    spec: promoSpec,
    sidecars: {
      srt: promoSidecars.srt,
      vtt: promoSidecars.vtt,
      cuesCount: promoSidecars.cuesCount,
      durationMs: promoSidecars.durationMs,
    },
    rightsAudit: promoRightsAudit,
    subtitleLayoutResults: promoLayoutResults,
  });

  // Sample 2: Narrated Explainer (16:9 horizontal)
  const explainerFamily = CURATED_TEMPLATE_FAMILIES.narrated_explainer;
  if (!explainerFamily) throw new Error('narrated_explainer family not found in catalog');
  const explainerSpec = JSON.parse(JSON.stringify(explainerFamily.latest.composition_spec)) as CompositionSpec;
  const explainerRightsAudit = registry.auditComposition(explainerSpec);
  const explainerSidecars = exportSubtitleSidecars(explainerSpec.subtitles[0]!, explainerSpec.fps);
  const explainerLayoutResults = explainerSpec.subtitles[0]!.cues.map((cue) => {
    const layout = calculateSubtitleLayout(
      cue,
      explainerSpec.subtitles[0]!.style!,
      explainerSpec.canvas.width,
      explainerSpec.canvas.height
    );
    return {
      cueId: cue.id,
      linesCount: layout.lineCount,
      fitsMaxLines: layout.fitsMaxLines,
      fitsSafeMargin: layout.fitsSafeMargin,
      overflowDetected: layout.overflowDetected,
    };
  });

  samples.push({
    id: 'beta_sample_narrated_explainer_v1',
    name: 'Giải Thích Công Nghệ — Nền Tảng Video Engine Tự Động',
    family: 'narrated_explainer',
    aspectRatio: '16:9',
    durationSeconds: 30,
    durationFrames: 900,
    locale: 'vi-VN',
    spec: explainerSpec,
    sidecars: {
      srt: explainerSidecars.srt,
      vtt: explainerSidecars.vtt,
      cuesCount: explainerSidecars.cuesCount,
      durationMs: explainerSidecars.durationMs,
    },
    rightsAudit: explainerRightsAudit,
    subtitleLayoutResults: explainerLayoutResults,
  });

  // Sample 3: Captioned Story (9:16 vertical)
  const storyFamily = CURATED_TEMPLATE_FAMILIES.captioned_story;
  if (!storyFamily) throw new Error('captioned_story family not found in catalog');
  const storySpec = JSON.parse(JSON.stringify(storyFamily.latest.composition_spec)) as CompositionSpec;
  const storyRightsAudit = registry.auditComposition(storySpec);
  const storySidecars = exportSubtitleSidecars(storySpec.subtitles[0]!, storySpec.fps);
  const storyLayoutResults = storySpec.subtitles[0]!.cues.map((cue) => {
    const layout = calculateSubtitleLayout(
      cue,
      storySpec.subtitles[0]!.style!,
      storySpec.canvas.width,
      storySpec.canvas.height
    );
    return {
      cueId: cue.id,
      linesCount: layout.lineCount,
      fitsMaxLines: layout.fitsMaxLines,
      fitsSafeMargin: layout.fitsSafeMargin,
      overflowDetected: layout.overflowDetected,
    };
  });

  samples.push({
    id: 'beta_sample_captioned_story_v1',
    name: 'Hương Vị Di Sản — Phóng Sự Cà Phê Đắk Lắk 2026',
    family: 'captioned_story',
    aspectRatio: '9:16',
    durationSeconds: 45,
    durationFrames: 1350,
    locale: 'vi-VN',
    spec: storySpec,
    sidecars: {
      srt: storySidecars.srt,
      vtt: storySidecars.vtt,
      cuesCount: storySidecars.cuesCount,
      durationMs: storySidecars.durationMs,
    },
    rightsAudit: storyRightsAudit,
    subtitleLayoutResults: storyLayoutResults,
  });

  let totalAssetsChecked = 0;
  let totalViolations = 0;
  for (const s of samples) {
    totalAssetsChecked += s.rightsAudit.assetsChecked;
    totalViolations += s.rightsAudit.violations.length;
  }

  return {
    generatedAt: new Date().toISOString(),
    samples,
    overallRightsAudit: {
      valid: totalViolations === 0,
      totalAssetsChecked,
      violationsCount: totalViolations,
    },
  };
}
