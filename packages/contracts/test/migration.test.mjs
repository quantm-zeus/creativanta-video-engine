import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateMigrationChecksum,
  normalizeSql,
  parseMigrationFilename,
  loadMigrationsFromDirectory,
  BUNDLED_MIGRATIONS,
  InMemoryDatabaseClient,
  MigrationRunner,
  ChecksumMismatchError,
  parsePostgresUrl,
  redactUrlCredentials,
} from '../dist/index.js';

describe('P1-05 Database Migration & Smoke Harness Specification', () => {
  describe('1. Checksum Calculation & Canonical Normalization', () => {
    it('normalizes CRLF and trailing whitespace deterministically', () => {
      const sqlWithCrlf = 'CREATE TABLE test (\r\n  id INT PRIMARY KEY   \r\n);\r\n';
      const sqlWithLf = 'CREATE TABLE test (\n  id INT PRIMARY KEY\n);';
      assert.equal(normalizeSql(sqlWithCrlf), normalizeSql(sqlWithLf));
      assert.equal(
        calculateMigrationChecksum(sqlWithCrlf),
        calculateMigrationChecksum(sqlWithLf),
      );
    });

    it('produces valid 64-character lowercase hex SHA-256 checksum', () => {
      const checksum = calculateMigrationChecksum('SELECT 1;');
      assert.match(checksum, /^[a-f0-9]{64}$/);
    });

    it('bundled migrations have deterministic, valid checksums', () => {
      assert.equal(BUNDLED_MIGRATIONS.length, 3);
      for (const m of BUNDLED_MIGRATIONS) {
        assert.ok(m.version >= 1);
        assert.ok(m.name.length > 0);
        assert.ok(m.filename.endsWith('.sql'));
        assert.match(m.checksum, /^[a-f0-9]{64}$/);
        assert.equal(m.checksum, calculateMigrationChecksum(m.sql));
      }
    });
  });

  describe('2. Filename Parsing & Directory Discovery', () => {
    it('correctly parses valid migration filenames', () => {
      assert.deepEqual(parseMigrationFilename('001_init_schema_migrations.sql'), {
        version: 1,
        name: 'init_schema_migrations',
      });
      assert.deepEqual(parseMigrationFilename('042_add_tenant_rls_policies.sql'), {
        version: 42,
        name: 'add_tenant_rls_policies',
      });
      assert.deepEqual(parseMigrationFilename('1000_finalize_v1.sql'), {
        version: 1000,
        name: 'finalize_v1',
      });
    });

    it('rejects invalid migration filenames', () => {
      assert.equal(parseMigrationFilename('invalid_name.sql'), null);
      assert.equal(parseMigrationFilename('01_too_short.sql'), null);
      assert.equal(parseMigrationFilename('001_not_sql.txt'), null);
      assert.equal(parseMigrationFilename('abc_test.sql'), null);
    });

    it('falls back to bundled migrations when directory not found', () => {
      const loaded = loadMigrationsFromDirectory('/nonexistent/path/for/test');
      assert.equal(loaded.length, 3);
      assert.equal(loaded[0].version, 1);
      assert.equal(loaded[1].version, 2);
      assert.equal(loaded[2].version, 3);
    });
  });

  describe('3. In-Memory Database Client Execution & Transactions', () => {
    it('tracks tables and supports transaction commit and rollback', async () => {
      const client = new InMemoryDatabaseClient();

      await client.query('CREATE TABLE schema_migrations;');
      assert.ok(client.tables.has('schema_migrations'));

      // Test transaction commit
      await client.query('BEGIN;');
      await client.query(
        "INSERT INTO schema_migrations VALUES (1, 'init', 'abc', '2026-11-03T00:00:00Z', 10);",
      );
      await client.query('COMMIT;');

      let records = await client.query('SELECT * FROM schema_migrations;');
      assert.equal(records.rows.length, 1);

      // Test transaction rollback
      await client.query('BEGIN;');
      await client.query(
        "INSERT INTO schema_migrations VALUES (2, 'second', 'def', '2026-11-03T00:00:00Z', 15);",
      );
      await client.query('ROLLBACK;');

      records = await client.query('SELECT * FROM schema_migrations;');
      assert.equal(records.rows.length, 1);
      assert.equal(records.rows[0].version, 1);
    });

    it('tracks advisory locks', async () => {
      const client = new InMemoryDatabaseClient();
      await client.query('SELECT pg_advisory_lock(12345);');
      assert.ok(client.advisoryLocks.has(12345));

      await client.query('SELECT pg_advisory_unlock(12345);');
      assert.ok(!client.advisoryLocks.has(12345));
    });
  });

  describe('4. Migration Runner Lifecycle & Idempotency', () => {
    it('executes all bundled migrations sequentially on fresh database', async () => {
      const client = new InMemoryDatabaseClient();
      const runner = new MigrationRunner(client);

      const planBefore = await runner.plan();
      assert.equal(planBefore.currentVersion, 0);
      assert.equal(planBefore.pendingCount, 3);

      const result = await runner.migrate();
      assert.equal(result.status, 'SUCCESS');
      assert.equal(result.currentVersion, 3);
      assert.equal(result.applied.length, 3);

      const applied = await runner.getAppliedMigrations();
      assert.equal(applied.length, 3);
      assert.equal(applied[0].version, 1);
      assert.equal(applied[1].version, 2);
      assert.equal(applied[2].version, 3);
    });

    it('is strictly idempotent on re-execution', async () => {
      const client = new InMemoryDatabaseClient();
      const runner = new MigrationRunner(client);

      await runner.migrate();

      // Second run: must detect ALREADY_UP_TO_DATE with zero new applications
      const secondRun = await runner.migrate();
      assert.equal(secondRun.status, 'ALREADY_UP_TO_DATE');
      assert.equal(secondRun.applied.length, 0);
      assert.equal(secondRun.currentVersion, 3);
    });

    it('detects tampering of already-applied migrations', async () => {
      const client = new InMemoryDatabaseClient();
      const runner = new MigrationRunner(client);

      await runner.migrate();

      // Simulate tampering by altering SQL of version 2
      const tamperedMigrations = BUNDLED_MIGRATIONS.map((m) => {
        if (m.version === 2) {
          const alteredSql = m.sql + '\n-- Tampered comment';
          return {
            ...m,
            sql: alteredSql,
            checksum: calculateMigrationChecksum(alteredSql),
          };
        }
        return m;
      });

      const tamperedRunner = new MigrationRunner(client, tamperedMigrations);
      await assert.rejects(
        async () => {
          await tamperedRunner.migrate();
        },
        (err) => {
          assert.ok(err instanceof ChecksumMismatchError);
          assert.equal(err.version, 2);
          return true;
        },
      );
    });

    it('rolls back intermediate statements on error during migration', async () => {
      const client = new InMemoryDatabaseClient();
      const customMigrations = [
        {
          version: 1,
          name: 'step_one',
          filename: '001_step_one.sql',
          sql: 'CREATE TABLE table_one (id INT);',
          checksum: calculateMigrationChecksum('CREATE TABLE table_one (id INT);'),
        },
        {
          version: 2,
          name: 'failing_step',
          filename: '002_failing_step.sql',
          sql: 'INVALID SQL STATEMENT THAT BLOWS UP;',
          checksum: calculateMigrationChecksum('INVALID SQL STATEMENT THAT BLOWS UP;'),
        },
      ];

      const runner = new MigrationRunner(client, customMigrations);

      // Tell in-memory client to fail on the second migration
      let queryCount = 0;
      const originalQuery = client.query.bind(client);
      client.query = async function (sql, params) {
        if (sql.includes('INVALID SQL STATEMENT')) {
          throw new Error('Syntax error at or near INVALID');
        }
        return originalQuery(sql, params);
      };

      await assert.rejects(
        async () => {
          await runner.migrate();
        },
        /Migration failed at version 2/,
      );

      // Version 1 succeeded, Version 2 did NOT get applied
      const applied = await runner.getAppliedMigrations();
      assert.equal(applied.length, 1);
      assert.equal(applied[0].version, 1);
    });
  });

  describe('5. Schema Compatibility Verification for API Readiness', () => {
    it('reports incompatible when migrations are pending', async () => {
      const client = new InMemoryDatabaseClient();
      const runner = new MigrationRunner(client);

      const compatBefore = await runner.checkCompatibility();
      assert.equal(compatBefore.isCompatible, false);
      assert.equal(compatBefore.currentVersion, 0);
      assert.equal(compatBefore.pendingCount, 3);
      assert.deepEqual(compatBefore.pendingVersions, [1, 2, 3]);
    });

    it('reports compatible when all migrations are applied', async () => {
      const client = new InMemoryDatabaseClient();
      const runner = new MigrationRunner(client);

      await runner.migrate();

      const compatAfter = await runner.checkCompatibility();
      assert.equal(compatAfter.isCompatible, true);
      assert.equal(compatAfter.currentVersion, 3);
      assert.equal(compatAfter.targetVersion, 3);
      assert.equal(compatAfter.pendingCount, 0);
    });
  });

  describe('6. Role Segregation Verification', () => {
    it('verifies that cve_migrator can execute DDL and app roles are segregated', async () => {
      const client = new InMemoryDatabaseClient();
      const runner = new MigrationRunner(client);

      const segregation = await runner.verifyRoleSegregation();
      assert.equal(segregation.migratorCanDdl, true);
      assert.equal(segregation.apiDeniedDdl, true);
      assert.equal(segregation.dispatcherDeniedDdl, true);
      assert.equal(segregation.allRolesSegregated, true);
      assert.ok(segregation.details['cve_migrator'].includes('DDL allowed'));
      assert.ok(segregation.details['cve_api'].includes('Restricted to CRUD'));
    });
  });

  describe('7. Credentials Redaction & Wire Protocol URL Parsing', () => {
    it('redacts passwords in connection URLs across logs and errors', () => {
      const secretUrl =
        'postgresql://cve_migrator:super_secret_pw_12345@db.internal.example:5432/creativanta_video_engine';
      const redacted = redactUrlCredentials(secretUrl);
      assert.ok(!redacted.includes('super_secret_pw_12345'));
      assert.ok(redacted.includes('REDACTED'));
      assert.ok(redacted.includes('cve_migrator'));
      assert.ok(redacted.includes('db.internal.example:5432'));
    });

    it('correctly parses postgres URLs into config components', () => {
      const parsed = parsePostgresUrl(
        'postgresql://my_user:my_secret@10.0.0.5:5433/custom_db',
      );
      assert.equal(parsed.host, '10.0.0.5');
      assert.equal(parsed.port, 5433);
      assert.equal(parsed.user, 'my_user');
      assert.equal(parsed.password, 'my_secret');
      assert.equal(parsed.database, 'custom_db');
    });

    it('redacts URL in parse error when URL is malformed', () => {
      assert.throws(
        () => parsePostgresUrl('http://invalid:password@host/db'),
        (err) => {
          assert.ok(err.message.includes('REDACTED'));
          assert.ok(!err.message.includes('password'));
          return true;
        },
      );
    });
  });
});
