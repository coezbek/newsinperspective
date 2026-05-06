<script lang="ts">
  interface Bucket { min: number; max: number; count: number }
  interface TopCluster {
    clusterId: string;
    title: string;
    divergenceScore: number;
    divergenceLabel: string | null;
    nSources: number;
    nCountries: number;
    nArticles: number;
  }
  interface CountryCoverage {
    country: string;
    clusters: number;
    articles: number;
    meanSentiment: number;
  }
  interface CorrelationEntry { metric: string; values: Record<string, number> }
  interface Stats {
    totalClusters: number;
    divergenceHistogram: Bucket[];
    divergenceMean: number;
    divergenceMedian: number;
    topClusters: TopCluster[];
    countryCoverage: CountryCoverage[];
    sentimentHistogram: Bucket[];
    correlation: CorrelationEntry[];
  }

  interface Props {
    apiBase: string;
    onNavigate: (event: MouseEvent, path: string) => void;
  }

  let { apiBase, onNavigate }: Props = $props();

  let stats: Stats | null = $state(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  $effect(() => {
    void load();
  });

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      const res = await fetch(`${apiBase}/api/perspective/stats`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      stats = (await res.json()) as Stats;
    } catch (err) {
      error = err instanceof Error ? err.message : "Failed to load stats";
    } finally {
      loading = false;
    }
  }

  function maxCount(buckets: Bucket[]): number {
    return buckets.reduce((m, b) => Math.max(m, b.count), 0) || 1;
  }

  function corrColor(v: number): string {
    if (v >= 0) {
      const t = Math.min(1, v);
      const r = Math.round(255 - 100 * t);
      const g = Math.round(245 - 120 * t);
      const b = Math.round(235 - 160 * t);
      return `rgb(${r}, ${g}, ${b})`;
    }
    const t = Math.min(1, -v);
    const r = Math.round(245 - 60 * t);
    const g = Math.round(245 - 80 * t);
    const b = Math.round(255 - 50 * t);
    return `rgb(${r}, ${g}, ${b})`;
  }

  function clusterPath(id: string): string {
    return `/stories/${encodeURIComponent(id)}`;
  }
</script>

