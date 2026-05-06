import { prisma } from "../lib/prisma.js";

/**
 * Country aliases for Kagi catalog category prefixes that don't match our
 * canonical names. Anything not listed here is rejected (so topical
 * categories like "AI", "Apple", "3D Printing" are ignored).
 */
const CATEGORY_ALIASES: Record<string, string> = {
  USA: "United States",
  UK: "United Kingdom",
  "Bosnia and Herzegovina": "Bosnia and Herzegovina",
  "Madeira Island": "Portugal",
  "Hong Kong": "Hong Kong",
  "Korea | South": "South Korea",
  "Korea | North": "North Korea",
};

/**
 * Categories that look like countries but should be treated as ambiguous
 * super-regions (Kagi puts "Asia" and "Africa" continent-wide feeds under
 * these). They don't carry a specific-country signal.
 */
const SUPER_REGIONS = new Set<string>([
  "Asia",
  "Africa",
  "Europe",
  "Middle East",
  "Latin America",
  "Caribbean",
  "Oceania",
  "Pacific",
]);

/**
 * Build a domain → country map from `FeedSource.category` joined to
 * `Article.domain`. For each domain, picks the most-common recognised
 * country across all its feed categories. Returns the most-common country
 * only if it has a strict plurality (≥ 60% of mentions).
 *
 * `knownCountries` is a set of canonical country names we already trust
 * (typically the union of TLD_TO_COUNTRY values + SOURCE_TO_COUNTRY values).
 */
export async function buildFeedCatalogCountryMap(
  knownCountries: Set<string>,
): Promise<Map<string, string>> {
  const rows = await prisma.$queryRaw<
    Array<{ domain: string; category: string; n: bigint }>
  >`
    SELECT a."domain"     AS domain,
           fs."category"  AS category,
           COUNT(*)::bigint AS n
    FROM   "Article" a
    JOIN   "FeedSource" fs ON fs."id" = a."feedSourceId"
    WHERE  fs."category" IS NOT NULL
    GROUP  BY a."domain", fs."category"
  `;

  const counts = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (!r.domain) continue;
    const prefix = r.category.split("|")[0]?.trim() ?? "";
    if (!prefix || SUPER_REGIONS.has(prefix)) continue;
    const country = CATEGORY_ALIASES[prefix] ?? prefix;
    if (!knownCountries.has(country)) continue;
    const inner = counts.get(r.domain) ?? new Map<string, number>();
    inner.set(country, (inner.get(country) ?? 0) + Number(r.n));
    counts.set(r.domain, inner);
  }

  const out = new Map<string, string>();
  for (const [domain, byCountry] of counts.entries()) {
    let total = 0;
    let bestCountry: string | null = null;
    let bestN = 0;
    for (const [country, n] of byCountry.entries()) {
      total += n;
      if (n > bestN) {
        bestN = n;
        bestCountry = country;
      }
    }
    if (bestCountry && total > 0 && bestN / total >= 0.6) {
      out.set(domain, bestCountry);
    }
  }
  return out;
}

/** Canonical country whitelist used to filter Kagi catalog category prefixes. */
export const KNOWN_COUNTRIES = new Set<string>([
  "Albania", "Algeria", "Argentina", "Armenia", "Australia", "Austria", "Azerbaijan",
  "Bangladesh", "Belarus", "Belgium", "Bolivia", "Bosnia and Herzegovina", "Brazil",
  "Bulgaria", "Cambodia", "Canada", "Chile", "China", "Colombia", "Costa Rica",
  "Croatia", "Cuba", "Cyprus", "Czech Republic", "Denmark", "Dominican Republic",
  "Ecuador", "Egypt", "Estonia", "Ethiopia", "Finland", "France", "Georgia",
  "Germany", "Ghana", "Greece", "Hong Kong", "Hungary", "Iceland", "India",
  "Indonesia", "Iran", "Iraq", "Ireland", "Israel", "Italy", "Japan", "Jordan",
  "Kazakhstan", "Kenya", "Kuwait", "Kyrgyzstan", "Latvia", "Lebanon", "Liechtenstein",
  "Lithuania", "Luxembourg", "Malaysia", "Malta", "Mexico", "Moldova", "Mongolia",
  "Montenegro", "Morocco", "Mozambique", "Netherlands", "New Zealand", "Nigeria",
  "North Korea", "North Macedonia", "Norway", "Oman", "Pakistan", "Panama",
  "Paraguay", "Peru", "Philippines", "Poland", "Portugal", "Qatar", "Romania",
  "Russia", "Saudi Arabia", "Serbia", "Singapore", "Slovakia", "Slovenia",
  "South Africa", "South Korea", "Spain", "Sri Lanka", "Sweden", "Switzerland",
  "Syria", "Taiwan", "Tajikistan", "Thailand", "Tunisia", "Turkey", "Turkmenistan",
  "Uganda", "Ukraine", "United Arab Emirates", "United Kingdom", "United States",
  "Uruguay", "Uzbekistan", "Venezuela", "Vietnam", "Yemen", "Zambia", "Zimbabwe",
]);
