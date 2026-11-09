import { isIP } from 'node:net';

/** An allow-list entry: an IP address, or a CIDR whose prefix fits its family. */
export function parseIpEntry(
  entry: string,
): { address: string; prefix?: number; family: 'ipv4' | 'ipv6' } | null {
  const [address = '', prefixText, extra] = entry.split('/');
  const version = isIP(address);
  if (version === 0 || extra !== undefined) return null;
  const family = version === 4 ? 'ipv4' : 'ipv6';
  if (prefixText === undefined) return { address, family };
  const prefix = Number(prefixText);
  const max = version === 4 ? 32 : 128;
  return /^\d{1,3}$/.test(prefixText) && prefix <= max ? { address, prefix, family } : null;
}
