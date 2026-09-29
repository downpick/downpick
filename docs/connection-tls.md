# Connection encryption

PostgreSQL and SQL Server profiles support an optional initial database and a TLS mode.
The initial database is used for testing and listing databases. Opening a database in the
explorer overrides it for that driver only.

- **Default:** PostgreSQL endpoints ending in `.rds.amazonaws.com` use verified TLS
  with bundled Amazon RDS roots. Other PostgreSQL endpoints preserve the `pg` driver
  default (including `PGSSLMODE`). SQL Server preserves encrypted connections with
  certificate verification skipped. Supplying a custom CA enables verification for
  either engine in this mode.
- **TLS — verify certificate and hostname:** requires TLS and verifies the server
  identity. Uses a custom PEM CA bundle when supplied; otherwise RDS endpoints use
  bundled roots alongside Node trust roots, and other endpoints use Node defaults.
- **TLS — skip certificate verification:** requires encryption without verifying the
  server identity. This must be explicitly selected for PostgreSQL.
- **Do not request encryption:** disables PostgreSQL TLS and sets SQL Server
  `encrypt: false`. SQL Server may still require TLS according to server policy.

There is no automatic retry that disables TLS or certificate verification after a
failure. Custom aliases and tunnels are not automatically detected as RDS endpoints.
Use verified TLS and provide their CA certificates, with a matching server hostname.

## Bundled Amazon RDS certificates

`server/drivers/rds-ca.json` contains the official AWS global PEM bundle, its source
URL and retrieval date. TypeScript copies this imported JSON into `.electron-out`,
which is included in desktop packages. No runtime certificate download is needed.

Source: https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
AWS documentation: https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html

Refresh the bundle from that HTTPS source when AWS rotates or adds roots, update the
retrieval date and run `npm test`. A custom CA in the connection profile overrides
the bundled trust roots when a newer or private CA is needed.
