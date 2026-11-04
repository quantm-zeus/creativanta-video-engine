/**
 * Content Rights & Licensing Controls Types for Creativanta Video Engine.
 * Canonical specification: docs/SECURITY.md (Line 59), docs/IMPLEMENTATION_PLAN.md (P0-03, P5-05).
 */

export type AssetRightsBasis = 'owned' | 'licensed' | 'public_domain';
export type ContentRightsCategory = 'font' | 'audio' | 'video' | 'image' | 'svg';
export type RightsStatus = 'active' | 'revoked' | 'expired' | 'under_review';
export type VoiceConsentBasis = 'written_contract' | 'performer_release' | 'synthetic_cleared';

export interface ContentRightsRecord {
  assetId: string;
  category: ContentRightsCategory;
  basis: AssetRightsBasis;
  license: string;
  spdxId?: string;
  attribution: string;
  source: string;
  sha256: string;
  commercialUseAllowed: boolean;
  commercialEmbeddingAllowed: boolean;
  expiresAt?: string | null;
  tenantId?: string;
  status: RightsStatus;
  revocationReason?: string;
  revokedAt?: string;
  revokedBy?: string;
  voiceConsentBasis?: VoiceConsentBasis;
  impersonationProhibited?: boolean;
}

export interface ContentRightsAssertion {
  assetId: string;
  category: ContentRightsCategory;
  basis: AssetRightsBasis;
  license: string;
  spdxId?: string;
  attribution: string;
  source: string;
  sha256: string;
  commercialUseAllowed: boolean;
  commercialEmbeddingAllowed: boolean;
  expiresAt?: string | null;
  tenantId?: string;
  voiceConsentBasis?: VoiceConsentBasis;
  impersonationProhibited?: boolean;
}

export type RightsViolationCode =
  | 'MISSING_RIGHTS_METADATA'
  | 'ASSET_RIGHTS_REVOKED'
  | 'ASSET_RIGHTS_EXPIRED'
  | 'COMMERCIAL_USE_PROHIBITED'
  | 'COMMERCIAL_EMBEDDING_PROHIBITED'
  | 'ANTI_CONTAMINATION_VIOLATION'
  | 'VOICE_CONSENT_MISSING'
  | 'IMPERSONATION_VIOLATION'
  | 'INVALID_SHA256_HASH';

export interface RightsAuditViolation {
  code: RightsViolationCode;
  assetId: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface AntiContaminationRule {
  sourceName: string;
  pattern: RegExp;
  reason: string;
}

export interface RightsAuditReport {
  valid: boolean;
  assetsChecked: number;
  passedCount: number;
  violations: RightsAuditViolation[];
  antiContaminationStatus: 'PASS' | 'FAIL';
  blockedSourcesDetected: string[];
}
