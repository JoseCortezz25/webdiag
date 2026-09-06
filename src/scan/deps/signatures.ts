/**
 * Library fingerprints for the case retire.js cannot answer: the library is
 * plainly there, and its version is not.
 *
 * retire.js is version-first by design — it matches a known release and reports
 * it, and when it cannot pin a version it reports nothing at all. In a black-box
 * run that is most of a modern site: webpack and Vite strip the banner comments
 * the version regexes look for, so a bundle containing React, Vue or lodash
 * comes back empty. "Empty" then reads as "clean", which is the exact
 * misreading `DEPS-VERSION-UNDETERMINED` exists to prevent.
 *
 * So these patterns detect *presence*, never version. They are chosen from the
 * strings a minifier has to preserve — error-page URLs, licence headers,
 * devtools hooks, data attributes — because identifiers get renamed and string
 * literals do not.
 *
 * A false positive here costs an `info` finding saying "we could not pin a
 * version". A false negative silently narrows the scan. The list is tuned
 * accordingly.
 *
 * The jQuery pattern learned this the hard way (issue #12): Google's
 * `gtag.js` and `gtm.js` carry a stray jQuery license comment ("jQuery (c)
 * 2005, 2012 jQuery Foundation, Inc. jquery.org/license.") above an unrelated
 * internal helper — no jQuery code, no `jQuery.fn.jquery`, just the string.
 * Matching on the license URL alone reported "jquery" on two of the three
 * calibration sites, neither of which ships jQuery through that script.
 * `jQuery.fn.jquery` is the version-banner property every real jQuery build
 * sets on itself, so it stays the only signal.
 */

export type LibrarySignature = {
  /** Canonical name. Matches retire.js component names where one exists. */
  readonly library: string;
  /** Content marker a minifier cannot rename. Case-sensitive unless stated. */
  readonly pattern: RegExp;
};

export const LIBRARY_SIGNATURES: readonly LibrarySignature[] = [
  { library: 'jquery', pattern: /jQuery\.fn\.jquery/ },
  { library: 'jquery-ui', pattern: /jqueryui\.com|jQuery\.ui\.version/ },
  {
    library: 'react',
    pattern: /__SECRET_INTERNALS_DO_NOT_USE|react\.dev\/errors|reactjs\.org\/docs\/error-decoder/,
  },
  { library: 'react-dom', pattern: /__reactContainer\$|react-dom\.production/ },
  { library: 'vue', pattern: /__VUE_DEVTOOLS_GLOBAL_HOOK__|vuejs\.org\/error-reference/ },
  { library: 'angular', pattern: /@angular\/core|ng-version|angular\.io\/errors/ },
  { library: 'angularjs', pattern: /angularjs\.org|angular\.module\(/ },
  { library: 'lodash', pattern: /lodash\.com\/license|_\.templateSettings/ },
  { library: 'underscore', pattern: /underscorejs\.org/ },
  { library: 'moment', pattern: /momentjs\.com|moment\.defaultFormat/ },
  { library: 'bootstrap', pattern: /getbootstrap\.com|data-bs-toggle|bs\.collapse/ },
  { library: 'popper.js', pattern: /@popperjs\/core|popper\.js/ },
  { library: 'swiper', pattern: /swiperjs\.com|swiper-slide/ },
  { library: 'gsap', pattern: /greensock\.com|gsap\.registerPlugin/ },
  { library: 'axios', pattern: /AxiosError|XSRF-TOKEN/ },
  { library: 'three', pattern: /THREE\.WebGLRenderer|threejs\.org/ },
  { library: 'd3', pattern: /d3js\.org/ },
  { library: 'handlebars', pattern: /handlebarsjs\.com|Handlebars\.registerHelper/ },
  { library: 'dompurify', pattern: /DOMPurify|dompurify/ },
  { library: 'core-js', pattern: /core-js|zloirock/ },
  { library: 'alpinejs', pattern: /Alpine\.(?:start|data)\(|alpinejs/ },
  { library: 'htmx', pattern: /htmx\.org/ },
  { library: 'next', pattern: /__NEXT_DATA__|next\/dist\/client/ },
  { library: 'select2', pattern: /select2\.org|\.select2\(/ },
  { library: 'slick-carousel', pattern: /slick-carousel|kenwheeler\.github\.io/ },
];

/**
 * Which libraries this content shows, in catalogue-stable order.
 *
 * The order is the signature-table order rather than match order, so the
 * evidence of two runs over the same bundle is byte-identical.
 */
export function detectLibraries(content: string): readonly string[] {
  return LIBRARY_SIGNATURES.filter((signature) => signature.pattern.test(content)).map(
    (signature) => signature.library,
  );
}
