/**
 * Which hosts a probe may follow to.
 *
 * The operator names one site. Everything else a probe fetches — a redirect
 * `Location`, a `Sitemap:` line in robots.txt, a child sitemap, a canonical —
 * is chosen by that site, and a site can point the diagnostic at addresses the
 * operator never meant it to reach: `http://169.254.169.254/` for a cloud
 * metadata endpoint, `http://localhost:9200/` for whatever runs next to the
 * scanner. This module is the one rule that stops that: a derived URL that
 * resolves to a private, loopback or link-local address is refused unless it
 * is the very host the scan was pointed at.
 *
 * The check is on the hostname as written, not on a DNS answer. A name that
 * resolves to a private address at request time is not caught here; that is
 * documented rather than pretended away, and it is why the target host itself
 * is the allow-list rather than "anything public-looking".
 */

/** `[::1]` → `::1`; `example.com` → `example.com`. Always lower-cased. */
function bareHostname(hostname: string): string {
  const lower = hostname.toLowerCase();
  return lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;
}

function ipv4Octets(hostname: string): readonly number[] | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);

  if (match === null) {
    return undefined;
  }

  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) ? octets : undefined;
}

function isPrivateIpv4(octets: readonly number[]): boolean {
  const [a = -1, b = -1] = octets;

  return (
    a === 0 || // 0.0.0.0/8: "this host"
    a === 10 || // 10/8
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local, including cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12
    (a === 192 && b === 168) || // 192.168/16
    (a === 100 && b >= 64 && b <= 127) // 100.64/10: carrier-grade NAT
  );
}

/**
 * Expands the IPv4 embedded in an IPv4-mapped IPv6 address. `URL` normalises
 * `::ffff:127.0.0.1` to `::ffff:7f00:1`, so both spellings are handled.
 */
function mappedIpv4(hostname: string): readonly number[] | undefined {
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(hostname);

  if (dotted?.[1] !== undefined) {
    return ipv4Octets(dotted[1]);
  }

  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(hostname);

  if (hex?.[1] === undefined || hex[2] === undefined) {
    return undefined;
  }

  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

function isPrivateIpv6(hostname: string): boolean {
  if (hostname === '::' || hostname === '::1') {
    return true;
  }

  const mapped = mappedIpv4(hostname);

  if (mapped !== undefined) {
    return isPrivateIpv4(mapped);
  }

  const firstGroup = hostname.split(':')[0] ?? '';
  const value = Number.parseInt(firstGroup.padEnd(4, '0').slice(0, 4), 16);

  if (firstGroup === '' || Number.isNaN(value)) {
    return false;
  }

  return (
    (value & 0xfe00) === 0xfc00 || // fc00::/7: unique local
    (value & 0xffc0) === 0xfe80 // fe80::/10: link-local
  );
}

/** Names that only ever mean "this machine" or "this network". */
const PRIVATE_NAME_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'] as const;

/**
 * True when the hostname denotes a loopback, private, link-local or otherwise
 * non-public address. Takes the hostname exactly as `URL.hostname` yields it.
 */
export function isPrivateHostname(hostname: string): boolean {
  const host = bareHostname(hostname);

  if (host === '' || host === 'localhost') {
    return true;
  }

  if (PRIVATE_NAME_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return true;
  }

  const octets = ipv4Octets(host);

  if (octets !== undefined) {
    return isPrivateIpv4(octets);
  }

  return host.includes(':') && isPrivateIpv6(host);
}

export type AddressPolicy = {
  /**
   * The hostname the operator pointed the scan at. It is trusted even when it
   * is private, because scanning a staging host on `10.0.0.5` is a legitimate
   * use. Undefined means nothing is trusted beyond public addresses.
   */
  readonly scanHost?: string | undefined;
};

/**
 * Decides whether a probe may fetch `url`. Returns the reason for a refusal so
 * the caller can record it as a note instead of silently narrowing the run.
 */
export function refusalFor(url: string, policy: AddressPolicy): string | undefined {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return `'${url}' is not a valid URL`;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `'${url}' is not an http(s) URL`;
  }

  const host = bareHostname(parsed.hostname);
  const trusted = policy.scanHost === undefined ? undefined : bareHostname(policy.scanHost);

  if (host === trusted) {
    return undefined;
  }

  if (isPrivateHostname(host)) {
    return `refused to fetch '${url}': '${parsed.hostname}' is a private or local address`;
  }

  return undefined;
}

/** Same host as `scanHost`, or a subdomain of it. Used to scope sitemap discovery. */
export function isSameSite(url: string, scanHost: string): boolean {
  try {
    const host = bareHostname(new URL(url).hostname);
    const trusted = bareHostname(scanHost);
    return host === trusted || host.endsWith(`.${trusted}`);
  } catch {
    return false;
  }
}
