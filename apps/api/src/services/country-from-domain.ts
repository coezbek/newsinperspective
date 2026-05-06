/**
 * Lightweight, dependency-free country resolver for news domains.
 *
 * Three tiers, matching the v3 notebook's approach:
 *   1. Known source-name / domain dictionary (highest precision)
 *   2. Country-code TLD map (covers most international outlets)
 *   3. null (caller can decide what to do — typically "Unknown")
 *
 * IP geolocation is intentionally avoided: it returns server location,
 * not editorial origin (a CNN edge node in Frankfurt tells us nothing).
 */

const SOURCE_TO_COUNTRY: Record<string, string> = {
  // US
  "nytimes": "United States",
  "cnn": "United States",
  "fox news": "United States",
  "foxnews": "United States",
  "washington post": "United States",
  "washingtonpost": "United States",
  "npr": "United States",
  "politico": "United States",
  "the hill": "United States",
  "thehill": "United States",
  "axios": "United States",
  "bloomberg": "United States",
  "wall street journal": "United States",
  "wsj": "United States",
  "ap news": "United States",
  "apnews": "United States",
  "associated press": "United States",
  "usa today": "United States",
  "usatoday": "United States",
  "nbc news": "United States",
  "nbcnews": "United States",
  "abc news": "United States",
  "abcnews": "United States",
  "cbs news": "United States",
  "cbsnews": "United States",
  "msnbc": "United States",
  "newsweek": "United States",
  "the atlantic": "United States",
  "theatlantic": "United States",
  "vox": "United States",
  "buzzfeed": "United States",
  "huffpost": "United States",
  "huffingtonpost": "United States",
  "breitbart": "United States",
  "the new yorker": "United States",
  "newyorker": "United States",
  "time.com": "United States",
  "time magazine": "United States",
  "forbes": "United States",
  "business insider": "United States",
  "businessinsider": "United States",
  "cbssports": "United States",
  "9to5mac": "United States",
  "macrumors": "United States",
  "krdo": "United States",
  "pbs.org": "United States",
  "fortune.com": "United States",
  "fortune magazine": "United States",
  "foxsports": "United States",
  "dotesports": "United States",
  "sportsline": "United States",
  "operationsports": "United States",
  "borowitzreport": "United States",
  "the borowitz report": "United States",
  "rtvi": "United States",
  "national review": "United States",
  "nationalreview": "United States",
  "tomshardware": "United States",
  "tom's hardware": "United States",
  "the onion": "United States",
  "theonion": "United States",

  // UK
  "bbc": "United Kingdom",
  "the guardian": "United Kingdom",
  "theguardian": "United Kingdom",
  "guardian.co.uk": "United Kingdom",
  "the times": "United Kingdom",
  "thetimes": "United Kingdom",
  "thetimes.co.uk": "United Kingdom",
  "daily mail": "United Kingdom",
  "dailymail": "United Kingdom",
  "the telegraph": "United Kingdom",
  "thetelegraph": "United Kingdom",
  "telegraph.co.uk": "United Kingdom",
  "the independent": "United Kingdom",
  "theindependent": "United Kingdom",
  "independent.co.uk": "United Kingdom",
  "sky news": "United Kingdom",
  "skynews": "United Kingdom",
  "skysports": "United Kingdom",
  "financial times": "United Kingdom",
  "ft.com": "United Kingdom",
  "the economist": "United Kingdom",
  "economist.com": "United Kingdom",
  "the sun": "United Kingdom",
  "thesun.co.uk": "United Kingdom",
  "givemesport": "United Kingdom",
  "give me sport": "United Kingdom",
  "techradar": "United Kingdom",
  "gamesradar": "United Kingdom",
  "the national.scot": "United Kingdom",
  "thenational.scot": "United Kingdom",
  "intellinews": "United Kingdom",
  "bne intellinews": "United Kingdom",
  "time out": "United Kingdom",
  "timeout.com": "United Kingdom",
  "irish news": "United Kingdom",
  "irishnews": "United Kingdom",
  "daily mirror": "United Kingdom",
  "mirror.co.uk": "United Kingdom",
  "the spectator": "United Kingdom",
  "thespectator": "United Kingdom",
  "spectator.co.uk": "United Kingdom",
  "new statesman": "United Kingdom",
  "newstatesman": "United Kingdom",

  // Middle East
  "al jazeera": "Qatar",
  "aljazeera": "Qatar",
  "arab news": "Saudi Arabia",
  "arabnews": "Saudi Arabia",
  "jerusalem post": "Israel",
  "jpost": "Israel",
  "israel national news": "Israel",
  "israelnationalnews": "Israel",
  "arutz sheva": "Israel",
  "haaretz": "Israel",
  "times of israel": "Israel",
  "timesofisrael": "Israel",
  "ynet": "Israel",
  "middle east eye": "United Kingdom",
  "middleeasteye": "United Kingdom",
  "press tv": "Iran",
  "presstv": "Iran",
  "mehr news": "Iran",
  "tehran times": "Iran",
  "tehrantimes": "Iran",
  "al-monitor": "United States",
  "almonitor": "United States",
  "the national": "United Arab Emirates",
  "thenationalnews": "United Arab Emirates",
  "khaleej times": "United Arab Emirates",
  "khaleejtimes": "United Arab Emirates",
  "sky news arabia": "United Arab Emirates",
  "skynewsarabia": "United Arab Emirates",
  "times of oman": "Oman",
  "timesofoman": "Oman",
  "jordan times": "Jordan",
  "jordantimes": "Jordan",
  "arab times": "Kuwait",
  "arabtimesonline": "Kuwait",
  "manila times": "Philippines",
  "manilatimes": "Philippines",
  "times kuwait": "Kuwait",
  "timeskuwait": "Kuwait",
  "times now": "India",
  "timesnow": "India",
  "timesnownews": "India",
  "times colonist": "Canada",
  "timescolonist": "Canada",

  // China / East Asia
  "ming pao": "Hong Kong",
  "mingpao": "Hong Kong",
  "scmp": "Hong Kong",
  "south china morning post": "Hong Kong",
  "global times": "China",
  "globaltimes": "China",
  "xinhua": "China",
  "china daily": "China",
  "chinadaily": "China",
  "cgtn": "China",
  "people's daily": "China",
  "peoplesdaily": "China",
  "japan times": "Japan",
  "japantimes": "Japan",
  "nhk": "Japan",
  "asahi": "Japan",
  "yomiuri": "Japan",
  "mainichi": "Japan",
  "kyodo": "Japan",
  "korea herald": "South Korea",
  "koreaherald": "South Korea",
  "yonhap": "South Korea",
  "korea times": "South Korea",
  "koreatimes": "South Korea",
  "chosun": "South Korea",
  "joongang": "South Korea",
  "taipei times": "Taiwan",
  "taipeitimes": "Taiwan",
  "focus taiwan": "Taiwan",
  "channel news asia": "Singapore",
  "channelnewsasia": "Singapore",
  "straits times": "Singapore",
  "straitstimes": "Singapore",

  // Turkey (entries here so they win against LLM "rt-prefix → Russia" hallucinations)
  "trthaber": "Turkey",
  "haberturk": "Turkey",
  "artigercek": "Turkey",
  "birgun": "Turkey",
  "haber7": "Turkey",
  "gazeteoksijen": "Turkey",
  // Bulgaria (Standart News etc.)
  "standartnews": "Bulgaria",
  // Bosnia and Herzegovina
  "rtrs": "Bosnia and Herzegovina",
  // Montenegro (Radio Television of Montenegro)
  "rtcg": "Montenegro",
  // Malta
  "times of malta": "Malta",
  "timesofmalta": "Malta",
  // Russia / FSU
  "rt.com": "Russia",
  "russia today": "Russia",
  "sputnik": "Russia",
  "tass": "Russia",
  "interfax": "Russia",
  "moscow times": "Russia",
  "moscowtimes": "Russia",
  "kyiv independent": "Ukraine",
  "kyivindependent": "Ukraine",
  "kyiv post": "Ukraine",
  "kyivpost": "Ukraine",
  "ukrinform": "Ukraine",

  // Europe
  "le monde": "France",
  "lemonde": "France",
  "courrier international": "France",
  "courrierinternational": "France",
  "nouvelobs": "France",
  "bfmtv": "France",
  "reporterre": "France",
  "vert.eco": "France",
  "le figaro": "France",
  "lefigaro": "France",
  "liberation": "France",
  "france 24": "France",
  "france24": "France",
  "rfi": "France",
  "der spiegel": "Germany",
  "spiegel": "Germany",
  "dw": "Germany",
  "deutsche welle": "Germany",
  "die zeit": "Germany",
  "zeit": "Germany",
  "faz": "Germany",
  "süddeutsche": "Germany",
  "sueddeutsche": "Germany",
  "el pais": "Spain",
  "elpais": "Spain",
  "libertaddigital": "Spain",
  "libertad digital": "Spain",
  "el mundo": "Spain",
  "elmundo": "Spain",
  "abc.es": "Spain",
  "20minutos": "Spain",
  "ansa": "Italy",
  "corriere": "Italy",
  "corriere della sera": "Italy",
  "la repubblica": "Italy",
  "repubblica": "Italy",
  "la stampa": "Italy",
  "lastampa": "Italy",
  "nrc": "Netherlands",
  "de volkskrant": "Netherlands",
  "volkskrant": "Netherlands",
  "le soir": "Belgium",
  "lesoir": "Belgium",
  "rte": "Ireland",
  "irish times": "Ireland",
  "irishtimes": "Ireland",
  "the local": "Sweden",

  // South Asia
  "the hindu": "India",
  "thehindu": "India",
  "times of india": "India",
  "timesofindia": "India",
  "indiatimes": "India",
  "ndtv": "India",
  "hindustan times": "India",
  "hindustantimes": "India",
  "indian express": "India",
  "indianexpress": "India",
  "the print": "India",
  "theprint": "India",
  "the wire": "India",
  "thewire": "India",
  "dawn": "Pakistan",
  "the dawn": "Pakistan",
  "geo news": "Pakistan",
  "geonews": "Pakistan",
  "daily star": "Bangladesh",

  // Australia / NZ
  "abc.net.au": "Australia",
  "sciencealert": "Australia",
  "the conversation": "Australia",
  "theconversation": "Australia",
  "sydney morning herald": "Australia",
  "smh": "Australia",
  "the australian": "Australia",
  "theaustralian": "Australia",
  "the age": "Australia",
  "theage": "Australia",
  "news.com.au": "Australia",
  "stuff": "New Zealand",
  "nzherald": "New Zealand",

  // Canada
  "cbc": "Canada",
  "globe and mail": "Canada",
  "globeandmail": "Canada",
  "national post": "Canada",
  "nationalpost": "Canada",
  "toronto star": "Canada",
  "thestar": "Canada",

  // Latin America / Caribbean
  "diario libre": "Dominican Republic",
  "diariolibre": "Dominican Republic",
  // Argentina
  "clarin": "Argentina",
  "la nacion": "Argentina",
  "lanacion": "Argentina",
  "perfil.com": "Argentina",
  "infobae": "Argentina",
  "folha": "Brazil",
  "globo": "Brazil",
  "el universal": "Mexico",
  "eluniversal": "Mexico",
  "reforma": "Mexico",

  // Africa
  "daily nation": "Kenya",
  "nation": "Kenya",
  "daily maverick": "South Africa",
  "dailymaverick": "South Africa",
  "news24": "South Africa",
  "iol": "South Africa",
  "ahram": "Egypt",
  "al-ahram": "Egypt",
  "alahram": "Egypt",
  "tanzaniasports": "Tanzania",
  "the citizen": "Tanzania",

  // Pakistan
  "business recorder": "Pakistan",
  "brecorder": "Pakistan",
  "wccftech": "Pakistan",
  // Brazil
  "metropoles": "Brazil",
  // Egypt
  "egypt independent": "Egypt",
  "egyptindependent": "Egypt",
  // Palestine
  "shehab news": "Palestine",
  "shehabnews": "Palestine",
  // Spain (Madrid expansion.com to override LLM-Mexico)
  "expansion.com": "Spain",
  "expansion.es": "Spain",
  // Chile
  "el clarin chile": "Chile",
  "elclarin.cl": "Chile",
  // Algeria (Le Soir d'Algerie name collision with Belgian Le Soir)
  "le soir d'algerie": "Algeria",
  "lesoirdalgerie": "Algeria",
  "el watan": "Algeria",
  "elwatan": "Algeria",
  // Quebec (Le Soleil — collides with .com domain that the LLM placed in Senegal)
  "le soleil quebec": "Canada",
  "lesoleil.com": "Canada",
  // Wires / international
  "reuters": "United Kingdom",
  "afp": "France",
  "agence france-presse": "France",
};

