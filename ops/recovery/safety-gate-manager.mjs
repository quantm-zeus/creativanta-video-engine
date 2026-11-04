/**
 * Creativanta Video Engine - Post-Restore Safety Gate & Feature Lock Manager
 * Canonical specifications:
 *   - docs/IMPLEMENTATION_PLAN.md (P6-02: "custom/import stay off sau restore đến revalidation")
 *   - docs/DEPLOYMENT.md (line 118: "Feature flag custom/import off sau restore cho đến policy revalidation")
 *   - docs/SECURITY.md ("Ranh giới an ninh", lines 10-14 & "Incident", line 73)
 *   - migrations/ROLLBACK_AND_RECOVERY.md ("Bước 1 & Bước 6")
 */

export class PostRestoreSafetyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PostRestoreSafetyError';
    this.code = code;
  }
}

export const SAFETY_STATES = Object.freeze({
  NORMAL: 'NORMAL',
  RESTORED_PENDING_REVALIDATION: 'RESTORED_PENDING_REVALIDATION',
  REVALIDATED_ACTIVE: 'REVALIDATED_ACTIVE',
});

/**
 * Manages post-restore safety locks, enforcing that custom code execution,
 * remote asset import, and outbound webhook delivery stay strictly disabled
 * until an explicit authorized operator revalidation process is completed.
 */
export class PostRestoreSafetyGate {
  /**
   * @param {object} [options]
   * @param {string} [options.initialState] - Initial safety state
   */
  constructor(options = {}) {
    this.state = options.initialState ?? SAFETY_STATES.RESTORED_PENDING_REVALIDATION;
    this.customCodeEnabled = false;
    this.remoteImportEnabled = false;
    this.outboundWebhooksEnabled = false;
    this.revalidationAudit = null;
  }

  /**
   * Enforces the post-restore lockdown invariant.
   */
  lockPostRestore() {
    this.state = SAFETY_STATES.RESTORED_PENDING_REVALIDATION;
    this.customCodeEnabled = false;
    this.remoteImportEnabled = false;
    this.outboundWebhooksEnabled = false;
  }

  /**
   * Checks whether custom code execution is allowed. Throws PostRestoreSafetyError if locked.
   */
  assertCustomCodeAllowed() {
    if (this.state === SAFETY_STATES.RESTORED_PENDING_REVALIDATION) {
      throw new PostRestoreSafetyError(
        'FEATURE_LOCKED_PENDING_REVALIDATION',
        'Custom scene code execution is strictly disabled following restore until explicit security revalidation.'
      );
    }
    if (!this.customCodeEnabled) {
      throw new PostRestoreSafetyError(
        'FEATURE_DISABLED',
        'Custom scene code execution is disabled by configuration policy.'
      );
    }
    return true;
  }

  /**
   * Checks whether remote asset import is allowed. Throws PostRestoreSafetyError if locked.
   */
  assertRemoteImportAllowed() {
    if (this.state === SAFETY_STATES.RESTORED_PENDING_REVALIDATION) {
      throw new PostRestoreSafetyError(
        'FEATURE_LOCKED_PENDING_REVALIDATION',
        'Remote asset URL import is strictly disabled following restore until explicit security revalidation.'
      );
    }
    if (!this.remoteImportEnabled) {
      throw new PostRestoreSafetyError(
        'FEATURE_DISABLED',
        'Remote asset URL import is disabled by configuration policy.'
      );
    }
    return true;
  }

  /**
   * Checks whether outbound webhook delivery is allowed. Throws PostRestoreSafetyError if locked.
   */
  assertOutboundWebhooksAllowed() {
    if (this.state === SAFETY_STATES.RESTORED_PENDING_REVALIDATION) {
      throw new PostRestoreSafetyError(
        'FEATURE_LOCKED_PENDING_REVALIDATION',
        'Outbound webhook delivery egress is strictly disabled following restore until explicit security revalidation.'
      );
    }
    if (!this.outboundWebhooksEnabled) {
      throw new PostRestoreSafetyError(
        'FEATURE_DISABLED',
        'Outbound webhook delivery is disabled by configuration policy.'
      );
    }
    return true;
  }

  /**
   * Executes the formal operator security revalidation procedure.
   *
   * @param {object} params
   * @param {string} params.operator - Operator username or role ID
   * @param {string} params.ticket - Change ticket or incident review identifier
   * @param {object} params.checks - Pre-revalidation verification results
   * @param {boolean} params.checks.foreignKeysPassed - Foreign key integrity status
   * @param {boolean} params.checks.objectConsistencyPassed - Object storage reconciliation status
   * @param {boolean} params.checks.tenantIsolationPassed - Multi-tenant RLS isolation status
   * @param {boolean} [params.checks.catalogIntegrityPassed=true] - System catalog immutability status
   * @param {object} [params.allowEnableFeatures] - Requested feature toggles post-revalidation
   * @param {boolean} [params.allowEnableFeatures.customCode=false]
   * @param {boolean} [params.allowEnableFeatures.remoteImport=true]
   * @param {boolean} [params.allowEnableFeatures.outboundWebhooks=true]
   * @returns {object} Revalidation sign-off record
   */
  revalidate(params) {
    if (!params.operator || typeof params.operator !== 'string') {
      throw new PostRestoreSafetyError(
        'INVALID_REVALIDATION_OPERATOR',
        'Revalidation requires a valid authorized operator identifier.'
      );
    }
    if (!params.ticket || typeof params.ticket !== 'string') {
      throw new PostRestoreSafetyError(
        'INVALID_REVALIDATION_TICKET',
        'Revalidation requires an associated change/incident ticket identifier.'
      );
    }

    const { foreignKeysPassed, objectConsistencyPassed, tenantIsolationPassed, catalogIntegrityPassed = true } =
      params.checks || {};

    if (!foreignKeysPassed || !objectConsistencyPassed || !tenantIsolationPassed || !catalogIntegrityPassed) {
      throw new PostRestoreSafetyError(
        'REVALIDATION_CHECKS_FAILED',
        'Post-restore revalidation rejected: all mandatory integrity, consistency, and isolation checks must PASS.'
      );
    }

    const requestedFeatures = params.allowEnableFeatures || {};
    this.state = SAFETY_STATES.REVALIDATED_ACTIVE;
    this.customCodeEnabled = Boolean(requestedFeatures.customCode);
    this.remoteImportEnabled = Boolean(requestedFeatures.remoteImport ?? true);
    this.outboundWebhooksEnabled = Boolean(requestedFeatures.outboundWebhooks ?? true);

    const revalidatedAt = new Date().toISOString();
    this.revalidationAudit = {
      revalidatedAt,
      operator: params.operator,
      ticket: params.ticket,
      state: this.state,
      checks: {
        foreignKeysPassed: true,
        objectConsistencyPassed: true,
        tenantIsolationPassed: true,
        catalogIntegrityPassed: true,
      },
      activeFlags: {
        customCodeEnabled: this.customCodeEnabled,
        remoteImportEnabled: this.remoteImportEnabled,
        outboundWebhooksEnabled: this.outboundWebhooksEnabled,
      },
    };

    return this.revalidationAudit;
  }
}
