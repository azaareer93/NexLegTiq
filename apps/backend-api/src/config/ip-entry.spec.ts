import { parseIpEntry } from './ip-entry';

describe('parseIpEntry', () => {
  it('should read addresses and CIDRs of both families within their prefix length', () => {
    expect(parseIpEntry('10.0.0.1')).toEqual({ address: '10.0.0.1', family: 'ipv4' });
    expect(parseIpEntry('10.0.0.0/8')).toEqual({ address: '10.0.0.0', prefix: 8, family: 'ipv4' });
    expect(parseIpEntry('10.0.0.0/33')).toBeNull();
    expect(parseIpEntry('2001:db8::/64')).toEqual({
      address: '2001:db8::',
      prefix: 64,
      family: 'ipv6',
    });
    expect(parseIpEntry('2001:db8::/129')).toBeNull();
    expect(parseIpEntry('::1')).toEqual({ address: '::1', family: 'ipv6' });
  });

  it('should refuse what is not an address, an extra segment and a malformed prefix', () => {
    expect(parseIpEntry('example.test')).toBeNull();
    expect(parseIpEntry('10.0.0.0/8/1')).toBeNull();
    expect(parseIpEntry('10.0.0.0/x')).toBeNull();
  });
});