const TLD_TO_COUNTRY: Record<string, string> = {
  "uk": "United Kingdom",
  "co.uk": "United Kingdom",
  "es": "Spain",
  "fr": "France",
  "de": "Germany",
  "au": "Australia",
  "com.au": "Australia",
  "ca": "Canada",
  "in": "India",
  "co.in": "India",
  "cn": "China",
  "com.cn": "China",
  "ru": "Russia",
  "jp": "Japan",
  "co.jp": "Japan",
  "br": "Brazil",
  "com.br": "Brazil",
  "it": "Italy",
  "nl": "Netherlands",
  "pl": "Poland",
  "se": "Sweden",
  "no": "Norway",
  "fi": "Finland",
  "dk": "Denmark",
  "ch": "Switzerland",
  "be": "Belgium",
  "at": "Austria",
  "pt": "Portugal",
  "gr": "Greece",
  "kr": "South Korea",
  "co.kr": "South Korea",
  "tw": "Taiwan",
  "com.tw": "Taiwan",
  "sg": "Singapore",
  "com.sg": "Singapore",
  "nz": "New Zealand",
  "co.nz": "New Zealand",
  "za": "South Africa",
  "co.za": "South Africa",
  "il": "Israel",
  "co.il": "Israel",
  "tr": "Turkey",
  "com.tr": "Turkey",
  "sa": "Saudi Arabia",
  "com.sa": "Saudi Arabia",
  "ae": "United Arab Emirates",
  "qa": "Qatar",
  "ng": "Nigeria",
  "com.ng": "Nigeria",
  "ke": "Kenya",
  "co.ke": "Kenya",
  "eg": "Egypt",
  "mx": "Mexico",
  "com.mx": "Mexico",
  "ar": "Argentina",
  "com.ar": "Argentina",
  "co": "Colombia",
  "ir": "Iran",
  "pk": "Pakistan",
  "com.pk": "Pakistan",
  "bd": "Bangladesh",
  "ua": "Ukraine",
  "hk": "Hong Kong",
  "com.hk": "Hong Kong",
  "ie": "Ireland",
  "cz": "Czech Republic",
  "ro": "Romania",
  "hu": "Hungary",
  "il.": "Israel",
  "al": "Albania",
  "ba": "Bosnia and Herzegovina",
  "bg": "Bulgaria",
  "hr": "Croatia",
  "lv": "Latvia",
  "lt": "Lithuania",
  "ee": "Estonia",
  "md": "Moldova",
  "mk": "North Macedonia",
  "rs": "Serbia",
  "sk": "Slovakia",
  "si": "Slovenia",
  "vn": "Vietnam",
  "com.vn": "Vietnam",
  "lk": "Sri Lanka",
  "my": "Malaysia",
  "com.my": "Malaysia",
  "ph": "Philippines",
  "com.ph": "Philippines",
  "th": "Thailand",
  "co.th": "Thailand",
  "id": "Indonesia",
  "co.id": "Indonesia",
  "me": "Montenegro",
  "ge": "Georgia",
  "am": "Armenia",
  "kz": "Kazakhstan",
  "uz": "Uzbekistan",
  "by": "Belarus",
  "is": "Iceland",
  "lu": "Luxembourg",
  "mt": "Malta",
  "li": "Liechtenstein",
  "cl": "Chile",
  "dz": "Algeria",
  "scot": "United Kingdom",
  "tz": "Tanzania",
  "co.tz": "Tanzania",
  "do": "Dominican Republic",
  "gh": "Ghana",
  "com.gh": "Ghana",
  "rw": "Rwanda",
  "co.rw": "Rwanda",
  "ma": "Morocco",
  "np": "Nepal",
  "lb": "Lebanon",
  "sn": "Senegal",
};

