/**
 * Reading the security headers, and only reading them.
 *
 * Every function here is pure: a header transcript in, observations out. That is
 * what lets the judgement calls below be argued about in a unit test instead of
 * against a live site that changes overnight.
 *
 * Two of those calls are worth stating up front, because they are where a header
 * scanner usually starts lying:
 *
 *  - **A `report-only` CSP is still a missing CSP.** It reports; it does not
 *    block. The finding says so and carries the report-only header as evidence,
 *    rather than silently crediting the site for a policy that enforces nothing.
 *  - **Cookies are `confidence: medium`, not high.** A cookie the front-end reads
 *    by design has no `HttpOnly` and never will. The check cannot tell that case
 *    from a mistake, so it declines to claim certainty (spec §6: `confidence` is
 *    the valve against false positives).
 */
import type { RawObservation } from '../raw.ts';
import { type HeaderBlock, headerValue, headerValues } from './curl.ts';
import { requestPath } from './robots.ts';

export type HeaderAnalysis = {
  readonly observations: readonly RawObservation[];
  /** What could not be checked, and why. Surfaced instead of being dropped. */
  readonly notes: readonly string[];
};

export type HeaderInput = {
  readonly finalUrl: string;
  readonly blocks: readonly HeaderBlock[];
};

/** Headers that name a product, and often its exact version, for free. */
const DISCLOSING_HEADERS: readonly string[] = [
  'x-powered-by',
  'x-aspnet-version',
  'x-aspnetmvc-version',
  'x-generator',
];

type Directive = {
  readonly name: string;
  readonly values: readonly string[];
};

export function parseCsp(policy: string): readonly Directive[] {
  return policy
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => {
      const [name = '', ...values] = part.split(/\s+/);
      return { name: name.toLowerCase(), values };
    });
}

export type Cookie = {
  readonly name: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly sameSite: string | undefined;
};

export function parseSetCookie(value: string): Cookie | undefined {
  const [pair, ...attributes] = value.split(';');
  const name = pair?.split('=')[0]?.trim();

  if (name === undefined || name === '') {
    return undefined;
  }

  const flags = attributes.map((attribute) => attribute.trim().toLowerCase());
  const sameSite = flags.find((flag) => flag.startsWith('samesite='))?.split('=')[1];

  return {
    name,
    secure: flags.includes('secure'),
    httpOnly: flags.includes('httponly'),
    sameSite,
  };
}

/** What is wrong with one cookie, in the catalogue's terms. Empty means nothing. */
export function cookieProblems(cookie: Cookie, https: boolean): readonly string[] {
  const problems: string[] = [];

  if (https && !cookie.secure) {
    problems.push('sin Secure');
  }

  if (!cookie.httpOnly) {
    problems.push('sin HttpOnly');
  }

  if (cookie.sameSite === undefined) {
    problems.push('sin SameSite');
  } else if (cookie.sameSite === 'none' && !cookie.secure) {
    problems.push('SameSite=None sin Secure');
  }

  return problems;
}

