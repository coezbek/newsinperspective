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

  interface ArticleRef {
    id: string;
    sourceName: string;
    domain: string;
    url: string;
    hasFullText?: boolean;
    sentiment?: number | null;
    country?: string | null;
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

  // Mean sentiment across all articles from this source in this cluster.
  // Returns null when no article has a sentiment score.
  function sourceSentiment(sourceName: string): number | null {
    const list = articlesForSource(sourceName);
    let sum = 0;
    let n = 0;
    for (const a of list) {
      if (typeof a.sentiment === "number" && isFinite(a.sentiment)) {
        sum += a.sentiment;
        n += 1;
      }
    }
    return n === 0 ? null : sum / n;
  }

  // Same ±0.05 threshold as StoryDetailPanel's sentiment-pill labelling.
  function sentimentTone(score: number): "positive" | "neutral" | "negative" {
    if (score > 0.05) return "positive";
    if (score < -0.05) return "negative";
    return "neutral";
  }

  const SENTIMENT_COLORS: Record<"positive" | "neutral" | "negative", { bg: string; fg: string }> = {
    positive: { bg: "#dff5e1", fg: "#1e6b3a" },
    neutral:  { bg: "#eef0f4", fg: "#4a5568" },
    negative: { bg: "#fde2e4", fg: "#8b1e3f" },
  };

  function diagonalCellStyle(score: number | null): string {
    if (score === null) return "background: #f4f4f4; color: #aaa;";
    const c = SENTIMENT_COLORS[sentimentTone(score)];
    return `background: ${c.bg}; color: ${c.fg};`;
  }

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

  const useScatter2D = $derived((data?.n_articles ?? 0) > 10);

  const axisPoints = $derived.by<AxisPoint[]>(() => {
    if (!data || !faviconUrl) return [];
    const matrix = data.pairwise_distance ?? {};
    const sourcesInMatrix = Object.keys(matrix).filter(hasText);
    if (sourcesInMatrix.length < 2) return [];

    // Article counts per source (within the cluster) for tie-break + label/badge.
    const counts = new Map<string, { count: number; domain: string; articleId: string }>();
    for (const a of articles) {
      const key = a.sourceName || a.domain || "";
      if (!key) continue;
      const prev = counts.get(key);
      if (prev) {
        prev.count += 1;
      } else {
        counts.set(key, { count: 1, domain: a.domain, articleId: a.id });
      }
    }

    // Pick top-N sources by EXTREMITY (mean distance to other sources), not by
    // article count. Wire services like Reuters/AP show up in every cluster but
    // frame neutrally — picking by article count promoted exactly the sources
    // with the *least* divergence to display. Larger top-N for 2D since the
    // scatter plot has more screen real estate.
    const topN = useScatter2D ? 16 : 10;
    const articleCountsForPicker = new Map<string, number>();
    for (const [s, info] of counts) articleCountsForPicker.set(s, info.count);
    const picked = pickTopSourcesByExtremity({
      matrix,
      sources: sourcesInMatrix,
      articleCounts: articleCountsForPicker,
      n: topN,
    });
    const ranked = picked
      .map((p) => ({
        sourceName: p.sourceName,
        ...(counts.get(p.sourceName) ?? { count: 0, domain: "", articleId: "" }),
      }))
      .filter((s) => s.domain);

    if (ranked.length < 2) return [];

    // Build subset distance matrix.
    const names = ranked.map((r) => r.sourceName);
    const D = names.map((a) =>
      names.map((b) => (a === b ? 0 : matrix[a]?.[b] ?? matrix[b]?.[a] ?? 0)),
    );

    const dims = useScatter2D ? 2 : 1;
    const coords = classicalMds(D, dims);
    const xRaw = coords[0] ?? [];
    const yRaw = coords[1];

    // For 2D we rank-transform each axis independently so points spread evenly
    // across the canvas. Pure MDS coordinates often cluster the most-similar
    // sources tightly while leaving outliers stranded — the rank transform
    // preserves the MDS *ordering* in each dimension but gives every point
    // ~1/N units of breathing room. For 1D we keep raw coords so the spacing
    // still encodes distance.
    let xCoords: number[];
    let yCoords: number[] | undefined;
    if (useScatter2D) {
      xCoords = rankTransform(xRaw);
      yCoords = yRaw ? rankTransform(yRaw) : undefined;
    } else {
      const xMin = Math.min(...xRaw);
      const xMax = Math.max(...xRaw);
      const xSpan = xMax - xMin || 1;
      xCoords = xRaw.map((v) => (v - xMin) / xSpan);
    }

    return ranked.map((r, i) => ({
      sourceName: r.sourceName,
      domain: r.domain,
      articleId: r.articleId,
      articleCount: r.count,
      x: xCoords[i] ?? 0.5,
      ...(yCoords ? { y: yCoords[i] ?? 0.5 } : {}),
    }));
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
      void load(false);
    }
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

<div class="perspective-stack">
{#if error}
    <p class="perspective-error">{error}</p>
  {/if}

  {#if loading && !data}
    <p class="perspective-loading">Loading perspective…</p>
  {:else if data}
    <div class="perspective-row perspective-row--top">
      <div class="perspective-block divergence-block">
        <h5>Framing divergence</h5>
        <div class="divergence-summary">
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
      </div>

      {#if heatmap}
        <div class="perspective-block">
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
                      {@const diagSent = i === j ? sourceSentiment(cell.a) : null}
                      {@const diagArticleId = i === j ? representativeArticleId(cell.a) : null}
                      {@const diagLinkable = i === j && diagArticleId && articlePath}
                      <td
                        class="heatmap-cell"
                        class:diagonal={i === j}
                        class:clickable={linkable || diagLinkable}
                        style={i === j ? diagonalCellStyle(diagSent) : heatStyle(cell.value, false)}
                        title={i === j
                          ? diagSent !== null
                            ? `${cell.a} — sentiment ${diagSent.toFixed(2)} (${sentimentTone(diagSent)})`
                            : `${cell.a} — sentiment unavailable`
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
                        {:else if diagLinkable && diagSent !== null}
                          <a
                            class="heatmap-cell-link"
                            href={articlePath!(diagArticleId!)}
                            onclick={(event) => handleSourceClick(event, diagArticleId!)}
                          >{diagSent.toFixed(2)}</a>
                        {:else if diagSent !== null}
                          {diagSent.toFixed(2)}
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

    {#if axisPoints.length >= 2 && faviconUrl}
      <div class="perspective-block">
        <h5>Source positioning</h5>
        {#if useScatter2D}
          <p class="perspective-note source-axis-help">
            Top {axisPoints.length} most-divergent sources (mean distance to others), projected from the SBERT distance matrix to two dimensions (classical MDS). Closer favicons frame the story more similarly. Axes are unitless.
          </p>
          <div class="source-scatter">
            {#each axisPoints as p}
              <a
                class="source-axis-marker scatter"
                style="--x: {p.x}; --y: {p.y ?? 0.5}"
                href={articlePath ? articlePath(p.articleId) : "#"}
                onclick={(event) => p.articleId && handleSourceClick(event, p.articleId)}
                title={`${p.sourceName} — ${p.articleCount} article${p.articleCount === 1 ? "" : "s"}`}
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
                <span class="source-axis-label">{p.sourceName}</span>
              </a>
            {/each}
          </div>
        {:else}
          {@const placed = assignRows(axisPoints, 0.07)}
          {@const rowCount = Math.max(...placed.map((p) => p.row)) + 1}
          <p class="perspective-note source-axis-help">
            Top {axisPoints.length} most-divergent sources (mean distance to others), projected to one dimension (classical MDS). Closer favicons frame the story more similarly.
          </p>
          <div class="source-axis" style="--row-count: {rowCount}">
            <div class="source-axis-line"></div>
            {#each placed as p}
              <a
                class="source-axis-marker"
                style="--x: {p.x}; --row: {p.row}"
                href={articlePath ? articlePath(p.articleId) : "#"}
                onclick={(event) => p.articleId && handleSourceClick(event, p.articleId)}
                title={`${p.sourceName} — ${p.articleCount} article${p.articleCount === 1 ? "" : "s"}`}
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
                <span class="source-axis-label">{p.sourceName}</span>
              </a>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    <div class="perspective-row perspective-row--bottom">
    {#if data.distinctive_words.length > 0}
      <div class="perspective-block">
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
      <div class="perspective-block">
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
      <div class="perspective-block">
        <p class="perspective-error">{data.narrative.error}</p>
      </div>
    {/if}

    {#if data.narrative?.framingAngles || data.narrative?.countryNarrative}
      <div class="perspective-row perspective-row--narrative">
        {#if data.narrative.framingAngles}
          <div class="perspective-block narrative-block">
            <h5>Editorial angles</h5>
            <div class="narrative-body" onclick={handleNarrativeClick}>{@html injectSourceFavicons(renderMarkdown(data.narrative.framingAngles))}</div>
          </div>
        {/if}
        {#if data.narrative.countryNarrative}
          <div class="perspective-block narrative-block">
            <h5>National narratives</h5>
            <div class="narrative-body" onclick={handleNarrativeClick}>{@html injectCountryFlags(renderMarkdown(data.narrative.countryNarrative))}</div>
          </div>
        {/if}
      </div>
      {#if data.narrative.model}
        <p class="perspective-note narrative-credit">Generated by {data.narrative.model}</p>
      {/if}
    {/if}

    {#if articles && articles.length > 0}
      <div class="perspective-block country-map-block">
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
  .source-link { color: #1c4566; text-decoration: none; border-bottom: 1px dotted #9bb1c7; }
  .source-link:hover { color: #0a3c96; border-bottom-color: #0a3c96; }
  .source-count { color: #888; font-weight: 400; font-size: 0.75rem; margin-left: 0.2rem; }
  .source-axis-help { margin-bottom: 0.6rem; }
  .source-axis {
    position: relative;
    height: calc(2.6rem + var(--row-count, 1) * 2.4rem);
    margin: 0.4rem 4rem 1.5rem;
  }
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
  .source-scatter {
    position: relative;
    height: 18rem;
    margin: 0.4rem 4rem 3rem;
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
    transform: translate(-50%, -50%);
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
  .heatmap-cell.diagonal { font-weight: 600; }
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
