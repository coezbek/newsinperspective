// Map of country names (as produced by the API's country resolver) to ISO-2
// codes. Used to render flag emoji next to countries in the perspective panel.
// Keep keys lowercase; lookups normalise input.
const NAME_TO_ISO2: Record<string, string> = {
  "albania": "AL",
  "algeria": "DZ",
  "argentina": "AR",
  "armenia": "AM",
  "australia": "AU",
  "austria": "AT",
  "bangladesh": "BD",
  "belarus": "BY",
  "belgium": "BE",
  "bosnia and herzegovina": "BA",
  "brazil": "BR",
  "bulgaria": "BG",
  "canada": "CA",
  "chile": "CL",
  "china": "CN",
  "colombia": "CO",
  "republic of the congo": "CG",
  "congo": "CG",
  "congo-brazzaville": "CG",
  "democratic republic of the congo": "CD",
  "dr congo": "CD",
  "drc": "CD",
  "congo-kinshasa": "CD",
  "croatia": "HR",
  "czech republic": "CZ",
  "czechia": "CZ",
  "denmark": "DK",
  "dominican republic": "DO",
  "egypt": "EG",
  "estonia": "EE",
  "finland": "FI",
  "france": "FR",
  "georgia": "GE",
  "germany": "DE",
  "ghana": "GH",
  "greece": "GR",
  "hong kong": "HK",
  "hungary": "HU",
  "iceland": "IS",
  "india": "IN",
  "indonesia": "ID",
  "iran": "IR",
  "ireland": "IE",
  "israel": "IL",
  "italy": "IT",
  "japan": "JP",
  "jordan": "JO",
  "kazakhstan": "KZ",
  "kenya": "KE",
  "kuwait": "KW",
  "latvia": "LV",
  "lebanon": "LB",
  "liechtenstein": "LI",
  "lithuania": "LT",
  "luxembourg": "LU",
  "malaysia": "MY",
  "malta": "MT",
  "mexico": "MX",
  "moldova": "MD",
  "montenegro": "ME",
  "morocco": "MA",
  "nepal": "NP",
  "netherlands": "NL",
  "new zealand": "NZ",
  "nigeria": "NG",
  "north macedonia": "MK",
  "norway": "NO",
  "oman": "OM",
  "pakistan": "PK",
  "palestine": "PS",
  "philippines": "PH",
  "poland": "PL",
  "portugal": "PT",
  "qatar": "QA",
  "romania": "RO",
  "russia": "RU",
  "rwanda": "RW",
  "saudi arabia": "SA",
  "senegal": "SN",
  "serbia": "RS",
  "singapore": "SG",
  "slovakia": "SK",
  "slovenia": "SI",
  "south africa": "ZA",
  "south korea": "KR",
  "korea, south": "KR",
  "korea": "KR",
  "spain": "ES",
  "sri lanka": "LK",
  "sweden": "SE",
  "switzerland": "CH",
  "taiwan": "TW",
  "tanzania": "TZ",
  "thailand": "TH",
  "turkey": "TR",
  "türkiye": "TR",
  "ukraine": "UA",
  "united arab emirates": "AE",
  "uae": "AE",
  "united kingdom": "GB",
  "uk": "GB",
  "great britain": "GB",
  "england": "GB",
  "united states": "US",
  "united states of america": "US",
  "usa": "US",
  "u.s.": "US",
  "u.s.a.": "US",
  "uzbekistan": "UZ",
  "vietnam": "VN",
};

export function countryIso2(name: string | null | undefined): string | null {
  if (!name) return null;
  return NAME_TO_ISO2[name.trim().toLowerCase()] ?? null;
}

export function countryFlag(name: string | null | undefined): string {
  const code = countryIso2(name);
  if (!code) return "";
  return String.fromCodePoint(
    ...code.toUpperCase().split("").map((c) => 0x1f1e6 - 65 + c.charCodeAt(0)),
  );
}

// ISO-2 → ISO-3166 numeric (UN M49). Used to align our country names with
// world-atlas TopoJSON, which keys countries by numeric code in `id`.
const ISO2_TO_M49: Record<string, string> = {
  AL: "008", DZ: "012", AR: "032", AM: "051", AU: "036", AT: "040",
  BD: "050", BY: "112", BE: "056", BA: "070", BR: "076", BG: "100",
  CA: "124", CL: "152", CN: "156", CO: "170", CG: "178", CD: "180", HR: "191", CZ: "203",
  DK: "208", DO: "214", EG: "818", EE: "233", FI: "246", FR: "250",
  GE: "268", DE: "276", GH: "288", GR: "300", HK: "344", HU: "348",
  IS: "352", IN: "356", ID: "360", IR: "364", IE: "372", IL: "376",
  IT: "380", JP: "392", JO: "400", KZ: "398", KE: "404", KW: "414",
  LV: "428", LB: "422", LI: "438", LT: "440", LU: "442", MY: "458",
  MT: "470", MX: "484", MD: "498", ME: "499", MA: "504", NP: "524",
  NL: "528", NZ: "554", NG: "566", MK: "807", NO: "578", OM: "512",
  PK: "586", PS: "275", PH: "608", PL: "616", PT: "620", QA: "634",
  RO: "642", RU: "643", RW: "646", SA: "682", SN: "686", RS: "688",
  SG: "702", SK: "703", SI: "705", ZA: "710", KR: "410", ES: "724",
  LK: "144", SE: "752", CH: "756", TW: "158", TZ: "834", TH: "764",
  TR: "792", UA: "804", AE: "784", GB: "826", US: "840", UZ: "860",
  VN: "704",
};

export function countryM49(name: string | null | undefined): string | null {
  const code = countryIso2(name);
  if (!code) return null;
  return ISO2_TO_M49[code] ?? null;
}

// PNG flag from flagcdn.com (https://flagcdn.com). `width` is the rendered px
// width; flagcdn serves common sizes (20, 40, 80, 160, 320, 640, 1280, 2560).
export function countryFlagUrl(
  name: string | null | undefined,
  width: 20 | 40 | 80 | 160 = 40,
): string | null {
  const code = countryIso2(name);
  if (!code) return null;
  return `https://flagcdn.com/w${width}/${code.toLowerCase()}.png`;
}