function normalizeDomain(domain: string): string {
  return domain.toLowerCase().trim().replace(/^www\./, "");
}

function extractTld(domain: string): string | null {
  const parts = normalizeDomain(domain).split(".");
  if (parts.length < 2) return null;
  // Try two-part suffix first (co.uk, com.au, etc.)
  if (parts.length >= 3) {
    const twoPart = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
    if (twoPart in TLD_TO_COUNTRY) return twoPart;
  }
  return parts[parts.length - 1] ?? null;
}

/**
 * Aggregators / social platforms / generic feed hosts. These domains carry
 * articles from many editorial origins — there's no single country we can
 * meaningfully attribute to them. We tag them as "Global" so downstream
 * code can either exclude them from country aggregations or render them
 * under a dedicated bucket.
 */
const GLOBAL_AGGREGATORS = new Set<string>([
  // News aggregators
  "news.google.com",
  "google.com",
  "news.yahoo.com",
  "yahoo.com",
  "msn.com",
  "bing.com",
  "ground.news",
  "smartnews.com",
  "flipboard.com",
  "feedburner.com",
  "drudgereport.com",
  "memeorandum.com",
  "techmeme.com",
  // Social platforms
  "reddit.com",
  "twitter.com",
  "x.com",
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "linkedin.com",
  "threads.net",
  "mastodon.social",
  "bsky.app",
  // Video / multimedia hosts
  "youtube.com",
  "youtu.be",
  "vimeo.com",
  "twitch.tv",
  // Reference / archives
  "archive.org",
  "web.archive.org",
  "wikipedia.org",
  "wikimedia.org",
  // Generic blog / publishing platforms (no editorial country)
  "medium.com",
  "substack.com",
  "wordpress.com",
  "blogspot.com",
  "tumblr.com",
  // Other neutral hosts
  "github.com",
  "stackoverflow.com",
  // Aggregator / non-editorial domains we don't want attributing to a country
  "ca.news.yahoo.com",
  "uk.news.yahoo.com",
  "chromewebdata",
  "tradingview.com",
  "seekingalpha.com",
  "investing.com",
  "playstation.com",
  "nintendo.com",
  "nasa.gov",
  "nhl.com",
  "thepwhl.com",
  // Geo-named content farms (not real local outlets)
  "beijingbulletin.com",
  "swedenherald.com",
]);