<section class="panel stats-page">
  <header class="detail-head">
    <div>
      <p class="eyebrow">Perspective intelligence</p>
      <h2>Aggregate stats</h2>
    </div>
    <div class="page-actions">
      <a href="/" class="tab back-link" on:click={(event) => onNavigate(event, "/")}>Back to feed</a>
    </div>
  </header>

  {#if loading}
    <p class="muted">Loading…</p>
  {:else if error}
    <p class="error">{error}</p>
  {:else if stats}
    <p class="summary-line">
      {stats.totalClusters} clusters analysed · mean divergence {stats.divergenceMean.toFixed(3)} · median {stats.divergenceMedian.toFixed(3)}
    </p>

    <div class="stats-grid">
      <section class="stats-block">
        <h3>Framing divergence distribution</h3>
        {#if stats.divergenceHistogram.length === 0}
          <p class="muted">No data.</p>
        {:else}
          {@const max = maxCount(stats.divergenceHistogram)}
          <div class="histogram">
            {#each stats.divergenceHistogram as b}
              <div class="hist-col" title={`${b.min.toFixed(2)}–${b.max.toFixed(2)} (n=${b.count})`}>
                <div class="hist-bar" style="height: {(b.count / max) * 100}%"></div>
              </div>
            {/each}
          </div>
          <div class="hist-axis">
            <span>0</span><span>0.25</span><span>0.5</span><span>0.75</span><span>1</span>
          </div>
          <p class="muted small">Notebook threshold of 0.15 / 0.25 marked for reference; recalibrate if most clusters land above.</p>
        {/if}
      </section>

      <section class="stats-block">
        <h3>Country-level sentiment distribution</h3>
        {#if stats.sentimentHistogram.length === 0}
          <p class="muted">No data.</p>
        {:else}
          {@const max = maxCount(stats.sentimentHistogram)}
          <div class="histogram">
            {#each stats.sentimentHistogram as b}
              <div class="hist-col" title={`${b.min.toFixed(2)}–${b.max.toFixed(2)} (n=${b.count})`}>
                <div class="hist-bar sentiment" style="height: {(b.count / max) * 100}%"></div>
              </div>
            {/each}
          </div>
          <div class="hist-axis">
            <span>−1</span><span>−0.5</span><span>0</span><span>+0.5</span><span>+1</span>
          </div>
          <p class="muted small">Each sample = one country×cluster average. RoBERTa is tweet-trained — values cluster near 0 on news.</p>
        {/if}
      </section>

      <section class="stats-block">
        <h3>Top divergent stories</h3>
        <ol class="top-list">
          {#each stats.topClusters as c}
            <li>
              <a href={clusterPath(c.clusterId)} on:click={(event) => onNavigate(event, clusterPath(c.clusterId))}>
                <span class="top-score">{c.divergenceScore.toFixed(3)}</span>
                <span class="top-title">{c.title}</span>
                <span class="top-meta">{c.nSources}s · {c.nCountries}c</span>
              </a>
            </li>
          {/each}
        </ol>
      </section>

      <section class="stats-block">
        <h3>Country coverage</h3>
        <table class="country-table">
          <thead>
            <tr><th>Country</th><th>Clusters</th><th>Articles</th><th>Mean sent.</th></tr>
          </thead>
          <tbody>
            {#each stats.countryCoverage as c}
              <tr>
                <td>{c.country}</td>
                <td>{c.clusters}</td>
                <td>{c.articles}</td>
                <td class:positive={c.meanSentiment > 0.05} class:negative={c.meanSentiment < -0.05}>
                  {c.meanSentiment.toFixed(3)}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </section>

      <section class="stats-block">
        <h3>Correlation matrix</h3>
        <table class="corr-matrix">
          <thead>
            <tr>
              <th></th>
              {#each stats.correlation as row}<th>{row.metric}</th>{/each}
            </tr>
          </thead>
          <tbody>
            {#each stats.correlation as row}
              <tr>
                <th>{row.metric}</th>
                {#each stats.correlation as col}
                  {@const v = row.values[col.metric] ?? 0}
                  <td style="background: {corrColor(v)}" title={`${row.metric} ↔ ${col.metric}: ${v.toFixed(3)}`}>{v.toFixed(2)}</td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
        <p class="muted small">Pearson correlation across cluster-level metrics.</p>
      </section>
    </div>
  {/if}
</section>

<style>
  .stats-page { padding: 24px; }
  .summary-line { color: #58708f; margin-top: 0; margin-bottom: 1rem; }
  .stats-grid { display: grid; gap: 1.5rem; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); }
  .stats-block { background: #fafafa; border: 1px solid #e2e2e2; border-radius: 8px; padding: 1rem 1.25rem; }
  .stats-block h3 { margin: 0 0 0.7rem; font-size: 0.95rem; }
  .muted { color: #777; }
  .small { font-size: 0.78rem; }
  .error { color: #a33; }
  .histogram { display: flex; align-items: stretch; gap: 2px; height: 9rem; padding: 0.4rem 0; border-bottom: 1px solid #ddd; }
  .hist-col { flex: 1; display: flex; align-items: flex-end; height: 100%; min-width: 4px; }
  .hist-bar { width: 100%; background: #4a7bb8; border-radius: 2px 2px 0 0; min-height: 2px; }
  .hist-bar.sentiment { background: #6b8e6e; }
  .hist-axis { display: flex; justify-content: space-between; margin-top: 4px; color: #888; font-size: 0.7rem; }
  .top-list { list-style: decimal; padding-left: 1.25rem; margin: 0; }
  .top-list li { margin: 0.3rem 0; }
  .top-list a { display: grid; grid-template-columns: 3rem 1fr auto; gap: 0.6rem; align-items: baseline; text-decoration: none; color: inherit; padding: 0.2rem 0.3rem; border-radius: 3px; }
  .top-list a:hover { background: #eef3f8; }
  .top-score { font-variant-numeric: tabular-nums; color: #c9523f; font-weight: 500; }
  .top-title { color: #1c4566; }
  .top-meta { color: #888; font-size: 0.78rem; }
  .country-table, .corr-matrix { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  .country-table th, .country-table td, .corr-matrix th, .corr-matrix td { padding: 4px 8px; text-align: left; border-bottom: 1px solid #eee; }
  .country-table td.positive { color: #2a7a3a; }
  .country-table td.negative { color: #a33; }
  .corr-matrix th { font-weight: 500; color: #555; }
  .corr-matrix td { text-align: center; font-variant-numeric: tabular-nums; border-radius: 2px; min-width: 3rem; }
</style>
