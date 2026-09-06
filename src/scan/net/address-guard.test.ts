import { describe, expect, test } from 'bun:test';
import { isPrivateHostname, isSameSite, refusalFor } from './address-guard.ts';

describe('isPrivateHostname', () => {
  test.each([
    ['localhost'],
    ['LOCALHOST'],
    ['app.localhost'],
    ['printer.local'],
    ['db.internal'],
    ['nas.home.arpa'],
    ['127.0.0.1'],
    ['127.9.9.9'],
    ['0.0.0.0'],
    ['10.0.0.5'],
    ['172.16.0.1'],
    ['172.31.255.255'],
    ['192.168.1.1'],
    ['169.254.169.254'],
    ['100.64.0.1'],
    ['[::1]'],
    ['::1'],
    ['[::]'],
    ['[fe80::1]'],
    ['[fd12:3456::1]'],
    ['[fc00::1]'],
    ['[::ffff:127.0.0.1]'],
    ['[::ffff:7f00:1]'],
    ['[::ffff:a9fe:a9fe]'],
  ])('%s is private', (hostname) => {
    expect(isPrivateHostname(hostname)).toBe(true);
  });

  test.each([
    ['example.com'],
    ['www.example.com'],
    ['localhost.example.com'],
    ['8.8.8.8'],
    ['172.15.0.1'],
    ['172.32.0.1'],
    ['100.128.0.1'],
    ['[2001:db8::1]'],
    ['[2606:4700::1111]'],
    ['[::ffff:808:808]'],
  ])('%s is public', (hostname) => {
    expect(isPrivateHostname(hostname)).toBe(false);
  });
});

describe('refusalFor', () => {
  test('a public URL is allowed with or without a scan host', () => {
    expect(refusalFor('https://example.com/x', {})).toBeUndefined();
    expect(refusalFor('https://example.com/x', { scanHost: 'other.test' })).toBeUndefined();
  });

  test('a private address is refused when it is not the scan host', () => {
    expect(refusalFor('http://169.254.169.254/latest/meta-data/', {})).toContain('private');
    expect(refusalFor('http://localhost:9200/', { scanHost: 'example.com' })).toContain('private');
  });

  test('the scan host itself is trusted even when private', () => {
    expect(
      refusalFor('http://127.0.0.1:8080/robots.txt', { scanHost: '127.0.0.1' }),
    ).toBeUndefined();
    expect(refusalFor('http://[::1]:8080/', { scanHost: '[::1]' })).toBeUndefined();
    expect(
      refusalFor('http://staging.internal/', { scanHost: 'staging.internal' }),
    ).toBeUndefined();
  });

  test('trusting one private host does not open the others', () => {
    expect(refusalFor('http://127.0.0.1:8080/', { scanHost: '10.0.0.5' })).toContain('private');
  });

  test('non-http schemes and garbage are refused with a reason', () => {
    expect(refusalFor('ftp://example.com/', {})).toContain('http(s)');
    expect(refusalFor('not a url', {})).toContain('valid URL');
  });
});

describe('isSameSite', () => {
  test('matches the host itself and its subdomains, case-insensitively', () => {
    expect(isSameSite('https://example.com/sitemap.xml', 'example.com')).toBe(true);
    expect(isSameSite('https://cdn.example.com/s.xml', 'example.com')).toBe(true);
    expect(isSameSite('https://CDN.Example.com/s.xml', 'example.com')).toBe(true);
  });

  test('rejects other hosts, look-alikes and unparseable values', () => {
    expect(isSameSite('https://example.org/s.xml', 'example.com')).toBe(false);
    expect(isSameSite('https://notexample.com/s.xml', 'example.com')).toBe(false);
    expect(isSameSite('nope', 'example.com')).toBe(false);
  });
});
