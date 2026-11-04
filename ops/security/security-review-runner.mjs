/**
 * Creativanta Video Engine — P6-04 Unified Security Review Runner
 *
 * Aggregates:
 *   1. Structured Renderer Security Suite (ops/security/renderer-security-suite.mjs)
 *   2. SBOM, License, Codec & Asset Provenance Auditor (ops/security/sbom-license-codec-auditor.mjs)
 *   3. Secrets, IDOR, SSRF, Abuse, Malicious Media & Deletion Suite (ops/security/api-tenant-security-suite.mjs)
 *
 * Enforces P6-04 acceptance gate:
 *   "Structured renderer security suite, SBOM/license/codec/asset review, secrets/IDOR/SSRF/abuse/deletion;
 *    critical findings resolved hoặc beta blocked"
 */

import { RendererSecuritySuite } from './renderer-security-suite.mjs';
import { SbomLicenseCodecAuditor } from './sbom-license-codec-auditor.mjs';
import { ApiTenantSecuritySuite } from './api-tenant-security-suite.mjs';

export const SECURITY_REVIEW_FINDINGS = [
  {
    id: 'SEC-P6-001',
    severity: 'HIGH',
    category: 'secrets_and_log_redaction',
    title: 'Ops RedactedLogger regex missed 77-char API key suffixes and whsec_/URI credentials',
    affectedFiles: ['ops/logging/redacted-logger.mjs', 'ops/test/redacted-logger.test.mjs'],
    rootCause:
      'API_KEY_PREFIX_REGEX in ops/logging/redacted-logger.mjs bounded the suffix after cve_live_ to {16,64} characters with a trailing word boundary (\\b). Real API keys issued by generateApiKeyMaterial() have a 77-character suffix (<12hex>_<64hex>), causing full API keys in free-form log strings to bypass regex redaction. Additionally, whsec_ webhook secrets, PEM private keys, and connection URI passwords lacked dedicated string patterns.',
    remediation:
      'Expanded API_KEY_PREFIX_REGEX to {12,128}, added WEBHOOK_SECRET_REGEX (whsec_), EXTERNAL_SECRET_REGEX (sk-, ghp_, AKIA), PRIVATE_KEY_BLOCK_REGEX, CONNECTION_URI_CREDENTIALS_REGEX, and expanded sensitive object key suffix matching in redactObject().',
    status: 'RESOLVED',
    verifiedByChecks: ['RND-SEC-08', 'API-SEC-01', 'API-SEC-07'],
  },
  {
    id: 'SEC-P6-002',
    severity: 'LOW',
    category: 'multi_tenant_isolation_runbook',
    title: 'Runbook 6 synthetic verification used static statusCode = 404 instead of live TenantRepository probe',
    affectedFiles: ['ops/runbooks/synthetic-runbook-runner.mjs'],
    rootCause:
      'SyntheticRunbookRunner.runRunbook6TenantIsolation() simulated the 404 anti-IDOR outcome with a static variable rather than invoking TenantRepository with an authenticated cross-tenant context.',
    remediation:
      'Updated runRunbook6TenantIsolation() to initialize an in-memory SQLite database with MigrationRunner, TenantConnectionPool, and TenantRepository, create a victim asset, execute a cross-tenant getAsset() probe, verify ResourceNotFoundError (404 NOT_FOUND), and persist attacker tenant suspension.',
    status: 'RESOLVED',
    verifiedByChecks: ['API-SEC-02'],
  },
];

export const EXTERNAL_SECURITY_AND_LEGAL_GATES = [
  {
    gateId: 'EXT-SEC-LEGAL-01',
    owner: 'Legal / Commercial Counsel',
    status: 'PENDING_EXTERNAL_SIGN_OFF',
    description:
      'Commercial H.264/AAC patent pool licensing threshold review (MPEG LA / Via Licensing) vs royalty-free VP9/Opus fallback before public commercial billing.',
  },
  {
    gateId: 'EXT-SEC-OPS-02',
    owner: 'Platform / Infrastructure Security',
    status: 'PENDING_STAGING_HOST_VERIFICATION',
    description:
      'Live staging Docker host verification of kernel seccomp profile (docker/seccomp-renderer.json), --network none / iptables egress drop rules, and KMS/Vault secret rotation.',
  },
];

export class SecurityReviewRunner {
  constructor(options = {}) {
    this.repoRoot = options.repoRoot || process.cwd();
  }

  async runFullReview() {
    const startedAt = Date.now();

    const rendererSuite = new RendererSecuritySuite();
    const sbomAuditor = new SbomLicenseCodecAuditor(this.repoRoot);
    const apiTenantSuite = new ApiTenantSecuritySuite();

    const [rendererResult, sbomResult, apiTenantResult] = await Promise.all([
      rendererSuite.runAll(),
      sbomAuditor.runAll(),
      apiTenantSuite.runAll(),
    ]);

    const suites = [rendererResult, sbomResult, apiTenantResult];
    const totalChecks = suites.reduce((acc, s) => acc + s.totalChecks, 0);
    const passedChecks = suites.reduce((acc, s) => acc + s.passedChecks, 0);
    const failedChecks = suites.reduce((acc, s) => acc + s.failedChecks, 0);

    const openCriticalFindings = SECURITY_REVIEW_FINDINGS.filter(
      (f) => f.severity === 'CRITICAL' && f.status !== 'RESOLVED'
    ).length;
    const openHighFindings = SECURITY_REVIEW_FINDINGS.filter(
      (f) => f.severity === 'HIGH' && f.status !== 'RESOLVED'
    ).length;

    const allPassed =
      failedChecks === 0 && openCriticalFindings === 0 && openHighFindings === 0;

    return {
      taskId: 'P6-04',
      role: 'Security reviewer',
      phase: 'P6',
      evaluatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      overallStatus: allPassed ? 'PASS' : 'BETA_BLOCKED',
      betaReleaseGateDecision: allPassed
        ? 'APPROVED_FOR_PRIVATE_BETA_PENDING_EXTERNAL_GATES'
        : 'BETA_BLOCKED',
      summary: {
        totalSuites: suites.length,
        passedSuites: suites.filter((s) => s.passed).length,
        totalChecks,
        passedChecks,
        failedChecks,
        findingsTotal: SECURITY_REVIEW_FINDINGS.length,
        findingsResolved: SECURITY_REVIEW_FINDINGS.filter((f) => f.status === 'RESOLVED').length,
        openCriticalFindings,
        openHighFindings,
      },
      findings: SECURITY_REVIEW_FINDINGS,
      externalGates: EXTERNAL_SECURITY_AND_LEGAL_GATES,
      suites: {
        rendererSecurity: rendererResult,
        sbomLicenseCodec: {
          suite: sbomResult.suite,
          passed: sbomResult.passed,
          totalChecks: sbomResult.totalChecks,
          passedChecks: sbomResult.passedChecks,
          failedChecks: sbomResult.failedChecks,
          durationMs: sbomResult.durationMs,
          checks: sbomResult.checks,
        },
        apiTenantSecurity: apiTenantResult,
      },
      sbomAndProvenanceArtifacts: sbomResult.artifacts,
    };
  }
}
