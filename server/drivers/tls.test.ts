import { test } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate } from 'crypto';
import { ConnectionOptions } from 'tls';
import { Client, Pool } from 'pg';
import * as sql from 'mssql';
import { PostgresDriver } from './postgres';
import { SqlServerDriver } from './sqlserver';
import { postgresTls, sqlServerTls } from './tls';
import { ConnectionConfigWithPassword } from '../connections';
import rdsCa from './rds-ca.json';

const base: ConnectionConfigWithPassword = {
  id: 'test', name: 'test', type: 'postgres', host: 'localhost', port: 5432,
  username: 'test', password: '',
};

test('existing RDS profiles get verified TLS without editing or environment variables', async () => {
  const driver = new PostgresDriver({ ...base, host: 'a1pgdb.cbo0k00iitjx.sa-east-1.rds.amazonaws.com' });
  const pool = (driver as unknown as { pool: Pool }).pool;
  const client = new Client(pool.options);
  const ssl = client.ssl as boolean | ConnectionOptions;
  assert.ok(ssl && typeof ssl === 'object');
  assert.equal(ssl.rejectUnauthorized, true);
  assert.ok(Array.isArray(ssl.ca) && ssl.ca.includes(rdsCa.pem));
  await driver.close();
});

test('bundled RDS trust includes valid Sao Paulo roots and is copied into the build', () => {
  const certificates = rdsCa.pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  assert.ok(certificates.length > 0);
  const regional = certificates.map((pem) => new X509Certificate(pem))
    .filter((cert) => cert.subject.includes('sa-east-1'));
  assert.ok(regional.length > 0);
  for (const cert of regional) {
    assert.ok(cert.ca);
    assert.ok(Date.parse(cert.validTo) > Date.now());
    assert.ok(cert.verify(cert.publicKey));
  }
});

test('explicit PostgreSQL modes override defaults; custom CA never disables verification', () => {
  assert.equal(postgresTls(base), undefined);
  assert.equal(postgresTls({ ...base, host: 'foo.rds.amazonaws.com.attacker.example' }), undefined);
  assert.equal(postgresTls({ ...base, tlsMode: 'disable' }), false);
  assert.deepEqual(postgresTls({ ...base, tlsMode: 'require' }), { rejectUnauthorized: false });
  assert.deepEqual(postgresTls({ ...base, tlsCa: ' custom CA ' }), { rejectUnauthorized: true, ca: 'custom CA' });
  assert.deepEqual(postgresTls({ ...base, tlsMode: 'verify' }), { rejectUnauthorized: true });
  assert.throws(() => postgresTls({ ...base, tlsMode: 'invalid' as never }), /Invalid TLS mode/);
});

test('SQL Server passes encryption and CA settings through mssql to tedious', () => {
  for (const tlsMode of ['default', 'verify', 'require', 'disable'] as const) {
    const driver = new SqlServerDriver({ ...base, type: 'sqlserver', tlsMode });
    const config = (driver as unknown as { config: sql.config }).config;
    const pool = new sql.ConnectionPool(config);
    const effective = (pool as unknown as { _config(): { options: sql.IOptions } })._config().options;
    assert.equal(effective.encrypt, tlsMode !== 'disable');
    assert.equal(effective.trustServerCertificate, tlsMode !== 'verify');
  }
  assert.equal(sqlServerTls({ ...base, tlsCa: 'CA' }).trustServerCertificate, false);
  assert.equal(sqlServerTls({ ...base, tlsMode: 'verify', tlsCa: 'CA' }).cryptoCredentialsDetails?.ca, 'CA');
});

test('initial database is used until a database is selected explicitly', async () => {
  for (const database of [undefined, 'selected']) {
    const config = { ...base, initialDatabase: 'app', database };
    const pg = new PostgresDriver(config);
    assert.equal((pg as unknown as { pool: Pool }).pool.options.database, database ?? 'app');
    const ms = new SqlServerDriver(config);
    assert.equal((ms as unknown as { config: sql.config }).config.database, database ?? 'app');
    await pg.close();
  }
});
