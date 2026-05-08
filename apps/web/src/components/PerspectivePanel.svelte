<script lang="ts">
  /**
   * Tiny markdown renderer for the LLM narrative blocks.
   * Handles only what the model actually emits: paragraphs, ordered lists,
   * **bold**, *italic* / _italic_, inline `code`. HTML in the input is escaped
   * first so this is safe for `{@html}`.
   */
  function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    } as Record<string, string>)[ch]!);
  }

  function renderInline(text: string): string {
    let out = escapeHtml(text);
    out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
    out = out.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
    out = out.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");
    return out;
  }

  function renderMarkdown(input: string | null | undefined): string {
    if (!input) return "";
    const blocks = input.replace(/\r\n/g, "\n").trim().split(/\n{2,}/);
    type Kind = "ol" | "ul" | "p";
    type Block = { kind: Kind; items: string[] };
    const classified: Block[] = blocks
      .map((block) => block.trim())
      .filter((block) => block.length > 0)
      .map((block) => {
        const lines = block.split(/\n/);
        if (lines.every((line) => /^\s*\d+\.\s+/.test(line))) {
          return { kind: "ol" as const, items: lines.map((line) => line.replace(/^\s*\d+\.\s+/, "")) };
        }
        if (lines.every((line) => /^\s*[-*]\s+/.test(line))) {
          return { kind: "ul" as const, items: lines.map((line) => line.replace(/^\s*[-*]\s+/, "")) };
        }
        return { kind: "p" as const, items: [block.replace(/\n/g, " ")] };
      });

    // Merge consecutive list blocks of the same kind so e.g. "1. ...\n\n1. ..."
    // (which the LLM often emits as separate paragraphs) renders as one list.
    const merged: Block[] = [];
    for (const block of classified) {
      const last = merged[merged.length - 1];
      if (last && (block.kind === "ol" || block.kind === "ul") && last.kind === block.kind) {
        last.items.push(...block.items);
      } else {
        merged.push({ kind: block.kind, items: [...block.items] });
      }
    }

    return merged
      .map((block) => {
        if (block.kind === "p") return `<p>${renderInline(block.items[0])}</p>`;
        const items = block.items.map((item) => `<li>${renderInline(item)}</li>`).join("");
        return `<${block.kind}>${items}</${block.kind}>`;
      })
      .join("");
  }

  import { pickTopSourcesByExtremity } from "../lib/perspective-picker.js";
  import { countryFlagUrl } from "../lib/country-flag.js";
  import CountryMap from "./CountryMap.svelte";

  // Inject a flag image in front of bolded country names that the LLM
  // narratives put at the start of list items (e.g. "**United States (avg_…**").
  // Operates on the rendered HTML so it doesn't interfere with markdown parsing.
  function injectCountryFlags(html: string): string {
    return html.replace(
      /<strong>([^<(]+?)(?=\s*[(:—–-])/g,
      (match, name) => {
        const url = countryFlagUrl(name.trim(), 40);
        if (!url) return match;
        return `<img class="country-flag" src="${url}" alt="" loading="lazy" /> <strong>${name}`;
      },
    );
  }

  // Inject a favicon and wrap bolded source names in a link to the article so
  // editorial-angles narratives can be navigated. Mirrors injectCountryFlags
  // but reads from articlesBySource and produces an <a class="source-inline-link">.
  function injectSourceFavicons(html: string): string {
    if (!articlesBySource || articlesBySource.size === 0) return html;
    return html.replace(
      /<strong>([^<]+?)<\/strong>/g,
      (match, content: string) => {
        // The LLM tends to emit "**Source Name**" or "**Source Name (extra)**".
        // Pick the leading name segment up to the first delimiter.
        const lead = content.match(/^([^(:—–-]+?)(?:\s*[(:—–-].*)?$/);
        const name = (lead ? lead[1] : content).trim();
        const key = name.toLowerCase();
        const matches = articlesBySource.get(key) ?? articlesBySource.get(key.replace(/^the\s+/, ""));
        if (!matches || matches.length === 0) return match;
        const article = matches[0];
        const favicon = faviconUrl
          ? `<img class="source-inline-favicon" src="${faviconUrl(article.domain)}" alt="" loading="lazy" />`
          : "";
        if (articlePath) {
          const href = articlePath(article.id);
          return `${favicon}<a class="source-inline-link" href="${href}" data-article-id="${article.id}"><strong>${content}</strong></a>`;
        }
        return `${favicon}<strong>${content}</strong>`;
      },
    );
  }

  // Wrap inline domain references like "wsws.org" or "(scmp.com)" in the
  // narrative HTML with clickable links to the representative article from
  // that domain. Skips text already inside an <a>, <code>, or <strong> tag
  // (those are handled by `injectSourceFavicons`). Mirrors the structure of
  // the source-name injector but matches a domain regex instead.
  function injectSourceDomains(html: string): string {
    if (!articlesByDomain || articlesByDomain.size === 0) return html;
    // Match a plausible domain token NOT already wrapped in an anchor / code
    // / strong tag. We do the "not already wrapped" check by splitting on
    // tags and only transforming text segments.
    const replaceInText = (text: string): string => {
      return text.replace(
        /\b((?:[a-z0-9-]+\.)+[a-z]{2,})\b/gi,
        (match) => {
          const key = match.toLowerCase();
          const candidates = articlesByDomain.get(key) ?? articlesByDomain.get(key.replace(/^www\./, ""));
          if (!candidates || candidates.length === 0) return match;
          const article = candidates[0];
          if (!articlePath) return match;
          const href = articlePath(article.id);
          const favicon = faviconUrl
            ? `<img class="source-inline-favicon" src="${faviconUrl(article.domain)}" alt="" loading="lazy" />`
            : "";
          return `${favicon}${favicon ? "&nbsp;" : ""}<a class="source-inline-domain" href="${href}" data-article-id="${article.id}">${match}</a>`;
        },
      );
    };
    // Walk the HTML with a tag-aware splitter. Inside a tag, leave content
    // alone; outside, run the text replacer. Skip the contents of <a>, <code>,
    // and <strong> elements entirely.
    let out = "";
    let depth = 0; // nesting depth inside a no-touch element
    // Skip the contents of existing anchors (don't double-wrap) and code
    // spans (technical strings shouldn't be linkified). We DO process the
    // inside of <strong> tags since the LLM packs domain references like
    // "(wsws.org)" inside the bolded angle headlines.
    const skipTags = /^(?:a|code)$/i;
    const tokenRegex = /<\/?([a-z][a-z0-9-]*)(?:\s[^>]*)?>/gi;
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = tokenRegex.exec(html)) !== null) {
      const text = html.slice(last, match.index);
      out += depth > 0 ? text : replaceInText(text);
      const tag = match[0];
      const name = match[1] || "";
      out += tag;
      if (skipTags.test(name)) {
        if (tag.startsWith("</")) {
          depth = Math.max(0, depth - 1);
        } else if (!tag.endsWith("/>")) {
          depth += 1;
        }
      }
      last = tokenRegex.lastIndex;
    }
    const tail = html.slice(last);
    out += depth > 0 ? tail : replaceInText(tail);
    return out;
  }

  // Click delegate: the narrative HTML is rendered via {@html}, so Svelte's
  // event bindings don't attach. We catch clicks on injected source links and
  // route them through onNavigate for client-side navigation.
  function handleNarrativeClick(event: MouseEvent): void {
    const target = (event.target as HTMLElement | null)?.closest("a[data-article-id]") as HTMLAnchorElement | null;
    if (!target || !onNavigate) return;
    const href = target.getAttribute("href");
    if (!href) return;
    onNavigate(event, href);
  }

  interface DistinctiveWords {
    source_name: string;
    words: string[];
    scores: number[];
  }

  interface CountrySentiment {
    country: string;
    n_articles: number;
    avg_sentiment: number;
    sentiment_se: number;
    sentiment_label: "positive" | "neutral" | "negative";
    top_keywords?: string[];
  }

  interface DataQuality {
    n_articles_truncated_for_sentiment: number;
    sentiment_truncation_chars: number;
    n_articles_with_text: number;
  }

  interface Narrative {
    framingAngles: string | null;
    countryNarrative: string | null;
    model: string | null;
    generatedAt: string;
    error: string | null;
  }

  interface DivergenceThresholds {
    p25: number;
    p75: number;
    p90: number;
  }

  interface Perspective {
    cluster_id: string;
    n_articles: number;
    n_sources: number;
    n_countries: number;
    divergence_score: number | null;
    divergence_label: "low" | "moderate" | "high" | "very_high" | null;
    divergence_thresholds?: DivergenceThresholds;
    pairwise_distance: Record<string, Record<string, number>>;
    distinctive_words: DistinctiveWords[];
    country_sentiment: CountrySentiment[];
    sbert_model: string;
    sentiment_model: string;
    data_quality?: DataQuality | null;
    narrative?: Narrative | null;
  }

  interface ArticleRatings {
    leftRightLeaning: number | null;
    inclusiveness: number | null;
    factfulness: number | null;
    sentiment: number | null;
    simpleLanguage: number | null;
    multiFaceted: number | null;
    sourced: number | null;
    emotionalTone: number | null;
    constructiveness: number | null;
    overallStars: number | null;
  }

  interface ArticleRef {
    id: string;
    title?: string | null;
    sourceName: string;
    domain: string;
    url: string;
    hasFullText?: boolean;
    sentiment?: number | null;
    country?: string | null;
    ratings?: ArticleRatings | null;
  }

  type AxisKey =
    | "none"
    | "sbert"
    | "leftRightLeaning"
    | "inclusiveness"
    | "factfulness"
    | "sentiment"
    | "simpleLanguage"
    | "multiFaceted"
    | "sourced"
    | "emotionalTone"
    | "constructiveness"
    | "overallStars";

  // Order matters for menu rendering. Keep "None" last.
  const AXIS_OPTIONS: { key: AxisKey; label: string; hint: string }[] = [
    { key: "sbert", label: "SBERT framing distance", hint: "MDS projection of source embeddings" },
    { key: "leftRightLeaning", label: "Left ↔ Right", hint: "Political leaning, −10 left to +10 right" },
    { key: "inclusiveness", label: "Inclusiveness", hint: "Majority-only ↔ inclusive" },
    { key: "factfulness", label: "Fact ↔ Opinion", hint: "Opinion ↔ factual" },
    { key: "sentiment", label: "Sentiment", hint: "Negative ↔ positive" },
    { key: "simpleLanguage", label: "Language", hint: "Complex ↔ simple" },
    { key: "multiFaceted", label: "Viewpoints", hint: "Single ↔ diverse perspectives" },
    { key: "sourced", label: "Sourcing", hint: "Unsourced ↔ well-sourced" },
    { key: "emotionalTone", label: "Emotion", hint: "Detached ↔ charged" },
    { key: "constructiveness", label: "Constructive", hint: "Alarmist ↔ solutions" },
    { key: "overallStars", label: "Overall quality", hint: "0 to 5 stars" },
    { key: "none", label: "None", hint: "Hide this axis" },
  ];

  function axisLabelFor(key: AxisKey): string {
    return AXIS_OPTIONS.find((o) => o.key === key)?.label ?? key;
  }

  // Inner-margin applied to SBERT rank-transformed coords on both ends so the
  // extreme points get a bit of breathing room against the chart edges.
  const SBERT_AXIS_MARGIN = 0.06;

  function ratingNativeBounds(key: Exclude<AxisKey, "none" | "sbert">): { min: number; max: number; pad: number } {
    if (key === "overallStars") return { min: 0, max: 5, pad: 0.5 };
    return { min: -10, max: 10, pad: 1 };
  }

  // Choose ~3-7 integer-ish tickmarks across [min, max].
  function chooseTicks(min: number, max: number): number[] {
    const span = max - min;
    if (span <= 0) return [min];
    let step: number;
    if (span <= 6) step = 1;
    else if (span <= 12) step = 2;
    else step = 5;
    const ticks: number[] = [];
    const start = Math.ceil(min / step) * step;
    for (let v = start; v <= max + 1e-9; v += step) ticks.push(Math.round(v * 100) / 100);
    if (ticks[0] !== min) ticks.unshift(min);
    if (ticks[ticks.length - 1] !== max) ticks.push(max);
    const seen = new Set<number>();
    return ticks.filter((v) => (seen.has(v) ? false : (seen.add(v), true)));
  }

  // Per-axis observed value range across this cluster's articles, padded by ±1
  // (or ±0.5 for stars) and clamped to the native bounds. Stretches a tight
  // band like factfulness ∈ {+4, …, +7} across the whole axis instead of
  // crowding the right half.
  const observedRatingExtents = $derived.by<Map<string, { min: number; max: number; n: number }>>(() => {
    const out = new Map<string, { min: number; max: number; n: number }>();
    for (const a of articles) {
      const r = a.ratings;
      if (!r) continue;
      for (const k of Object.keys(r) as (keyof ArticleRatings)[]) {
        const v = r[k];
        if (typeof v !== "number") continue;
        const cur = out.get(k);
        if (!cur) out.set(k, { min: v, max: v, n: 1 });
        else {
          if (v < cur.min) cur.min = v;
          if (v > cur.max) cur.max = v;
          cur.n += 1;
        }
      }
    }
    return out;
  });

  function ratingDisplayRange(key: Exclude<AxisKey, "none" | "sbert">): { min: number; max: number } {
    const native = ratingNativeBounds(key);
    const obs = observedRatingExtents.get(key);
    if (!obs || obs.n === 0) return { min: native.min, max: native.max };
    let lo = Math.max(native.min, obs.min - native.pad);
    let hi = Math.min(native.max, obs.max + native.pad);
    const minSpan = native.pad * 2;
    if (hi - lo < minSpan) {
      const mid = (lo + hi) / 2;
      lo = Math.max(native.min, mid - minSpan / 2);
      hi = Math.min(native.max, mid + minSpan / 2);
    }
    if (hi <= lo) return { min: native.min, max: native.max };
    return { min: lo, max: hi };
  }

  function normalizeRating(value: number, key: Exclude<AxisKey, "none" | "sbert">): number {
    const r = ratingDisplayRange(key);
    return Math.max(0, Math.min(1, (value - r.min) / (r.max - r.min)));
  }

  // Pole labels + tickmarks for each axis. SBERT MDS coords are rank-transformed
  // into [0, 1] and have no semantic poles, so we show neutral hints + quartile
  // ticks. Rating axes get domain-specific poles and ticks across the *observed*
  // range so the data fills the axis.
  interface AxisMeta {
    leftLabel: string;
    rightLabel: string;
    ticks: { pos: number; label: string }[];
  }
  function axisMetaFor(key: AxisKey): AxisMeta | null {
    if (key === "none") return null;
    if (key === "sbert") {
      const m = SBERT_AXIS_MARGIN;
      return {
        leftLabel: "←",
        rightLabel: "→",
        ticks: [0, 0.25, 0.5, 0.75, 1].map((pos) => ({
          pos: m + pos * (1 - 2 * m),
          label: "",
        })),
      };
    }
    const poles: Record<string, [string, string]> = {
      leftRightLeaning: ["Left", "Right"],
      inclusiveness: ["Majority-only", "Inclusive"],
      factfulness: ["Opinion", "Factual"],
      sentiment: ["Negative", "Positive"],
      simpleLanguage: ["Complex", "Simple"],
      multiFaceted: ["Single", "Diverse"],
      sourced: ["Unsourced", "Well-sourced"],
      emotionalTone: ["Detached", "Charged"],
      constructiveness: ["Alarmist", "Solutions"],
      overallStars: ["0★", "5★"],
    };
    const [l, r] = poles[key] ?? ["", ""];
    const range = ratingDisplayRange(key);
    const tickValues = chooseTicks(range.min, range.max);
    const span = range.max - range.min || 1;
    const ticks = tickValues.map((v) => ({
      pos: (v - range.min) / span,
      label: Number.isInteger(v) ? String(v) : v.toFixed(1),
    }));
    return { leftLabel: l, rightLabel: r, ticks };
  }

  // Static fallback for the divergence thresholds — only used if the server
  // didn't return divergence_thresholds in the perspective payload. The live
  // values come from the perspective-calibration row in the DB.
  const FALLBACK_THRESHOLDS = { p25: 0.08, p75: 0.15, p90: 0.25 };

  interface Props {
    clusterId: string;
    apiBase: string;
    articles?: ArticleRef[];
    articlePath?: (id: string) => string;
    comparePath?: (aId: string, bId: string) => string;
    tagPath?: (keyword: string) => string;
    onNavigate?: (event: MouseEvent, path: string) => void;
    faviconUrl?: (domain: string) => string;
    onFaviconError?: (event: Event) => void;
  }

  let {
    clusterId,
    apiBase,
    articles = [],
    articlePath,
    comparePath,
    tagPath,
    onNavigate,
    faviconUrl,
    onFaviconError,
  }: Props = $props();

  let data = $state<Perspective | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let lastClusterId: string | null = null;

  const articlesBySource = $derived.by(() => {
    const map = new Map<string, ArticleRef[]>();
    for (const a of articles) {
      const key = (a.sourceName || a.domain || "").toLowerCase();
      if (!key) continue;
      const list = map.get(key) ?? [];
      list.push(a);
      map.set(key, list);
    }
    return map;
  });

  // Domain → article lookup, used by `injectSourceDomains` to turn bare /
  // parenthesised domain references the LLM emits inline (e.g. "wsws.org",
  // "(scmp.com)") into clickable article links. Indexed both with and
  // without the leading "www." so either spelling matches.
  const articlesByDomain = $derived.by(() => {
    const map = new Map<string, ArticleRef[]>();
    for (const a of articles) {
      const dom = (a.domain || "").toLowerCase();
      if (!dom) continue;
      const list = map.get(dom) ?? [];
      list.push(a);
      map.set(dom, list);
      const stripped = dom.replace(/^www\./, "");
      if (stripped !== dom) {
        const list2 = map.get(stripped) ?? [];
        list2.push(a);
        map.set(stripped, list2);
      }
    }
    return map;
  });

  // Sources that have at least one article with extracted body text. Sources
  // without text get filtered out of the heatmap/axis because the SBERT
  // distance matrix is degenerate for them (and we already exclude them from
  // sentiment/distinctive-words for the same reason).
  const sourcesWithText = $derived.by(() => {
    const set = new Set<string>();
    for (const a of articles) {
      if (!a.hasFullText) continue;
      const key = a.sourceName || "";
      if (key) set.add(key);
    }
    return set;
  });

  function hasText(sourceName: string): boolean {
    if (sourcesWithText.size === 0) return true; // no signal — keep everything
    return sourcesWithText.has(sourceName);
  }

  function articlesForSource(sourceName: string): ArticleRef[] {
    return articlesBySource.get(sourceName.toLowerCase()) ?? [];
  }

  function representativeArticleId(sourceName: string): string | null {
    return articlesForSource(sourceName)[0]?.id ?? null;
  }

  // Mean cosine distance from each source to every other source in this
  // cluster's pairwise matrix. The diagonal of the heatmap shows this value
  // (replaces the previous mean-sentiment readout, which was almost always
  // ~0 because article-level sentiment is calibrated to be neutral). It also
  // feeds the "Most unique" / "Most encompassing" picks in the framing
  // divergence card. Indexed by sourceName for O(1) lookup.
  const sourceMeanDistances = $derived.by<Map<string, number>>(() => {
    const out = new Map<string, number>();
    const matrix = data?.pairwise_distance ?? {};
    const sources = Object.keys(matrix).filter(hasText);
    if (sources.length < 2) return out;
    const counts = new Map<string, number>();
    for (const a of articles) {
      const k = a.sourceName || a.domain || "";
      if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const ranked = pickTopSourcesByExtremity({
      matrix,
      sources,
      articleCounts: counts,
      n: sources.length,
    });
    for (const r of ranked) out.set(r.sourceName, r.meanDistance);
    return out;
  });

  // Highest- and lowest-mean-distance sources in the cluster — the source
  // whose framing diverges most from everyone else (Most unique) and the
  // one closest to the cluster centroid (Most encompassing). null when the
  // matrix is too small to be meaningful.
  type ExtremePick = {
    sourceName: string;
    meanDistance: number;
    articleId: string | null;
    domain: string;
    title: string | null;
  };
  const extremeSources = $derived.by<{
    mostUnique: ExtremePick | null;
    median: ExtremePick | null;
    mostEncompassing: ExtremePick | null;
  }>(() => {
    if (sourceMeanDistances.size < 2) {
      return { mostUnique: null, median: null, mostEncompassing: null };
    }
    // Sort sources ascending by mean distance. Tie-break by source name so the
    // median pick stays stable across renders when several sources tie.
    const sorted = [...sourceMeanDistances.entries()].sort((a, b) => {
      if (a[1] !== b[1]) return a[1] - b[1];
      return a[0].localeCompare(b[0]);
    });
    const low = sorted[0];
    const high = sorted[sorted.length - 1];
    // Median: middle entry for odd counts, lower-middle for even counts.
    // We pick a real source (not the interpolated value) so the rendered
    // designation can link to a representative article.
    const medianIdx = Math.floor((sorted.length - 1) / 2);
    const mid = sorted[medianIdx];
    const enrich = (entry: [string, number] | undefined): ExtremePick | null => {
      if (!entry) return null;
      const [sourceName, meanDistance] = entry;
      const list = articlesForSource(sourceName);
      const first = list[0];
      return {
        sourceName,
        meanDistance,
        articleId: first?.id ?? null,
        domain: first?.domain ?? "",
        title: first?.title ?? null,
      };
    };
    const mostUnique = enrich(high);
    const mostEncompassing = enrich(low);
    let median = enrich(mid);
    // Suppress the median pick when it would duplicate either extreme —
    // happens for clusters with only 2-3 sources where the "middle" IS
    // already one of the ends.
    if (
      median &&
      (median.sourceName === mostUnique?.sourceName ||
        median.sourceName === mostEncompassing?.sourceName)
    ) {
      median = null;
    }
    return { mostUnique, median, mostEncompassing };
  });

  function handleCompareClick(event: MouseEvent, aId: string, bId: string): void {
    if (!comparePath) return;
    if (onNavigate) {
      onNavigate(event, comparePath(aId, bId));
    }
  }

  function handleSourceClick(event: MouseEvent, articleId: string): void {
    if (!articlePath) return;
    const path = articlePath(articleId);
    if (onNavigate) {
      onNavigate(event, path);
    }
  }

  interface AxisPoint {
    sourceName: string;
    domain: string;
    articleId: string;
    articleCount: number;
    x: number; // [0, 1] normalised position
    y?: number; // [0, 1] only set for 2D layout
  }

  /**
   * Classical multidimensional scaling.
   * Returns one or two coordinate arrays, scaled by sqrt(eigenvalue).
   * Uses power iteration for top eigenvectors of B = -1/2 J D² J.
   */
  function classicalMds(D: number[][], dims: 1 | 2): number[][] {
    const n = D.length;
    if (n === 0) return Array.from({ length: dims }, () => []);
    if (n === 1) return Array.from({ length: dims }, () => [0]);

    const d2 = D.map((row) => row.map((v) => v * v));
    const rowMeans = d2.map((row) => row.reduce((a, b) => a + b, 0) / n);
    const colMeans = Array.from({ length: n }, (_, j) =>
      d2.reduce((sum, row) => sum + (row[j] ?? 0), 0) / n,
    );
    const grandMean = rowMeans.reduce((a, b) => a + b, 0) / n;
    const B: number[][] = d2.map((row, i) =>
      row.map((v, j) => -0.5 * (v - (rowMeans[i] ?? 0) - (colMeans[j] ?? 0) + grandMean)),
    );

    function multiply(M: number[][], v: number[]): number[] {
      return Array.from({ length: n }, (_, i) =>
        (M[i] ?? []).reduce((sum, val, j) => sum + val * (v[j] ?? 0), 0),
      );
    }

    function topEigen(M: number[][]): { vec: number[]; lambda: number } {
      let v = Array.from({ length: n }, (_, i) => Math.cos(i * 1.7) + 0.01);
      for (let iter = 0; iter < 400; iter += 1) {
        const Mv = multiply(M, v);
        const norm = Math.sqrt(Mv.reduce((s, x) => s + x * x, 0));
        if (norm < 1e-12) break;
        const next = Mv.map((x) => x / norm);
        const delta = next.reduce((s, x, i) => s + Math.abs(x - (v[i] ?? 0)), 0);
        v = next;
        if (delta < 1e-9) break;
      }
      const Mv = multiply(M, v);
      const eig = v.reduce((s, x, i) => s + x * (Mv[i] ?? 0), 0);
      return { vec: v, lambda: Math.sqrt(Math.max(0, eig)) };
    }

    const first = topEigen(B);
    const coord1 = first.vec.map((x) => x * first.lambda);
    if (dims === 1) return [coord1];

    // Deflate B by subtracting λ·vvᵀ to find the second eigenvector.
    const deflated: number[][] = B.map((row, i) =>
      row.map((val, j) => val - first.lambda * first.lambda * (first.vec[i] ?? 0) * (first.vec[j] ?? 0)),
    );
    const second = topEigen(deflated);
    const coord2 = second.vec.map((x) => x * second.lambda);
    return [coord1, coord2];
  }

  // Axis selections. X defaults to SBERT; Y default keys off cluster size
  // (matching the previous heuristic where small clusters fell back to 1D).
  // Once the user picks anything from the menu we stop overriding their choice.
  let xAxis = $state<AxisKey>("sbert");
  let yAxis = $state<AxisKey>("sbert");
  let xUserSet = $state(false);
  let yUserSet = $state(false);

  $effect(() => {
    if (!data) return;
    if (!yUserSet) {
      yAxis = data.n_articles > 10 ? "sbert" : "none";
    }
  });

  const useScatter2D = $derived(xAxis !== "none" && yAxis !== "none");

  // Per-source SBERT MDS coordinates, computed only when at least one axis
  // requires SBERT. Returns coord-1 in `x`, coord-2 in `y` (only filled when
  // both axes use SBERT, so the user can compare two SBERT dimensions).
  const sbertCoords = $derived.by<{ x: Map<string, number>; y: Map<string, number> } | null>(() => {
    if (!data) return null;
    if (xAxis !== "sbert" && yAxis !== "sbert") return null;
    const matrix = data.pairwise_distance ?? {};
    const sourcesArr = Object.keys(matrix).filter(hasText);
    if (sourcesArr.length < 2) return null;
    const D = sourcesArr.map((a) =>
      sourcesArr.map((b) => (a === b ? 0 : matrix[a]?.[b] ?? matrix[b]?.[a] ?? 0)),
    );
    const dims: 1 | 2 = xAxis === "sbert" && yAxis === "sbert" ? 2 : 1;
    const coords = classicalMds(D, dims);
    // Inset rank-transformed coords so the extreme rank-0 / rank-(n-1) points
    // don't sit flush against the chart edges.
    const inset = (vs: number[]): number[] => vs.map((v) => SBERT_AXIS_MARGIN + v * (1 - 2 * SBERT_AXIS_MARGIN));
    const c0 = inset(rankTransform(coords[0] ?? []));
    const c1 = dims === 2 ? inset(rankTransform(coords[1] ?? [])) : null;
    const xMap = new Map<string, number>();
    const yMap = new Map<string, number>();
    sourcesArr.forEach((s, i) => {
      // Whichever axis(es) selected SBERT, route coord-0 to that axis.
      // When both, coord-0 → X, coord-1 → Y.
      if (xAxis === "sbert" && yAxis === "sbert") {
        xMap.set(s, c0[i] ?? 0.5);
        yMap.set(s, (c1 ? c1[i] : 0.5) ?? 0.5);
      } else if (xAxis === "sbert") {
        xMap.set(s, c0[i] ?? 0.5);
      } else {
        yMap.set(s, c0[i] ?? 0.5);
      }
    });
    return { x: xMap, y: yMap };
  });

  const scatterPoints = $derived.by<AxisPoint[]>(() => {
    if (!data || !faviconUrl) return [];
    if (xAxis === "none" && yAxis === "none") return [];

    const sourcesInMatrix = new Set(Object.keys(data.pairwise_distance ?? {}).filter(hasText));
    const needsSbert = xAxis === "sbert" || yAxis === "sbert";

    function coordFor(axis: AxisKey, article: ArticleRef, source: string, which: "x" | "y"): number | null {
      if (axis === "none") return 0.5;
      if (axis === "sbert") {
        if (!sbertCoords) return null;
        const map = which === "x" ? sbertCoords.x : sbertCoords.y;
        return map.get(source) ?? null;
      }
      const v = article.ratings?.[axis as keyof ArticleRatings];
      return typeof v === "number" ? normalizeRating(v, axis) : null;
    }

    const points: AxisPoint[] = [];
    // Per-source counts for tooltip badge (no longer used to pick sources, but
    // still useful as "this favicon represents 1 of N articles from source").
    const sourceCounts = new Map<string, number>();
    for (const a of articles) {
      const k = a.sourceName || a.domain || "";
      if (k) sourceCounts.set(k, (sourceCounts.get(k) ?? 0) + 1);
    }

    for (const a of articles) {
      const source = a.sourceName || a.domain || "";
      if (!source || !a.domain) continue;
      // SBERT axes only have coords for sources in the pairwise matrix.
      if (needsSbert && !sourcesInMatrix.has(source)) continue;
      const x = coordFor(xAxis, a, source, "x");
      if (x === null) continue;
      let y: number | null = null;
      if (yAxis !== "none") {
        y = coordFor(yAxis, a, source, "y");
        if (y === null) continue;
      }
      points.push({
        sourceName: source,
        domain: a.domain,
        articleId: a.id,
        articleCount: sourceCounts.get(source) ?? 1,
        x,
        ...(yAxis !== "none" && y !== null ? { y } : {}),
      });
    }

    if (points.length < 2) return [];
    return points;
  });

  // Bin scatter points that share a position (rating axes are integer-valued
  // so many articles land on the same coord) and spread bin members on a
  // small circle so favicons don't fully stack. Offsets are emitted in rem
  // units, consumed by CSS `--dx` / `--dy` translate variables on the marker.
  const scatterPointsSpread = $derived.by<(AxisPoint & { dx: number; dy: number })[]>(() => {
    const eps = 0.01;
    const buckets = new Map<string, AxisPoint[]>();
    for (const p of scatterPoints) {
      const kx = Math.round(p.x / eps);
      const ky = p.y === undefined ? 0 : Math.round(p.y / eps);
      const key = `${kx},${ky}`;
      const arr = buckets.get(key) ?? [];
      arr.push(p);
      buckets.set(key, arr);
    }
    const out: (AxisPoint & { dx: number; dy: number })[] = [];
    for (const arr of buckets.values()) {
      if (arr.length === 1) {
        out.push({ ...arr[0], dx: 0, dy: 0 });
        continue;
      }
      // Distribute across concentric rings; each ring's radius is the larger
      // of a base step and the no-overlap minimum derived from its slot count
      // (chord = 2·r·sin(π/n) ≥ markerWidth ⇒ r ≥ markerHalf / sin(π/n)).
      // Ring 0 takes up to 6 markers, each outer ring grows capacity by 4.
      // Phase-rotated by ring index so members don't align radially.
      const MARKER_HALF = 0.78; // rem; ~22px favicon half + a hair of slack
      const ringCounts: number[] = [];
      let remaining = arr.length;
      let rIdx = 0;
      while (remaining > 0) {
        const cap = rIdx === 0 ? 6 : 6 + rIdx * 4;
        const take = Math.min(remaining, cap);
        ringCounts.push(take);
        remaining -= take;
        rIdx += 1;
      }
      let i = 0;
      ringCounts.forEach((count, idx) => {
        const angularStep = Math.PI / Math.max(2, count);
        const minR = MARKER_HALF / Math.max(Math.sin(angularStep), 0.01);
        const baseR = 0.9 + idx * 1.6;
        const radius = Math.max(baseR, minR);
        for (let k = 0; k < count; k += 1) {
          const angle = (2 * Math.PI * k) / count + idx * 0.39;
          out.push({
            ...arr[i],
            dx: Math.cos(angle) * radius,
            dy: Math.sin(angle) * radius,
          });
          i += 1;
        }
      });
    }
    return out;
  });

  /**
   * Map each value to its rank / (n-1), producing a uniform [0, 1] distribution
   * along the axis. Preserves ordering, equalises density.
   */
  function rankTransform(values: number[]): number[] {
    const n = values.length;
    if (n === 0) return [];
    if (n === 1) return [0.5];
    const indexed = values.map((v, i) => ({ v, i }));
    indexed.sort((a, b) => a.v - b.v);
    const ranks = new Array<number>(n);
    indexed.forEach((entry, rank) => {
      ranks[entry.i] = rank / (n - 1);
    });
    return ranks;
  }

  interface HeatmapCell {
    a: string;
    b: string;
    value: number;
  }

  interface HeatmapData {
    sources: string[];
    rows: HeatmapCell[][];
    min: number;
    max: number;
  }

  function buildHeatmap(matrix: Record<string, Record<string, number>>, sources: string[]): HeatmapData {
    let min = Infinity;
    let max = -Infinity;
    const rows: HeatmapCell[][] = sources.map((a) =>
      sources.map((b) => {
        const v = a === b ? 0 : matrix[a]?.[b] ?? matrix[b]?.[a] ?? 0;
        if (a !== b) {
          if (v < min) min = v;
          if (v > max) max = v;
        }
        return { a, b, value: v };
      }),
    );
    if (!isFinite(min)) min = 0;
    if (!isFinite(max)) max = 1;
    return { sources, rows, min, max };
  }

  const heatmap = $derived.by<HeatmapData | null>(() => {
    if (!data) return null;
    const matrix = data.pairwise_distance ?? {};
    const all = Object.keys(matrix).filter(hasText);
    if (all.length < 2) return null;
    // Pick by extremity (mean distance to other sources), tie-break by
    // article count. Same picker as the source axis so the two views stay
    // consistent — and so wire services that frame neutrally don't crowd
    // the most-divergent ones out of the matrix.
    const counts = new Map<string, number>();
    for (const a of articles) counts.set(a.sourceName, (counts.get(a.sourceName) ?? 0) + 1);
    const ranked = pickTopSourcesByExtremity({
      matrix,
      sources: all,
      articleCounts: counts,
      n: 16,
    }).map((p) => p.sourceName);
    if (ranked.length < 2) return null;
    return buildHeatmap(matrix, ranked);
  });

  const thresholds = $derived(data?.divergence_thresholds ?? FALLBACK_THRESHOLDS);

  function classifyDistance(value: number): "low" | "moderate" | "high" | "very_high" {
    const t = thresholds;
    if (value < t.p25) return "low";
    if (value < t.p75) return "moderate";
    if (value < t.p90) return "high";
    return "very_high";
  }

  // Same palette as the divergence pill so cell colors share semantics with
  // the headline framing-divergence label.
  const DIVERGENCE_COLORS: Record<"low" | "moderate" | "high" | "very_high", { bg: string; fg: string }> = {
    low:       { bg: "#5a8a3a", fg: "#ffffff" },
    moderate:  { bg: "#c79728", fg: "#ffffff" },
    high:      { bg: "#c9523f", fg: "#ffffff" },
    very_high: { bg: "#8a2424", fg: "#ffffff" },
  };

  function heatStyle(value: number, isDiagonal: boolean): string {
    if (isDiagonal) return "background: #f4f4f4; color: transparent;";
    const tone = classifyDistance(value);
    const c = DIVERGENCE_COLORS[tone];
    return `background: ${c.bg}; color: ${c.fg};`;
  }

  function assignRows(points: AxisPoint[], minSpacing: number): Array<AxisPoint & { row: number }> {
    const sorted = [...points].sort((a, b) => a.x - b.x);
    const lastInRow: number[] = [];
    return sorted.map((p) => {
      let row = 0;
      while (row < lastInRow.length && (p.x - (lastInRow[row] ?? -1)) < minSpacing) {
        row += 1;
      }
      lastInRow[row] = p.x;
      return { ...p, row };
    });
  }

  $effect(() => {
    if (clusterId && clusterId !== lastClusterId) {
      lastClusterId = clusterId;
      data = null;
      error = null;
      xAxis = "sbert";
      yAxis = "sbert";
      xUserSet = false;
      yUserSet = false;
      xMenuOpen = false;
      yMenuOpen = false;
      void load(false);
    }
  });

  let xMenuOpen = $state(false);
  let yMenuOpen = $state(false);

  function selectAxis(which: "x" | "y", key: AxisKey): void {
    if (which === "x") {
      xAxis = key;
      xUserSet = true;
      xMenuOpen = false;
    } else {
      yAxis = key;
      yUserSet = true;
      yMenuOpen = false;
    }
  }

  function toggleMenu(which: "x" | "y", event: MouseEvent): void {
    event.stopPropagation();
    if (which === "x") {
      xMenuOpen = !xMenuOpen;
      yMenuOpen = false;
    } else {
      yMenuOpen = !yMenuOpen;
      xMenuOpen = false;
    }
  }

  // Close any open axis menu on outside click / Escape.
  $effect(() => {
    if (!xMenuOpen && !yMenuOpen) return;
    function handleDocClick(event: MouseEvent): void {
      const t = event.target as HTMLElement | null;
      if (!t || !t.closest(".axis-picker")) {
        xMenuOpen = false;
        yMenuOpen = false;
      }
    }
    function handleKey(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        xMenuOpen = false;
        yMenuOpen = false;
      }
    }
    document.addEventListener("click", handleDocClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("click", handleDocClick);
      document.removeEventListener("keydown", handleKey);
    };
  });

  async function load(refresh: boolean): Promise<void> {
    loading = true;
    error = null;
    try {
      const url = `${apiBase}/api/clusters/${encodeURIComponent(clusterId)}/perspective${refresh ? "?refresh=true" : ""}`;
      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.json().catch(() => ({ message: res.statusText }));
        throw new Error(body.message ?? `HTTP ${res.status}`);
      }
      data = (await res.json()) as Perspective;
    } catch (err) {
      error = err instanceof Error ? err.message : "Failed to load perspective";
    } finally {
      loading = false;
    }
  }

  function divergencePct(score: number | null): string {
    if (score === null) return "—";
    return score.toFixed(3);
  }

  function divergenceClass(label: string | null | undefined): string {
    return `divergence-pill divergence-${label ?? "na"}`;
  }

  function sentimentBarStyle(value: number): string {
    const pct = Math.min(100, Math.abs(value) * 100);
    const color = value > 0.05 ? "#2a7a3a" : value < -0.05 ? "#a33" : "#888";
    const side = value >= 0 ? "left" : "right";
    return `--bar-pct: ${pct}%; --bar-color: ${color}; --bar-side: ${side};`;
  }
</script>

<div class="perspective-stack" data-debug-component="PerspectivePanel">
{#if error}
    <p class="perspective-error">{error}</p>
  {/if}

  {#if loading && !data}
    <p class="perspective-loading">Loading perspective…</p>
  {:else if data}
    <div class="perspective-row perspective-row--top" data-debug-component="PerspectiveRowTop">
      <div class="perspective-block divergence-block" data-debug-component="DivergenceBlock">
        <h5>Framing divergence</h5>
        <div class="divergence-summary" data-debug-component="DivergenceSummary">
          <div class={divergenceClass(data.divergence_label)}>
            <span class="divergence-score">{divergencePct(data.divergence_score)}</span>
            <span class="divergence-sublabel">{data.divergence_label ?? "n/a"}</span>
          </div>
          <p class="perspective-meta">
            {data.n_articles} articles · {data.n_sources} sources · {data.n_countries} countries
          </p>
        </div>
        <p class="perspective-note">
          Mean cosine distance between sources, scaled to a percentile of all clusters analysed.
          Bands: low &lt; {thresholds.p25.toFixed(2)} · moderate &lt; {thresholds.p75.toFixed(2)} · high &lt; {thresholds.p90.toFixed(2)} · very high ≥ {thresholds.p90.toFixed(2)}.
        </p>
        {#if extremeSources.mostUnique && extremeSources.mostEncompassing && extremeSources.mostUnique.sourceName !== extremeSources.mostEncompassing.sourceName}
          <ul class="extreme-sources">
            {#each [
              { kind: "unique", label: "Most unique", entry: extremeSources.mostUnique, hint: "Frames the story most differently from the rest" },
              ...(extremeSources.median
                ? [{ kind: "median" as const, label: "The voice in the middle", entry: extremeSources.median, hint: "Median source by mean cosine distance to the rest of the cluster" }]
                : []),
              { kind: "encompassing", label: "Most encompassing", entry: extremeSources.mostEncompassing, hint: "Closest to the cluster's central framing" },
            ] as pick (pick.kind)}
              {@const e = pick.entry}
              <li class="extreme-source extreme-source--{pick.kind}" title={pick.hint}>
                <p class="extreme-source-eyebrow">{pick.label}</p>
                {#if e.title}
                  {#if e.articleId && articlePath}
                    <h6 class="extreme-source-title">
                      <a
                        class="extreme-source-title-link"
                        href={articlePath(e.articleId)}
                        onclick={(event) => handleSourceClick(event, e.articleId!)}
                      >{e.title}</a>
                    </h6>
                  {:else}
                    <h6 class="extreme-source-title">{e.title}</h6>
                  {/if}
                {/if}
                <p class="extreme-source-meta">
                  {#if e.domain && faviconUrl}
                    <img class="extreme-source-favicon" src={faviconUrl(e.domain)} alt="" loading="lazy" width="14" height="14" onerror={onFaviconError} />
                  {/if}
                  <span class="extreme-source-name">{e.sourceName}</span>
                  <span class="extreme-source-sep">·</span>
                  <span class="extreme-source-score">mean distance <strong>{e.meanDistance.toFixed(2)}</strong></span>
                </p>
              </li>
            {/each}
          </ul>
        {/if}
      </div>

      {#if heatmap}
        <div class="perspective-block" data-debug-component="HeatmapBlock">
          <h5>Pairwise distance matrix</h5>
          <p class="perspective-note">
            Cosine distance between mean source embeddings — top {heatmap.sources.length} most-divergent sources (mean distance to others). Cells colored by the global framing-divergence thresholds: low &lt; {thresholds.p25.toFixed(2)} · moderate &lt; {thresholds.p75.toFixed(2)} · high &lt; {thresholds.p90.toFixed(2)} · very high ≥ {thresholds.p90.toFixed(2)}. Range in cluster: {heatmap.min.toFixed(2)} – {heatmap.max.toFixed(2)}.
          </p>
          <div class="heatmap-wrap">
            <table class="heatmap" style="--n: {heatmap.sources.length}">
              <thead>
                <tr>
                  <th></th>
                  {#each heatmap.sources as s}
                    {@const colDom = articlesForSource(s)[0]?.domain ?? ""}
                    <th class="heatmap-col-label" title={s}>
                      {#if colDom && faviconUrl}
                        <img class="heatmap-favicon" src={faviconUrl(colDom)} alt={s} loading="lazy" width="16" height="16" onerror={onFaviconError} />
                      {:else}
                        <span class="heatmap-col-fallback">{s.slice(0, 2)}</span>
                      {/if}
                    </th>
                  {/each}
                </tr>
              </thead>
              <tbody>
                {#each heatmap.rows as row, i}
                  {@const rowDom = articlesForSource(heatmap.sources[i])[0]?.domain ?? ""}
                  <tr>
                    <th class="heatmap-row-label" title={heatmap.sources[i]}>
                      <span class="heatmap-row-name">{heatmap.sources[i]}</span>
                      {#if rowDom && faviconUrl}
                        <img class="heatmap-favicon" src={faviconUrl(rowDom)} alt="" loading="lazy" width="16" height="16" onerror={onFaviconError} />
                      {/if}
                    </th>
                    {#each row as cell, j}
                      {@const aId = i !== j ? representativeArticleId(cell.a) : null}
                      {@const bId = i !== j ? representativeArticleId(cell.b) : null}
                      {@const linkable = i !== j && aId && bId && comparePath}
                      {@const diagMean = i === j ? sourceMeanDistances.get(cell.a) ?? null : null}
                      {@const diagArticleId = i === j ? representativeArticleId(cell.a) : null}
                      {@const diagLinkable = i === j && diagArticleId && articlePath}
                      <td
                        class="heatmap-cell"
                        class:diagonal={i === j}
                        class:clickable={linkable || diagLinkable}
                        style={i === j
                          ? diagMean !== null
                            ? heatStyle(diagMean, false)
                            : "background: #f4f4f4; color: #aaa;"
                          : heatStyle(cell.value, false)}
                        title={i === j
                          ? diagMean !== null
                            ? `${cell.a} — mean distance to other sources ${diagMean.toFixed(3)} (${classifyDistance(diagMean)})`
                            : `${cell.a} — mean distance unavailable`
                          : linkable
                            ? `Compare ${cell.a} ↔ ${cell.b} (cosine ${cell.value.toFixed(3)}, ${classifyDistance(cell.value)})`
                            : `${cell.a} ↔ ${cell.b}: ${cell.value.toFixed(3)} (${classifyDistance(cell.value)})`}
                      >
                        {#if linkable}
                          <a
                            class="heatmap-cell-link"
                            href={comparePath!(aId!, bId!)}
                            onclick={(event) => handleCompareClick(event, aId!, bId!)}
                          >{cell.value.toFixed(2)}</a>
                        {:else if i !== j}
                          {cell.value.toFixed(2)}
                        {:else if diagLinkable && diagMean !== null}
                          <a
                            class="heatmap-cell-link"
                            href={articlePath!(diagArticleId!)}
                            onclick={(event) => handleSourceClick(event, diagArticleId!)}
                          >{diagMean.toFixed(2)}</a>
                        {:else if diagMean !== null}
                          {diagMean.toFixed(2)}
                        {/if}
                      </td>
                    {/each}
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </div>
      {/if}
    </div>

    {#if (scatterPoints.length >= 2 || xAxis === "none" && yAxis === "none") && faviconUrl}
      <div class="perspective-block" data-debug-component="SourcePositioningBlock">
        <h5>Source positioning</h5>
        <p class="perspective-note source-axis-help">
          One favicon per article. Pick a dimension for each axis: SBERT framing-distance (classical MDS of source embeddings), one of ten LLM-rated dimensions (each in [−10, +10] except overall stars in [0, 5]), or hide the axis. {useScatter2D ? "Both axes shown — closer points frame the story more similarly along both dimensions." : "Single axis shown — closer points frame the story more similarly along that dimension."}
        </p>

        {#if scatterPoints.length < 2}
          <p class="perspective-note">
            {xAxis === "none" && yAxis === "none"
              ? "Pick at least one dimension to plot."
              : "Not enough articles with the selected dimensions to plot."}
          </p>
          <div class="axis-picker-row">
            {#each [{ which: "x" as const, key: xAxis, open: xMenuOpen }, { which: "y" as const, key: yAxis, open: yMenuOpen }] as ax (ax.which)}
              <div class="axis-picker axis-picker--inline">
                <button
                  type="button"
                  class="axis-button"
                  aria-haspopup="menu"
                  aria-expanded={ax.open}
                  onclick={(event) => toggleMenu(ax.which, event)}
                >{ax.which.toUpperCase()}: {axisLabelFor(ax.key)} ▾</button>
                {#if ax.open}
                  <ul class="axis-menu" role="menu">
                    {#each AXIS_OPTIONS as opt}
                      <li>
                        <button
                          type="button"
                          class="axis-menu-item"
                          class:active={ax.key === opt.key}
                          onclick={() => selectAxis(ax.which, opt.key)}
                          title={opt.hint}
                        >{opt.label}</button>
                      </li>
                    {/each}
                  </ul>
                {/if}
              </div>
            {/each}
          </div>
        {:else if useScatter2D}
          {@const xMeta = axisMetaFor(xAxis)}
          {@const yMeta = axisMetaFor(yAxis)}
          <div class="scatter-frame">
            <div class="axis-side axis-side--y">
              {#if yMeta}<span class="axis-pole axis-pole--y-top">{yMeta.rightLabel}</span>{/if}
            <div class="axis-picker axis-picker--y">
              <button
                type="button"
                class="axis-button"
                aria-haspopup="menu"
                aria-expanded={yMenuOpen}
                onclick={(event) => toggleMenu("y", event)}
              >Y: {axisLabelFor(yAxis)} ▾</button>
              {#if yMenuOpen}
                <ul class="axis-menu" role="menu">
                  {#each AXIS_OPTIONS as opt}
                    <li>
                      <button
                        type="button"
                        class="axis-menu-item"
                        class:active={yAxis === opt.key}
                        onclick={() => selectAxis("y", opt.key)}
                        title={opt.hint}
                      >{opt.label}</button>
                    </li>
                  {/each}
                </ul>
              {/if}
            </div>
              {#if yMeta}<span class="axis-pole axis-pole--y-bottom">{yMeta.leftLabel}</span>{/if}
            </div>
            <div class="source-scatter">
              {#if yMeta}
                {#each yMeta.ticks as t}
                  <span class="axis-tick axis-tick--y" style="--y: {t.pos}">
                    {#if t.label}<span class="axis-tick-label">{t.label}</span>{/if}
                  </span>
                {/each}
              {/if}
              {#if xMeta}
                {#each xMeta.ticks as t}
                  <span class="axis-tick axis-tick--x" style="--x: {t.pos}">
                    {#if t.label}<span class="axis-tick-label">{t.label}</span>{/if}
                  </span>
                {/each}
              {/if}
              {#each scatterPointsSpread as p}
                <a
                  class="source-axis-marker scatter"
                  style="--x: {p.x}; --y: {p.y ?? 0.5}; --dx: {p.dx}rem; --dy: {p.dy}rem"
                  href={articlePath ? articlePath(p.articleId) : "#"}
                  onclick={(event) => p.articleId && handleSourceClick(event, p.articleId)}
                  title={`${p.sourceName} — ${p.articleCount} article${p.articleCount === 1 ? "" : "s"} from this source in cluster`}
                >
                  <img
                    class="source-axis-favicon"
                    src={faviconUrl(p.domain)}
                    alt={p.sourceName}
                    width="22"
                    height="22"
                    loading="lazy"
                    onerror={onFaviconError}
                  />
                </a>
              {/each}
            </div>
            <div class="axis-side axis-side--x">
              {#if xMeta}<span class="axis-pole axis-pole--x">{xMeta.leftLabel}</span>{/if}
            <div class="axis-picker axis-picker--x">
              <button
                type="button"
                class="axis-button"
                aria-haspopup="menu"
                aria-expanded={xMenuOpen}
                onclick={(event) => toggleMenu("x", event)}
              >X: {axisLabelFor(xAxis)} ▾</button>
              {#if xMenuOpen}
                <ul class="axis-menu" role="menu">
                  {#each AXIS_OPTIONS as opt}
                    <li>
                      <button
                        type="button"
                        class="axis-menu-item"
                        class:active={xAxis === opt.key}
                        onclick={() => selectAxis("x", opt.key)}
                        title={opt.hint}
                      >{opt.label}</button>
                    </li>
                  {/each}
                </ul>
              {/if}
            </div>
              {#if xMeta}<span class="axis-pole axis-pole--x">{xMeta.rightLabel}</span>{/if}
            </div>
          </div>
        {:else}
          {@const oneDKey = (xAxis !== "none" ? xAxis : yAxis) as AxisKey}
          {@const oneDMeta = axisMetaFor(oneDKey)}
          {@const oneDPoints = xAxis === "none" ? scatterPoints.map((p) => ({ ...p, x: p.y ?? 0.5 })) : scatterPoints}
          {@const placed = assignRows(oneDPoints, 0.04)}
          {@const rowCount = Math.max(...placed.map((p) => p.row)) + 1}
          <div class="source-axis source-axis--with-ticks" style="--row-count: {rowCount}">
            <div class="source-axis-line"></div>
            {#if oneDMeta}
              {#each oneDMeta.ticks as t}
                <span class="axis-tick axis-tick--x axis-tick--1d" style="--x: {t.pos}">
                  {#if t.label}<span class="axis-tick-label">{t.label}</span>{/if}
                </span>
              {/each}
              <span class="axis-pole axis-pole--1d-left">{oneDMeta.leftLabel}</span>
              <span class="axis-pole axis-pole--1d-right">{oneDMeta.rightLabel}</span>
            {/if}
            {#each placed as p}
              <a
                class="source-axis-marker"
                style="--x: {p.x}; --row: {p.row}"
                href={articlePath ? articlePath(p.articleId) : "#"}
                onclick={(event) => p.articleId && handleSourceClick(event, p.articleId)}
                title={`${p.sourceName} — ${p.articleCount} article${p.articleCount === 1 ? "" : "s"} from this source in cluster`}
              >
                <img
                  class="source-axis-favicon"
                  src={faviconUrl(p.domain)}
                  alt={p.sourceName}
                  width="22"
                  height="22"
                  loading="lazy"
                  onerror={onFaviconError}
                />
              </a>
            {/each}
          </div>
          <div class="axis-picker-row">
            {#each [{ which: "x" as const, key: xAxis, open: xMenuOpen }, { which: "y" as const, key: yAxis, open: yMenuOpen }] as ax (ax.which)}
              <div class="axis-picker axis-picker--inline">
                <button
                  type="button"
                  class="axis-button"
                  aria-haspopup="menu"
                  aria-expanded={ax.open}
                  onclick={(event) => toggleMenu(ax.which, event)}
                >{ax.which.toUpperCase()}: {axisLabelFor(ax.key)} ▾</button>
                {#if ax.open}
                  <ul class="axis-menu" role="menu">
                    {#each AXIS_OPTIONS as opt}
                      <li>
                        <button
                          type="button"
                          class="axis-menu-item"
                          class:active={ax.key === opt.key}
                          onclick={() => selectAxis(ax.which, opt.key)}
                          title={opt.hint}
                        >{opt.label}</button>
                      </li>
                    {/each}
                  </ul>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    <div class="perspective-row perspective-row--bottom" data-debug-component="PerspectiveRowBottom">
    {#if data.distinctive_words.length > 0}
      <div class="perspective-block" data-debug-component="DistinctiveWordsBlock">
        <h5>What each source emphasises</h5>
        <table class="distinctive-table">
          <thead>
            <tr><th>Source</th><th>Distinctive words</th></tr>
          </thead>
          <tbody>
            {#each data.distinctive_words as row}
              {@const matches = articlesForSource(row.source_name)}
              {@const sourceDom = matches[0]?.domain ?? ""}
              <tr>
                <td class="source-cell">
                  {#if sourceDom && faviconUrl}
                    <img
                      class="source-cell-favicon"
                      src={faviconUrl(sourceDom)}
                      alt=""
                      width="18"
                      height="18"
                      loading="lazy"
                      onerror={onFaviconError}
                    />
                  {/if}
                  {#if matches.length > 0 && articlePath}
                    <a
                      class="source-link"
                      href={articlePath(matches[0].id)}
                      onclick={(event) => handleSourceClick(event, matches[0].id)}
                      title={matches.length > 1 ? `${matches.length} articles from this source — jump to the first` : "Jump to article"}
                    >
                      {row.source_name}
                      {#if matches.length > 1}
                        <span class="source-count">({matches.length})</span>
                      {/if}
                    </a>
                  {:else}
                    {row.source_name}
                  {/if}
                </td>
                <td>
                  {#each row.words as word, i}
                    <span class="word-chip" title={`tf-idf ${row.scores[i]?.toFixed(3) ?? ""}`}>{word}</span>
                  {/each}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

    {#if data.country_sentiment.length > 0}
      <div class="perspective-block" data-debug-component="CountrySentimentBlock">
        <h5>Sentiment by country</h5>
        <ul class="country-list">
          {#each data.country_sentiment as c}
            <li>
              <span class="country-name">
                {#if countryFlagUrl(c.country)}
                  <img class="country-flag" src={countryFlagUrl(c.country, 40)} alt="" loading="lazy" />
                {/if}
                <span class="country-name-text">{c.country}</span>
                <span class="country-n">n={c.n_articles}</span>
              </span>
              <span class="country-bar" style={sentimentBarStyle(c.avg_sentiment)}>
                <span class="country-bar-fill"></span>
              </span>
              <span class="country-score">{c.avg_sentiment.toFixed(2)} ± {c.sentiment_se.toFixed(2)}</span>
            </li>
            {#if c.top_keywords && c.top_keywords.length > 0}
              <li class="country-keywords">
                {#each c.top_keywords as kw}
                  {#if tagPath}
                    <a
                      class="word-chip word-chip-link"
                      href={tagPath(kw)}
                      onclick={(event) => onNavigate && tagPath && onNavigate(event, tagPath(kw))}
                    >{kw}</a>
                  {:else}
                    <span class="word-chip">{kw}</span>
                  {/if}
                {/each}
              </li>
            {/if}
          {/each}
        </ul>
        <p class="perspective-note">
          Sentiment model is tweet-trained — interpret as directional, not absolute.
        </p>
      </div>
    {/if}
    </div>

    {#if data.narrative?.error}
      <div class="perspective-block" data-debug-component="NarrativeErrorBlock">
        <p class="perspective-error">{data.narrative.error}</p>
      </div>
    {/if}

    {#if data.narrative?.framingAngles || data.narrative?.countryNarrative}
      <div class="perspective-row perspective-row--narrative" data-debug-component="NarrativeRow">
        {#if data.narrative.framingAngles}
          <div class="perspective-block narrative-block" data-debug-component="EditorialAnglesBlock">
            <h5>Editorial angles</h5>
            <div class="narrative-body" onclick={handleNarrativeClick} data-debug-component="EditorialAnglesBody">{@html injectSourceDomains(injectSourceFavicons(renderMarkdown(data.narrative.framingAngles)))}</div>
          </div>
        {/if}
        {#if data.narrative.countryNarrative}
          <div class="perspective-block narrative-block" data-debug-component="NationalNarrativesBlock">
            <h5>National narratives</h5>
            <div class="narrative-body" onclick={handleNarrativeClick} data-debug-component="NationalNarrativesBody">{@html injectCountryFlags(renderMarkdown(data.narrative.countryNarrative))}</div>
          </div>
        {/if}
      </div>
      {#if data.narrative.model}
        <p class="perspective-note narrative-credit">Generated by {data.narrative.model}</p>
      {/if}
    {/if}

    {#if articles && articles.length > 0}
      <div class="perspective-block country-map-block" data-debug-component="CountryMapBlock">
        <CountryMap
          articles={articles.map((a) => ({ domain: a.domain, country: a.country ?? null }))}
        />
      </div>
    {/if}

    <p class="perspective-footer">
      SBERT: <code>{data.sbert_model}</code> · Sentiment: <code>{data.sentiment_model}</code>
      {#if data.data_quality}
        · {data.data_quality.n_articles_with_text} articles analysed
        {#if data.data_quality.n_articles_truncated_for_sentiment > 0}
          · {data.data_quality.n_articles_truncated_for_sentiment} truncated to {data.data_quality.sentiment_truncation_chars} chars for sentiment
        {/if}
      {/if}
    </p>
  {:else if !loading}
    <p class="perspective-loading">No perspective data yet.</p>
  {/if}
</div>

<style>
  .extreme-sources {
    margin: 0.85rem 0 0 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
  }
  .extreme-source {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    padding: 0.55rem 0.7rem 0.6rem;
    border: 1px solid var(--surface-border, #d6dde7);
    border-radius: 8px;
    background: var(--surface-soft, #f6f8fb);
    border-left-width: 3px;
  }
  .extreme-source--unique { border-left-color: #c0382b; }
  .extreme-source--median { border-left-color: #6b7280; }
  .extreme-source--encompassing { border-left-color: #2563eb; }
  .extreme-source-eyebrow {
    margin: 0;
    font-size: 0.7rem;
    line-height: 1;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted, #58708f);
    font-weight: 600;
  }
  .extreme-source-title {
    margin: 0.15rem 0 0.05rem;
    font-size: 0.95rem;
    line-height: 1.25;
    letter-spacing: -0.01em;
    font-weight: 600;
  }
  .extreme-source-title-link {
    color: inherit;
    text-decoration: none;
  }
  .extreme-source-title-link:hover { text-decoration: underline; }
  .extreme-source-meta {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 0.35rem;
    flex-wrap: wrap;
    font-size: 0.78rem;
    color: var(--muted, #58708f);
  }
  .extreme-source-favicon {
    width: 14px;
    height: 14px;
    border-radius: 2px;
    flex: none;
  }
  .extreme-source-name {
    font-weight: 500;
    color: inherit;
  }
  .extreme-source-sep {
    color: rgba(88, 112, 143, 0.5);
  }
  .extreme-source-score {
    font-variant-numeric: tabular-nums;
  }
  .extreme-source-score strong {
    font-weight: 600;
    color: inherit;
  }

  .perspective-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.75rem;
  }
  .perspective-header h4 {
    margin: 0;
    font-size: 1rem;
  }
  .refresh-btn {
    background: #fff;
    border: 1px solid #ccc;
    border-radius: 4px;
    padding: 0.25rem 0.6rem;
    font-size: 0.8rem;
    cursor: pointer;
  }
  .refresh-btn:disabled { opacity: 0.6; cursor: wait; }
  .perspective-summary { display: flex; align-items: center; gap: 1rem; margin-bottom: 1rem; }

  .perspective-stack {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .perspective-row {
    display: grid;
    grid-template-columns: 1fr;
    gap: 1rem;
  }

  @media (min-width: 880px) {
    .perspective-row {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      align-items: stretch;
    }
  }

  .divergence-block {
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
  }

  .divergence-summary {
    display: flex;
    align-items: center;
    gap: 0.9rem;
  }

  .divergence-pill {
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    padding: 0.5rem 0.9rem;
    border-radius: 8px;
    color: #fff;
    min-width: 5.5rem;
  }
  .divergence-pill.divergence-low { background: #5a8a3a; }
  .divergence-pill.divergence-moderate { background: #c79728; }
  .divergence-pill.divergence-high { background: #c9523f; }
  .divergence-pill.divergence-very_high { background: #8a2424; }
  .divergence-pill.divergence-na { background: #777; }
  .divergence-label { font-size: 0.7rem; opacity: 0.85; text-transform: uppercase; }
  .divergence-score { font-size: 1.4rem; font-weight: 600; line-height: 1.1; }
  .divergence-sublabel { font-size: 0.75rem; text-transform: capitalize; }
  .perspective-meta { color: #555; margin: 0; }
  .perspective-block {
    background: rgba(255, 255, 255, 0.85);
    border: 1px solid rgba(28, 46, 73, 0.1);
    border-radius: 12px;
    padding: 0.9rem 1rem;
    box-shadow: 0 1px 2px rgba(20, 55, 111, 0.04);
    overflow: hidden;
  }
  .perspective-block h5 { margin: 0 0 0.5rem; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.04em; color: #444; }
  .distinctive-table { width: 100%; border-collapse: collapse; }
  .distinctive-table th, .distinctive-table td { text-align: left; padding: 0.3rem 0.4rem; border-bottom: 1px solid #eee; vertical-align: top; }
  .source-cell { font-weight: 500; white-space: nowrap; }
  .source-cell-favicon {
    display: inline-block;
    vertical-align: -4px;
    width: 18px;
    height: 18px;
    margin-right: 6px;
    border-radius: 4px;
    object-fit: cover;
    background: #fff;
  }
  .country-flag {
    display: inline-block;
    width: 1.4em;
    height: auto;
    vertical-align: -0.2em;
    border-radius: 2px;
    box-shadow: 0 0 0 1px rgba(20, 32, 51, 0.08);
  }
  .narrative-body :global(.country-flag) {
    width: auto;
    height: 1em;
    margin-right: 0.3rem;
    vertical-align: -0.1em;
  }
  .narrative-body :global(.source-inline-favicon) {
    display: inline-block;
    width: 1em;
    height: 1em;
    margin-right: 0.3rem;
    vertical-align: -0.15em;
    border-radius: 3px;
    object-fit: cover;
    background: #fff;
  }
  .narrative-body :global(.source-inline-link) {
    color: inherit;
    text-decoration: none;
    border-bottom: 1px dotted rgba(10, 60, 150, 0.45);
  }
  .narrative-body :global(.source-inline-link:hover) {
    color: #0a3c96;
    border-bottom-color: currentColor;
  }
  .narrative-body :global(.source-inline-domain) {
    color: inherit;
    text-decoration: none;
    border-bottom: 1px dotted rgba(10, 60, 150, 0.45);
  }
  .narrative-body :global(.source-inline-domain:hover) {
    color: #0a3c96;
    border-bottom-color: currentColor;
  }
  .source-link { color: #1c4566; text-decoration: none; border-bottom: 1px dotted #9bb1c7; }
  .source-link:hover { color: #0a3c96; border-bottom-color: #0a3c96; }
  .source-count { color: #888; font-weight: 400; font-size: 0.75rem; margin-left: 0.2rem; }
  .source-axis-help { margin-bottom: 0.6rem; }
  .source-axis {
    position: relative;
    height: calc(2.6rem + var(--row-count, 1) * 2.4rem);
    margin: 0.4rem 4rem 1.5rem;
  }
  .source-axis--with-ticks { margin-bottom: 2.2rem; }
  .axis-tick--1d { top: calc(1.1rem - 3px); height: 6px; bottom: auto; }
  .axis-tick--1d .axis-tick-label {
    top: 10px;
    bottom: auto;
    transform: translateX(-50%);
  }
  .axis-pole--1d-left,
  .axis-pole--1d-right {
    position: absolute;
    bottom: -1.2rem;
    font-size: 0.7rem;
    color: var(--muted, #58708f);
  }
  .axis-pole--1d-left { left: 0; }
  .axis-pole--1d-right { right: 0; }
  .source-axis-line {
    position: absolute;
    left: 0; right: 0; top: 1.1rem;
    height: 2px;
    background: linear-gradient(to right, #b6c5d6, #b6c5d6);
    border-radius: 1px;
  }
  .source-axis-marker {
    position: absolute;
    left: calc(var(--x) * 100%);
    top: calc(var(--row, 0) * 2.4rem);
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    text-decoration: none;
    color: #34455d;
    font-size: 0.72rem;
    line-height: 1.1;
    max-width: 7rem;
  }
  .source-axis-marker::before {
    content: "";
    width: 1px;
    height: 0.5rem;
    background: #b6c5d6;
    margin-bottom: 2px;
  }
  .source-axis-favicon {
    border-radius: 4px;
    background: #fff;
    box-shadow: 0 1px 2px rgba(20, 55, 111, 0.18);
    border: 1px solid rgba(28, 46, 73, 0.12);
  }
  .source-axis-label {
    margin-top: 2px;
    text-align: center;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    width: 100%;
    color: #58708f;
  }
  .source-axis-marker:hover .source-axis-label { color: #0a3c96; }
  .source-axis-marker:hover .source-axis-favicon { box-shadow: 0 2px 6px rgba(10, 60, 150, 0.25); }
  .scatter-frame {
    display: grid;
    grid-template-columns: auto 1fr;
    grid-template-rows: 1fr auto;
    grid-template-areas:
      "ypick scatter"
      ".     xpick";
    column-gap: 0.5rem;
    row-gap: 0.4rem;
    margin: 0.4rem 0 1rem;
  }
  .axis-picker {
    position: relative;
    display: inline-flex;
  }
  .axis-picker--y { align-self: center; }
  .axis-picker--x { }
  .axis-picker--inline { display: inline-flex; }
  .axis-side--y {
    grid-area: ypick;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.4rem 0;
  }
  .axis-side--x {
    grid-area: xpick;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
    padding: 0 0.2rem;
  }
  .axis-pole {
    font-size: 0.68rem;
    color: var(--muted, #58708f);
    white-space: nowrap;
  }
  .axis-pole--y-top,
  .axis-pole--y-bottom {
    writing-mode: vertical-rl;
    transform: rotate(180deg);
    text-align: center;
  }
  .axis-tick {
    position: absolute;
    background: rgba(28, 46, 73, 0.4);
    pointer-events: none;
  }
  .axis-tick--x {
    bottom: 0;
    left: calc(var(--x) * 100%);
    width: 1px;
    height: 6px;
    transform: translateX(-50%);
  }
  .axis-tick--y {
    left: 0;
    top: calc((1 - var(--y)) * 100%);
    height: 1px;
    width: 6px;
    transform: translateY(-50%);
  }
  .axis-tick-label {
    position: absolute;
    font-size: 0.62rem;
    color: var(--muted, #58708f);
    background: rgba(255, 255, 255, 0.85);
    padding: 0 3px;
    border-radius: 2px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .axis-tick--x .axis-tick-label {
    bottom: 8px;
    left: 50%;
    transform: translateX(-50%);
  }
  .axis-tick--y .axis-tick-label {
    left: 8px;
    top: 50%;
    transform: translateY(-50%);
  }
  .axis-picker-row {
    display: flex;
    justify-content: center;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 0.4rem;
  }
  .axis-button {
    background: #fff;
    border: 1px solid var(--surface-border, #d6dde7);
    border-radius: 6px;
    padding: 0.25rem 0.6rem;
    font-size: 0.78rem;
    color: #34455d;
    cursor: pointer;
    white-space: nowrap;
  }
  .axis-button:hover { border-color: #0a3c96; color: #0a3c96; }
  .axis-picker--y .axis-button {
    writing-mode: vertical-rl;
    transform: rotate(180deg);
  }
  .axis-menu {
    position: absolute;
    z-index: 10;
    list-style: none;
    margin: 0;
    padding: 0.25rem 0;
    background: #fff;
    border: 1px solid var(--surface-border, #d6dde7);
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(20, 55, 111, 0.18);
    min-width: 14rem;
  }
  .axis-picker--y .axis-menu { top: 0; left: 100%; margin-left: 0.4rem; }
  .axis-picker--x .axis-menu { bottom: 100%; left: 50%; transform: translateX(-50%); margin-bottom: 0.4rem; }
  .axis-picker--inline .axis-menu { top: 100%; left: 50%; transform: translateX(-50%); margin-top: 0.4rem; }
  .axis-menu li { margin: 0; }
  .axis-menu-item {
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: 0;
    padding: 0.35rem 0.7rem;
    font-size: 0.8rem;
    color: #34455d;
    cursor: pointer;
  }
  .axis-menu-item:hover { background: #eef3f8; color: #0a3c96; }
  .axis-menu-item.active { background: #dde7f1; color: #0a3c96; font-weight: 600; }

  .source-scatter {
    grid-area: scatter;
    position: relative;
    height: 18rem;
    margin: 0;
    background:
      linear-gradient(to right, rgba(28, 46, 73, 0.04) 1px, transparent 1px) 0 0 / 25% 100%,
      linear-gradient(to bottom, rgba(28, 46, 73, 0.04) 1px, transparent 1px) 0 0 / 100% 25%,
      #fdfdfd;
    border: 1px solid #e5e8ec;
    border-radius: 4px;
  }
  .source-axis-marker.scatter {
    position: absolute;
    left: calc(var(--x) * 100%);
    top: calc((1 - var(--y)) * 100%);
    transform: translate(calc(-50% + var(--dx, 0rem)), calc(-50% + var(--dy, 0rem)));
    transition: transform 120ms ease;
  }
  .source-axis-marker.scatter:hover {
    z-index: 5;
    transform: translate(calc(-50% + var(--dx, 0rem)), calc(-50% + var(--dy, 0rem))) scale(1.15);
  }
  .source-axis-marker.scatter::before { display: none; }
  .heatmap-wrap { overflow: auto; padding-bottom: 0.4rem; max-height: 26rem; max-width: 100%; }
  .heatmap { border-collapse: separate; border-spacing: 1px; font-size: 0.68rem; table-layout: fixed; width: max-content; margin: 0 auto; }
  .heatmap th { font-weight: 500; color: #58708f; padding: 2px 4px; background: #fff; }
  .heatmap thead th { position: sticky; top: 0; z-index: 2; }
  .heatmap thead th:first-child { left: 0; z-index: 3; }
  .heatmap-col-label { height: 2rem; width: 2rem; text-align: center; vertical-align: middle; padding: 2px 0; }
  .heatmap-row-label { position: sticky; left: 0; z-index: 1; text-align: right; padding-right: 0.4rem; width: 11rem; max-width: 11rem; white-space: nowrap; }
  .heatmap-row-name { display: inline-block; max-width: 8.5rem; overflow: hidden; text-overflow: ellipsis; vertical-align: middle; }
  .heatmap-favicon { display: inline-block; width: 16px; height: 16px; border-radius: 3px; vertical-align: middle; margin-left: 4px; }
  .heatmap-col-label .heatmap-favicon { margin-left: 0; }
  .heatmap-col-fallback { display: inline-block; font-size: 0.7rem; color: #58708f; text-transform: uppercase; }
  .heatmap-cell { width: 2rem; height: 2rem; text-align: center; color: #34455d; font-variant-numeric: tabular-nums; border-radius: 2px; padding: 0; }
  .heatmap-cell.diagonal {
    font-weight: 600;
    box-shadow: inset 0 0 0 2px rgba(33, 47, 73, 0.55);
    border-radius: 4px;
  }
  .heatmap-cell.clickable { cursor: pointer; }
  .heatmap-cell.clickable:hover { outline: 2px solid #0a3c96; outline-offset: -1px; }
  .heatmap-cell-link {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    color: inherit;
    text-decoration: none;
  }
  .word-chip {
    display: inline-block;
    background: #eef3f8;
    color: #1c4566;
    padding: 0.1rem 0.45rem;
    border-radius: 999px;
    font-size: 0.78rem;
    margin: 0.1rem 0.2rem 0.1rem 0;
  }
  .word-chip-link { text-decoration: none; cursor: pointer; }
  .word-chip-link:hover { background: #dde7f1; color: #0a3c96; }
  .country-list { list-style: none; padding: 0; margin: 0; }
  .country-list li { display: grid; grid-template-columns: minmax(11rem, 14rem) 1fr 7rem; align-items: center; gap: 0.5rem; padding: 0.2rem 0; }
  .country-list li.country-keywords { display: flex; flex-wrap: wrap; align-items: center; gap: 0.3rem; grid-template-columns: none; }
  .country-name { font-weight: 500; display: inline-flex; align-items: center; gap: 0.4rem; min-width: 0; }
  .country-name-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .country-n { color: #777; font-size: 0.8rem; }
  .country-bar { position: relative; height: 0.55rem; background: #ececec; border-radius: 3px; overflow: hidden; }
  .country-bar-fill {
    position: absolute;
    top: 0;
    bottom: 0;
    width: var(--bar-pct);
    background: var(--bar-color);
  }
  .country-bar[style*="--bar-side: left"] .country-bar-fill { left: 50%; }
  .country-bar[style*="--bar-side: right"] .country-bar-fill { right: 50%; }
  .country-score { font-variant-numeric: tabular-nums; color: #444; font-size: 0.82rem; text-align: right; }
  .country-keywords { display: flex; flex-wrap: wrap; align-items: center; gap: 0.2rem; margin-left: 7rem; padding-bottom: 0.4rem; border-bottom: 1px dashed #eee; }
  .country-keyword-label { color: #888; font-size: 0.74rem; margin-right: 0.3rem; }
  .perspective-note { color: #777; font-size: 0.78rem; margin-top: 0.4rem; }
  .perspective-footer { margin-top: 0.75rem; color: #888; font-size: 0.75rem; }
  .perspective-footer code { font-size: 0.75rem; }
  .perspective-error { color: #a33; }
  .perspective-loading { color: #555; font-style: italic; }
  .narrative-credit { text-align: right; margin-top: 0.4rem; }
  .narrative-body { line-height: 1.5; color: #2f3a52; }
  .narrative-body :global(p) { margin: 0 0 0.6rem; }
  .narrative-body :global(p:last-child) { margin-bottom: 0; }
  .narrative-body :global(strong) { color: #142033; font-weight: 600; }
  .narrative-body :global(em) { font-style: italic; color: #34455d; }
  .narrative-body :global(code) { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.88em; background: #f1f4f9; padding: 1px 5px; border-radius: 3px; }
  .narrative-body :global(ol), .narrative-body :global(ul) { margin: 0 0 0.4rem; padding-left: 1.4rem; }
  .narrative-body :global(li) { margin-bottom: 0.5rem; }
  .narrative-body :global(li:last-child) { margin-bottom: 0; }
</style>