function maxAgeOf(hsts: string): number | undefined {
  const match = /max-age\s*=\s*"?(\d+)"?/i.exec(hsts);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

function cspOf(block: HeaderBlock): {
  readonly enforced: string | undefined;
  readonly reportOnly: string | undefined;
} {
  return {
    enforced: headerValue(block, 'content-security-policy'),
    reportOnly: headerValue(block, 'content-security-policy-report-only'),
  };
}

function checkCsp(block: HeaderBlock, path: string): readonly RawObservation[] {
  const { enforced, reportOnly } = cspOf(block);
  const observations: RawObservation[] = [];

  if (enforced === undefined) {
    observations.push({
      id: 'SEC-CSP-MISSING',
      confidence: 'high',
      count: 1,
      affected: [path],
      evidence: {
        header: 'content-security-policy',
        present: false,
        report_only_present: reportOnly !== undefined,
        ...(reportOnly === undefined ? {} : { report_only_value: reportOnly }),
      },
      remediation:
        reportOnly === undefined
          ? 'Publicar una Content-Security-Policy en modo report-only, revisar los reportes y despues endurecerla a modo enforcing.'
          : 'Ya existe una CSP en report-only: revisar sus reportes y promoverla a Content-Security-Policy para que bloquee, no solo avise.',
    });
  }

  const policy = enforced ?? reportOnly;

  if (policy === undefined) {
    return observations;
  }

  const unsafe = parseCsp(policy).filter((directive) =>
    directive.values.some((value) => /^'unsafe-(inline|eval)'$/i.test(value)),
  );

  if (unsafe.length > 0) {
    observations.push({
      id: 'SEC-CSP-UNSAFE',
      confidence: 'high',
      count: unsafe.length,
      affected: [path],
      evidence: {
        enforcing: enforced !== undefined,
        directives: unsafe.map((directive) => `${directive.name} ${directive.values.join(' ')}`),
      },
      remediation:
        "Eliminar 'unsafe-inline' y 'unsafe-eval': mover el JS y el CSS inline a archivos y, si hacen falta excepciones, autorizarlas con nonce o hash por directiva.",
    });
  }

  return observations;
}

function checkHsts(block: HeaderBlock, path: string, https: boolean): readonly RawObservation[] {
  if (!https) {
    return [];
  }

  const hsts = headerValue(block, 'strict-transport-security');

  if (hsts === undefined) {
    return [
      {
        id: 'SEC-HSTS-MISSING',
        confidence: 'high',
        count: 1,
        affected: [path],
        evidence: { header: 'strict-transport-security', present: false },
        remediation:
          'Anadir Strict-Transport-Security con max-age de al menos 15552000 (6 meses) e includeSubDomains.',
      },
    ];
  }

  const maxAge = maxAgeOf(hsts);

  // `max-age=0` is the documented way to *switch HSTS off*. Counting it as
  // present would credit the site for a header that disables the protection.
  if (maxAge === undefined || maxAge === 0) {
    return [
      {
        id: 'SEC-HSTS-MISSING',
        confidence: 'high',
        count: 1,
        affected: [path],
        evidence: {
          header: 'strict-transport-security',
          value: hsts,
          max_age: maxAge ?? null,
          note: 'El header existe pero no activa HSTS.',
        },
        remediation:
          'Corregir Strict-Transport-Security: max-age=0 (o ausente) desactiva la proteccion. Usar al menos 15552000.',
      },
    ];
  }

  return [];
}

function checkFrameOptions(block: HeaderBlock, path: string): readonly RawObservation[] {
  const xfo = headerValue(block, 'x-frame-options');
  const { enforced } = cspOf(block);
  const frameAncestors =
    enforced === undefined
      ? undefined
      : parseCsp(enforced).find((directive) => directive.name === 'frame-ancestors');

  if (xfo !== undefined || frameAncestors !== undefined) {
    return [];
  }

  return [
    {
      id: 'SEC-XFO-MISSING',
      confidence: 'high',
      count: 1,
      affected: [path],
      evidence: {
        header: 'x-frame-options',
        present: false,
        csp_frame_ancestors: false,
      },
      remediation:
        "Anadir la directiva CSP frame-ancestors 'self' (o X-Frame-Options: SAMEORIGIN en clientes antiguos) para impedir el clickjacking.",
    },
  ];
}

function checkCookies(blocks: readonly HeaderBlock[], https: boolean): readonly RawObservation[] {
  const offenders = blocks
    .flatMap((block) => headerValues(block, 'set-cookie'))
    .flatMap((value) => {
      const cookie = parseSetCookie(value);
      if (cookie === undefined) {
        return [];
      }
      const problems = cookieProblems(cookie, https);
      return problems.length === 0 ? [] : [{ cookie, problems }];
    });

  if (offenders.length === 0) {
    return [];
  }

  const names = [...new Set(offenders.map((offender) => offender.cookie.name))].sort();

  return [
    {
      id: 'SEC-COOKIE-INSECURE',
      confidence: 'medium',
      count: offenders.length,
      affected: names,
      evidence: {
        cookies: offenders.map((offender) => ({
          name: offender.cookie.name,
          missing: offender.problems,
        })),
        note: 'Una cookie que el front-end lee por diseno no lleva HttpOnly; revisar caso por caso.',
      },
      remediation:
        'Marcar las cookies de sesion con Secure, HttpOnly y SameSite=Lax (o Strict). Si una cookie necesita SameSite=None, debe llevar Secure.',
    },
  ];
}

function checkDisclosure(block: HeaderBlock, path: string): readonly RawObservation[] {
  const disclosed: { name: string; value: string }[] = [];
  const server = headerValue(block, 'server');

  // `Server: cloudflare` discloses nothing actionable; `Server: nginx/1.18.0` does.
  if (server !== undefined && /\d+\.\d+/.test(server)) {
    disclosed.push({ name: 'server', value: server });
  }

  for (const name of DISCLOSING_HEADERS) {
    const value = headerValue(block, name);
    if (value !== undefined) {
      disclosed.push({ name, value });
    }
  }

  if (disclosed.length === 0) {
    return [];
  }

  const versioned = disclosed.some((header) => /\d+\.\d+/.test(header.value));

  return [
    {
      id: 'SEC-SERVER-VERSION-DISCLOSED',
      confidence: versioned ? 'high' : 'medium',
      count: disclosed.length,
      affected: [path],
      evidence: Object.fromEntries(disclosed.map((header) => [header.name, header.value])),
      remediation:
        'Ocultar la version del servidor y del framework: server_tokens off en nginx, ServerTokens Prod en Apache, y eliminar X-Powered-By en la aplicacion.',
    },
  ];
}

/**
 * Judges the transcript.
 *
 * Header checks read the **final** response, because that is the document a
 * visitor ends up on. Cookies are collected from **every** hop: a redirect that
 * drops an insecure session cookie on the way is exactly the case that matters,
 * and looking only at the last response would miss it.
 */
export function analyzeHeaders(input: HeaderInput): HeaderAnalysis {
  const last = input.blocks.at(-1);

  if (last === undefined) {
    return {
      observations: [],
      notes: ['curl returned no response headers, so no header check could run.'],
    };
  }

  const https = new URL(input.finalUrl).protocol === 'https:';
  const path = requestPath(input.finalUrl);
  const notes: string[] = [];

  if (!https) {
    notes.push(
      `The final response is ${input.finalUrl}, which is not HTTPS: HSTS and cookie Secure flags were not evaluated.`,
    );
  }

  return {
    observations: [
      ...checkCsp(last, path),
      ...checkHsts(last, path, https),
      ...checkFrameOptions(last, path),
      ...checkCookies(input.blocks, https),
      ...checkDisclosure(last, path),
    ],
    notes,
  };
}
