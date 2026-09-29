import { ConnectionOptions, rootCertificates } from 'tls';
import { ConnectionConfig } from '../connections';
import rdsCa from './rds-ca.json';

// Bundled at build time: connecting never requires an HTTP request to fetch trust roots.
// Custom DNS aliases / tunnels can use an explicitly supplied CA and verified TLS.
function isRds(host: string): boolean {
  return /\.rds\.amazonaws\.com\.?$/i.test(host);
}

function mode(config: ConnectionConfig) {
  const value = config.tlsMode ?? 'default';
  if (!['default', 'verify', 'require', 'disable'].includes(value)) {
    throw new Error('Invalid TLS mode. Edit the connection encryption settings.');
  }
  return value;
}

function verified(config: ConnectionConfig): ConnectionOptions {
  const ca = config.tlsCa?.trim();
  return {
    rejectUnauthorized: true,
    ...(ca ? { ca } : isRds(config.host) ? { ca: [...rootCertificates, rdsCa.pem] } : {}),
  };
}

export function postgresTls(config: ConnectionConfig): boolean | ConnectionOptions | undefined {
  switch (mode(config)) {
    case 'disable': return false;
    case 'require': return { rejectUnauthorized: false };
    case 'verify': return verified(config);
    default:
      // Preserve pg's environment-based defaults for old non-RDS profiles.
      return isRds(config.host) || config.tlsCa?.trim() ? verified(config) : undefined;
  }
}

export function sqlServerTls(config: ConnectionConfig) {
  const selected = mode(config);
  const verify = selected === 'verify' || (selected === 'default' && !!config.tlsCa?.trim());
  return {
    encrypt: selected !== 'disable',
    trustServerCertificate: !verify,
    ...(verify ? { cryptoCredentialsDetails: verified(config) } : {}),
  };
}