export function isGlobalAggregator(domain: string | null | undefined): boolean {
  if (!domain) return false;
  return GLOBAL_AGGREGATORS.has(normalizeDomain(domain));
}

/**
 * Match `key` against a domain *as a labelled segment*, not a raw substring.
 * "bbc" matches "bbc.com", "news.bbc.co.uk", and "bbc.co.uk", but does NOT
 * match "bbcamerica.com" or "skysports.com" (the old `String.includes()`
 * algorithm did, which produced cascading false-positives like
 * `skysports.com` → Russia via the key "rt").
 */
function domainMatchesKey(dom: string, key: string): boolean {
  if (!dom || !key) return false;
  if (dom === key) return true;
  if (dom.startsWith(`${key}.`)) return true;
  if (dom.endsWith(`.${key}`)) return true;
  if (dom.includes(`.${key}.`)) return true;
  return false;
}

/**
 * Word-boundary match for human-readable source names. The dict has both
 * "fox news" and "foxnews" keys so either form lands a hit.
 */
function nameMatchesKey(name: string, key: string): boolean {
  if (!name || !key) return false;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`).test(name);
}

export function resolveCountryFromDomain(
  domain: string | null | undefined,
  sourceName: string | null | undefined,
): string | null {
  const dom = domain ? normalizeDomain(domain) : "";
  const name = (sourceName ?? "").toLowerCase().trim();

  // Aggregators, social platforms, and other multi-origin hosts get a sentinel
  // "Global" bucket. They short-circuit ahead of dictionary/TLD matching.
  if (dom && GLOBAL_AGGREGATORS.has(dom)) return "Global";

  // Country-code TLD wins over the source-name dictionary. Reason: a paper
  // hosted at `.co.uk` / `.com.au` / `.fr` is editorially based in that
  // country, even when its sourceName collides with a famous outlet
  // elsewhere (e.g. `huffingtonpost.co.uk` is editorially UK, not US).
  if (dom) {
    const tld = extractTld(dom);
    if (tld && tld in TLD_TO_COUNTRY) return TLD_TO_COUNTRY[tld] ?? null;
  }

  // Fall through to source-name dictionary for generic TLDs (.com, .org, .net).
  for (const [key, country] of Object.entries(SOURCE_TO_COUNTRY)) {
    if (!key) continue;
    if (domainMatchesKey(dom, key) || nameMatchesKey(name, key)) return country;
  }

  return null;
}
