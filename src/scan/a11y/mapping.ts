/**
 * axe rule IDs → catalogue IDs.
 *
 * This table is the whole reason the A11Y probe is boring. axe ships ~100 rules
 * and the catalogue publishes 13 A11Y IDs, so *something* has to decide which
 * axe rule means which stable finding. Doing it here — as data, in one place —
 * keeps two properties the contract depends on:
 *
 *  - **One axe rule maps to at most one catalogue ID.** Otherwise a single
 *    failing node would be counted twice and inflate `count`. Enforced by test.
 *  - **An unmapped rule is not silently dropped.** axe rules with no catalogue
 *    ID are reported inside `A11Y-MANUAL-REVIEW-PENDING` as `outside_catalog`,
 *    because "we saw it and we have no ID for it" is information, and inventing
 *    an ID would break the golden rule (spec §6).
 *
 * Emitting an unmapped rule under a made-up ID is not an option either: the
 * normalizer would reject it, which is correct but turns real signal into a
 * rejection line nobody reads.
 *
 * Coverage note: `color-contrast-enhanced` is deliberately absent. It is the AAA
 * rule, and `A11Y-CONTRAST-INSUFFICIENT` is defined against AA ("Contraste por
 * debajo de WCAG AA"); mapping it would fail sites that meet the standard we
 * actually audit against.
 */

export type A11yRuleMapping = {
  /** Published catalogue ID. Must be active — the normalizer rejects the rest. */
  readonly catalogId: string;
  /** axe rule IDs that, when violated, mean this catalogue finding. */
  readonly axeRules: readonly string[];
  /** What to do about it. Carried into the finding, so the report never guesses. */
  readonly remediation: string;
  /** Headline for findings that reach the report cover. */
  readonly title?: string;
};

/**
 * Order here is the emission order of the observations. The normalizer sorts the
 * findings anyway, so this only fixes the order of `raw/A11Y.json`, which is an
 * artifact people read.
 */
export const A11Y_RULE_MAPPINGS: readonly A11yRuleMapping[] = [
  {
    catalogId: 'A11Y-BUTTON-NAME-MISSING',
    // `aria-command-name` is the same defect on `role="button"`/`role="link"`
    // elements, which is what component libraries actually emit.
    axeRules: ['button-name', 'link-name', 'input-button-name', 'aria-command-name'],
    remediation:
      'Dar un nombre accesible a cada botón y enlace: texto visible, o aria-label si el control es solo un icono.',
    title: 'Hay controles sin nombre accesible: un lector de pantalla no puede anunciarlos',
  },
  {
    catalogId: 'A11Y-CONTRAST-INSUFFICIENT',
    axeRules: ['color-contrast'],
    remediation:
      'Subir la relación de contraste a 4.5:1 para texto normal y 3:1 para texto grande (WCAG 2.2 AA, 1.4.3).',
  },
  {
    catalogId: 'A11Y-IMG-ALT-MISSING',
    axeRules: [
      'image-alt',
      'input-image-alt',
      'area-alt',
      'role-img-alt',
      'svg-img-alt',
      'object-alt',
    ],
    remediation:
      'Añadir alt descriptivo a cada imagen informativa, o alt="" si la imagen es decorativa.',
  },
  {
    catalogId: 'A11Y-FORM-LABEL-MISSING',
    // `aria-input-field-name` / `aria-toggle-field-name` are the ARIA-widget form
    // of the same defect: a field the user cannot identify.
    axeRules: ['label', 'select-name', 'aria-input-field-name', 'aria-toggle-field-name'],
    remediation:
      'Asociar cada campo con un <label for> visible, o darle un nombre accesible con aria-label / aria-labelledby.',
  },
  {
    catalogId: 'A11Y-ARIA-INVALID',
    axeRules: [
      'aria-allowed-attr',
      'aria-allowed-role',
      'aria-braille-equivalent',
      'aria-conditional-attr',
      'aria-deprecated-role',
      'aria-dialog-name',
      'aria-hidden-body',
      'aria-hidden-focus',
      'aria-meter-name',
      'aria-progressbar-name',
      'aria-prohibited-attr',
      'aria-required-attr',
      'aria-required-children',
      'aria-required-parent',
      'aria-roles',
      'aria-text',
      'aria-tooltip-name',
      'aria-treeitem-name',
      'aria-valid-attr',
      'aria-valid-attr-value',
    ],
    remediation:
      'Corregir los roles y atributos ARIA señalados: usar un rol válido para el elemento y declarar los atributos que ese rol exige.',
  },
  {
    catalogId: 'A11Y-LANG-MISSING',
    axeRules: ['html-has-lang', 'html-lang-valid', 'html-xml-lang-mismatch', 'valid-lang'],
    remediation:
      'Declarar el idioma del documento en <html lang="es"> (o el que corresponda) y marcar con lang los fragmentos en otro idioma.',
  },
  {
    catalogId: 'A11Y-HEADING-ORDER',
    axeRules: ['heading-order'],
    remediation:
      'Encadenar los encabezados sin saltos (h1 → h2 → h3). Si el salto es por estética, cambiar el tamaño con CSS, no el nivel.',
  },
  {
    catalogId: 'A11Y-LANDMARKS-MISSING',
    axeRules: [
      'region',
      'landmark-one-main',
      'landmark-unique',
      'landmark-banner-is-top-level',
      'landmark-main-is-top-level',
      'landmark-contentinfo-is-top-level',
    ],
    remediation:
      'Envolver el contenido en landmarks: un único <main>, más <header>, <nav> y <footer> al nivel superior del documento.',
  },
];

/** The always-emitted finding. Not in the table above: no axe rule produces it. */
export const MANUAL_REVIEW_ID = 'A11Y-MANUAL-REVIEW-PENDING';

const BY_AXE_RULE: ReadonlyMap<string, A11yRuleMapping> = new Map(
  A11Y_RULE_MAPPINGS.flatMap((mapping) => mapping.axeRules.map((rule) => [rule, mapping] as const)),
);

/** The catalogue mapping for an axe rule, or `undefined` when we publish none. */
export function mappingForAxeRule(axeRule: string): A11yRuleMapping | undefined {
  return BY_AXE_RULE.get(axeRule);
}

/** Every axe rule this probe knows how to turn into a catalogue finding. */
export function mappedAxeRules(): readonly string[] {
  return [...BY_AXE_RULE.keys()];
}
