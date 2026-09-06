/**
 * Simhash, for `SEO-CONTENT-NEAR-DUPLICATE`.
 *
 * The catalogue names the algorithm — "páginas con contenido casi idéntico
 * (simhash)" — and that choice is the whole point of the check. Comparing two
 * pages byte for byte answers a question nobody has: templated sites differ in
 * a breadcrumb and a footer year, and an exact hash calls them distinct. Simhash
 * answers the question that matters, "is this the same page with the words
 * moved around", because a small edit moves a small number of bits.
 *
 * Everything here is pure and deterministic. No randomised seed, no `Map`
 * iteration order leaking into the digest: two runs over the same bytes must
 * produce the same hex string, or `findings.json` stops being comparable across
 * audits, which is the one promise this project makes.
 */

/** 64 bits: enough that unrelated pages collide about as often as never. */
const BITS = 64n;

/** FNV-1a 64-bit. Chosen for being short, seedless and specified elsewhere. */
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x00000100000001b3n;
const MASK = (1n << BITS) - 1n;

/** Shingle width. Three words is the usual trade between recall and noise. */
const SHINGLE = 3;

/** Below this, "these two pages are similar" is a statement about boilerplate. */
export const MIN_WORDS_FOR_SIMHASH = 50;

/**
 * Hamming distance at or below which two pages are called near-duplicates.
 *
 * Three bits out of 64 is deliberately tight. The check is an inference and is
 * reported as `medium` confidence for that reason; a loose threshold would turn
 * every templated section of a site into a finding and the reader would stop
 * reading the section.
 */
export const NEAR_DUPLICATE_DISTANCE = 3;

function fnv1a64(value: string): bigint {
  let hash = FNV_OFFSET;

  for (let index = 0; index < value.length; index += 1) {
    // Code units, not code points: the digest only has to be stable, not
    // Unicode-aware, and iterating code units is the cheaper contract.
    hash = (hash ^ BigInt(value.charCodeAt(index))) & MASK;
    hash = (hash * FNV_PRIME) & MASK;
  }

  return hash;
}

/**
 * Words of the prose a crawler would read.
 *
 * Lower-cased and stripped of punctuation so "Precio: 10€." and "precio 10€"
 * shingle the same way — the check is about content, not about typography.
 */
export function words(text: string): readonly string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((word) => word !== '');
}

/** Overlapping n-grams. One word of prose contributes to three shingles. */
function shingles(tokens: readonly string[]): readonly string[] {
  if (tokens.length < SHINGLE) {
    return tokens.length === 0 ? [] : [tokens.join(' ')];
  }

  const out: string[] = [];

  for (let index = 0; index + SHINGLE <= tokens.length; index += 1) {
    out.push(tokens.slice(index, index + SHINGLE).join(' '));
  }

  return out;
}

/**
 * The 64-bit simhash of a block of text, as 16 lower-case hex characters.
 *
 * Hex rather than a `bigint` because this value travels through `raw/seo.json`,
 * and `JSON.stringify` refuses a `bigint`. Evidence that cannot be serialised is
 * evidence the report cannot show.
 */
export function simhash(text: string): string {
  const vector = new Array<number>(Number(BITS)).fill(0);

  for (const shingle of shingles(words(text))) {
    const hash = fnv1a64(shingle);

    for (let bit = 0; bit < Number(BITS); bit += 1) {
      const isSet = ((hash >> BigInt(bit)) & 1n) === 1n;
      vector[bit] = (vector[bit] ?? 0) + (isSet ? 1 : -1);
    }
  }

  let digest = 0n;

  for (let bit = 0; bit < Number(BITS); bit += 1) {
    if ((vector[bit] ?? 0) > 0) {
      digest |= 1n << BigInt(bit);
    }
  }

  return digest.toString(16).padStart(16, '0');
}

/** Number of differing bits between two hex digests. 0 means identical. */
export function hammingDistance(left: string, right: string): number {
  let difference = (BigInt(`0x${left}`) ^ BigInt(`0x${right}`)) & MASK;
  let distance = 0;

  while (difference !== 0n) {
    difference &= difference - 1n;
    distance += 1;
  }

  return distance;
}
