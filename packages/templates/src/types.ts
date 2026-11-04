/**
 * Curated Template Types, License Provenance, and Revision Management.
 * Canonical specification: docs/SCENE-SPEC.md, docs/API.md, docs/TESTING.md.
 */

import { CompositionSpec } from '@creativanta/contracts';
import { BrandTokens } from '@creativanta/sdk';

export type CuratedTemplateFamilyId = 'retail_promo' | 'narrated_explainer' | 'captioned_story';

export interface AssetLicenseEvidence {
  asset_id: string;
  category: 'font' | 'audio' | 'video' | 'image' | 'svg';
  basis: 'owned' | 'licensed' | 'public_domain';
  license: string;
  spdx_id?: string;
  attribution: string;
  source: string;
  sha256: string;
  commercial_use_allowed: boolean;
  commercial_embedding_allowed: boolean;
}

export interface TemplateRevisionInfo {
  revision: number;
  base_revision?: number;
  change_note: string;
  composition_spec: CompositionSpec;
}

export interface CuratedTemplate {
  id: string;
  family: CuratedTemplateFamilyId;
  revision: number;
  name: string;
  description: string;
  variables_schema: Record<string, unknown>;
  defaults: Record<string, unknown>;
  supported_locales: string[];
  required_capabilities: string[];
  composition_spec: CompositionSpec;
  revisions?: TemplateRevisionInfo[];
  license_evidence: AssetLicenseEvidence[];
  brand_tokens_defaults?: BrandTokens;
}

export interface CuratedTemplateFamily {
  family_id: CuratedTemplateFamilyId;
  name: string;
  description: string;
  revisions: CuratedTemplate[];
  latest: CuratedTemplate;
}

export interface TemplateInstantiationOptions {
  variables?: Record<string, unknown>;
  locale?: string;
  brandTokens?: BrandTokens;
  baseRevision?: number;
  checkOverflow?: boolean;
}

export interface TemplateRegenerationOptions {
  edits: Record<string, unknown>;
  brandTokens?: BrandTokens;
  changeNote?: string;
  checkOverflow?: boolean;
}
