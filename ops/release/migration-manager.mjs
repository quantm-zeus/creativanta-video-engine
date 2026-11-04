/**
 * Creativanta Video Engine — Migration Manager & Expand/Contract Verifier
 * Canonical specifications:
 *   - docs/IMPLEMENTATION_PLAN.md (Task P6-05: "immutable release/migration/rollback artifacts")
 *   - docs/DEPLOYMENT.md ("Storage, backup và release", lines 116-120: "Expand/contract migrations, API N/N-1 during rollout")
 *   - docs/ARCHITECTURE.md ("State management & PostgreSQL RLS")
 *   - migrations/ROLLBACK_AND_RECOVERY.md ("Kiến trúc Di trú & Nguyên tắc Expand / Contract")
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const EXPAND_CONTRACT_PHASES = Object.freeze({
  EXPAND: {
    phase: 'expand',
    description: 'Additive schema modifications (new tables, nullable columns, DEFAULT values, CONCURRENTLY indexes). Fully backward-compatible with API version N-1.',
    rules: [
      'NO dropping columns or tables',
      'NO renaming columns or tables',
      'NO adding NOT NULL without DEFAULT',
      'NO reducing column size/type precision',
      'All new columns must be nullable or possess deterministic DEFAULT',
    ],
  },
  DEPLOY_AND_DRAIN: {
    phase: 'deploy_and_drain',
    description: 'Traffic shift from N-1 instances to N instances. In-flight jobs on N-1 allowed to drain within bounded deadline (CVE_JOB_DEADLINE_SECONDS = 1800s).',
    rules: [
      'API N and API N-1 run concurrently against expanded schema',
      'Worker slots drain running leases (CVE_LEASE_SECONDS = 60s)',
      'No new jobs dispatched to draining N-1 worker nodes',
      'Lease fencing prevents zombie worker publish',
    ],
  },
  CONTRACT: {
    phase: 'contract',
    description: 'Pruning deprecated tables, views, or legacy columns in migration N+1 only after 100% of N-1 instances have terminated.',
    rules: [
      'Executed only after zero active N-1 processes remain',
      'Pre-contract snapshot taken before destructive DDL',
      'Audit log tombstone retained for removed entities',
    ],
  },
});

export const CANONICAL_DB_ROLES = Object.freeze([
  {
    role: 'cve_migrator',
    purpose: 'Schema DDL migrations and immutable system catalog seeding',
    hasDdlPrivileges: true,
    bypassesRls: true,
  },
  {
    role: 'cve_api',
    purpose: 'HTTP control plane CRUD scoped by tenant RLS',
    hasDdlPrivileges: false,
    bypassesRls: false,
  },
  {
    role: 'cve_dispatcher',
    purpose: 'Job queue claim, lease renewal, and fenced publication',
    hasDdlPrivileges: false,
    bypassesRls: false,
  },
  {
    role: 'cve_ingest',
    purpose: 'Quarantine asset normalization and SVG sanitization',
    hasDdlPrivileges: false,
    bypassesRls: false,
  },
  {
    role: 'cve_sender',
    purpose: 'Transactional outbox reader and webhook delivery writer',
    hasDdlPrivileges: false,
    bypassesRls: false,
  },
]);

export class MigrationManager {
  constructor(repoRoot = process.cwd()) {
    this.repoRoot = repoRoot;
    this.migrationsDir = path.resolve(repoRoot, 'migrations');
    this.manifestPath = path.resolve(this.migrationsDir, 'manifest.json');
  }

  loadManifest() {
    if (!fs.existsSync(this.manifestPath)) {
      throw new Error(`Migrations manifest not found at: ${this.manifestPath}`);
    }
    const raw = fs.readFileSync(this.manifestPath, 'utf8');
    return JSON.parse(raw);
  }

  computeFileSha256(filePath) {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const buf = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex');
  }

  verifyChecksums() {
    const manifest = this.loadManifest();
    const results = [];

    for (const mig of manifest.migrations) {
      const upPath = path.resolve(this.migrationsDir, mig.up_file);
      const downPath = path.resolve(this.migrationsDir, mig.down_file);

      const actualUpSha = this.computeFileSha256(upPath);
      const actualDownSha = this.computeFileSha256(downPath);

      const upMatches = actualUpSha === mig.up_sha256;
      const downMatches = actualDownSha === mig.down_sha256;

      results.push({
        version: mig.version,
        name: mig.name,
        upFile: mig.up_file,
        upMatches,
        expectedUpSha: mig.up_sha256,
        actualUpSha,
        downFile: mig.down_file,
        downMatches,
        expectedDownSha: mig.down_sha256,
        actualDownSha,
        passed: upMatches && downMatches,
      });
    }

    const allPassed = results.every((r) => r.passed);
    return {
      passed: allPassed,
      totalMigrations: results.length,
      passedMigrations: results.filter((r) => r.passed).length,
      failedMigrations: results.filter((r) => !r.passed).length,
      migrations: results,
    };
  }

  verifyDbRolesIsolation() {
    const manifest = this.loadManifest();
    const roles = manifest.db_roles || [];

    const checks = [];

    // Check 1: Only cve_migrator has bypasses_rls = true
    const migratorRole = roles.find((r) => r.role === 'cve_migrator');
    const migratorBypasses = migratorRole?.bypasses_rls === true;
    checks.push({
      id: 'MIG-ROLE-01',
      title: 'Only cve_migrator has DDL/bypasses_rls privileges',
      passed: migratorBypasses,
      details: `cve_migrator bypasses_rls=${migratorBypasses}`,
    });

    // Check 2: All 4 runtime service roles have bypasses_rls = false
    const runtimeRoles = roles.filter((r) => r.role !== 'cve_migrator');
    const allRuntimeNoBypass = runtimeRoles.every((r) => r.bypasses_rls === false);
    checks.push({
      id: 'MIG-ROLE-02',
      title: 'All runtime roles enforce NOBYPASSRLS',
      passed: allRuntimeNoBypass && runtimeRoles.length === 4,
      details: `${runtimeRoles.length} runtime roles strictly enforce RLS`,
    });

    // Check 3: All 5 canonical roles present
    const roleNames = roles.map((r) => r.role);
    const allRolesPresent = CANONICAL_DB_ROLES.every((cr) => roleNames.includes(cr.role));
    checks.push({
      id: 'MIG-ROLE-03',
      title: 'All 5 segregated DB service roles registered',
      passed: allRolesPresent,
      details: `Roles present: ${roleNames.join(', ')}`,
    });

    const passedChecks = checks.filter((c) => c.passed).length;
    return {
      passed: passedChecks === checks.length,
      totalChecks: checks.length,
      passedChecks,
      failedChecks: checks.length - passedChecks,
      checks,
    };
  }

  verifyTableDefinitions() {
    const manifest = this.loadManifest();
    const tables = manifest.tables || [];

    const checks = [];

    // Check 1: 21 canonical tables registered
    checks.push({
      id: 'MIG-TBL-01',
      title: '21 Canonical Tables Inventory',
      passed: tables.length === 21,
      details: `${tables.length}/21 tables registered in manifest`,
    });

    // Check 2: All tables have RLS enabled and forced
    const allRlsForced = tables.every((t) => t.rls_enabled === true && t.rls_forced === true);
    checks.push({
      id: 'MIG-TBL-02',
      title: 'FORCE ROW LEVEL SECURITY across 100% of tables',
      passed: allRlsForced,
      details: `All 21 tables enforce rls_enabled=true and rls_forced=true`,
    });

    // Check 3: Identity, template, composition, job, artifact, webhook, usage groups covered
    const groups = new Set(tables.map((t) => t.group));
    const requiredGroups = ['identity', 'templates', 'compositions', 'jobs', 'artifacts', 'idempotency', 'webhooks', 'usage'];
    const allGroupsCovered = requiredGroups.every((g) => groups.has(g));
    checks.push({
      id: 'MIG-TBL-03',
      title: 'Complete Architectural Entity Coverage',
      passed: allGroupsCovered,
      details: `Groups covered: ${Array.from(groups).join(', ')}`,
    });

    const passedChecks = checks.filter((c) => c.passed).length;
    return {
      passed: passedChecks === checks.length,
      totalChecks: checks.length,
      passedChecks,
      failedChecks: checks.length - passedChecks,
      checks,
    };
  }

  evaluateExpandContractCompatibility(migrationVersion = '0002') {
    const manifest = this.loadManifest();
    const targetMig = manifest.migrations.find((m) => m.version === migrationVersion);

    if (!targetMig) {
      throw new Error(`Migration version ${migrationVersion} not found in manifest`);
    }

    const upSqlPath = path.resolve(this.migrationsDir, targetMig.up_file);
    const sqlContent = fs.readFileSync(upSqlPath, 'utf8');

    // Analyze SQL for breaking patterns (DROP COLUMN, DROP TABLE, RENAME, NOT NULL without DEFAULT)
    const breakingPatterns = [
      { name: 'DROP_COLUMN', regex: /ALTER\s+TABLE\s+.*\s+DROP\s+COLUMN/i },
      { name: 'DROP_TABLE', regex: /DROP\s+TABLE/i },
      { name: 'RENAME_COLUMN', regex: /RENAME\s+COLUMN/i },
      { name: 'RENAME_TABLE', regex: /RENAME\s+TO/i },
      { name: 'UNSAFE_NOT_NULL', regex: /ADD\s+COLUMN\s+.*\s+NOT\s+NULL(?!\s+DEFAULT)/i },
    ];

    const violations = [];
    for (const pat of breakingPatterns) {
      if (pat.regex.test(sqlContent)) {
        violations.push(pat.name);
      }
    }

    const isExpandCompatible = violations.length === 0;

    return {
      migrationVersion,
      migrationName: targetMig.name,
      phase: EXPAND_CONTRACT_PHASES.EXPAND.phase,
      backwardCompatibleWithNMinus1: isExpandCompatible,
      violations,
      expandContractRules: EXPAND_CONTRACT_PHASES,
      preflightRequirements: [
        'Connect using CVE_MIGRATION_DATABASE_URL (cve_migrator role)',
        'Set lock_timeout = 10000 (10s max lock wait)',
        'Set statement_timeout = 60000 (60s max DDL runtime)',
        'Take atomic pre-migration WAL snapshot before execution',
      ],
    };
  }

  runAll() {
    const checksums = this.verifyChecksums();
    const roles = this.verifyDbRolesIsolation();
    const tables = this.verifyTableDefinitions();
    const expandContract = this.evaluateExpandContractCompatibility('0002');

    const allPassed = checksums.passed && roles.passed && tables.passed && expandContract.backwardCompatibleWithNMinus1;

    return {
      suite: 'Migration Manager & Expand/Contract Verifier',
      passed: allPassed,
      totalChecks: checksums.totalMigrations * 2 + roles.totalChecks + tables.totalChecks + 1,
      passedChecks:
        checksums.passedMigrations * 2 +
        roles.passedChecks +
        tables.passedChecks +
        (expandContract.backwardCompatibleWithNMinus1 ? 1 : 0),
      failedChecks:
        checksums.failedMigrations * 2 +
        roles.failedChecks +
        tables.failedChecks +
        (expandContract.backwardCompatibleWithNMinus1 ? 0 : 1),
      checksums,
      roles,
      tables,
      expandContract,
    };
  }
}
