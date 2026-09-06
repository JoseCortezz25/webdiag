/**
 * Who this probe says it is.
 *
 * Spec §10 lists "Cloudflare / bot protection bloquea el scan" as a live risk and
 * answers it with an identifiable user-agent: `FlareDiagnostics/1.0 (+contacto)`.
 * The contact half is the part that matters — an operator who sees the string in
 * an access log must be able to reach a human without filing an abuse report, so
 * it is a real URL and it is overridable per deployment.
 *
 * The product token is frozen. `robots.txt` groups are matched against it, and a
 * site that allowlists us by name must keep working when the contact changes.
 */

/** Frozen: this is the token a site allowlists. */
export const USER_AGENT_PRODUCT = 'FlareDiagnostics/1.0';

/** The name a `User-agent:` line in robots.txt uses to address us. */
export const ROBOTS_TOKEN = 'flarediagnostics';

export const DEFAULT_CONTACT = 'https://github.com/JoseCortezz25/webdiag';

/**
 * The full `User-Agent` header. Every request this probe makes carries it —
 * robots.txt included, because fetching robots.txt anonymously and then
 * identifying ourselves would be the wrong way round.
 */
export function userAgent(contact: string = Bun.env.WEBDIAG_CONTACT ?? DEFAULT_CONTACT): string {
  return `${USER_AGENT_PRODUCT} (+${contact})`;
}
