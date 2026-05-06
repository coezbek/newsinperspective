<script lang="ts">
  import type { StoryComparison, StoryDetail } from "@news/shared";

  interface Props {
    story: StoryDetail;
    comparison: StoryComparison | null;
    articlePath: (id: string) => string;
    storyPath: (id: string) => string;
    sourcePath: (domain: string) => string;
    tagPath: (keyword: string) => string;
    datePath?: (date: string) => string;
    faviconUrl: (domain: string) => string;
    formatDateRange: (dateFrom: string, dateUntil: string) => string;
    formatScopeLabel: (region: string | null | undefined, category: string | null | undefined) => string;
    otherSourceCount: (story: StoryDetail | null) => number;
    onNavigate: (event: MouseEvent, path: string) => void;
    onFaviconError: (event: Event) => void;
  }

  let {
    story,
    comparison,
    articlePath,
    storyPath,
    sourcePath,
    tagPath,
    datePath,
    faviconUrl,
    formatDateRange,
    formatScopeLabel,
    otherSourceCount,
    onNavigate,
    onFaviconError,
  }: Props = $props();

  function sentimentTone(score: number): "positive" | "neutral" | "negative" {
    if (score > 0.05) return "positive";
    if (score < -0.05) return "negative";
    return "neutral";
  }

  function sentimentSymbol(score: number): string {
    const tone = sentimentTone(score);
    if (tone === "positive") return "+";
    if (tone === "negative") return "−";
    return "=";
  }
</script>

<header class="cluster-head">
  <p class="eyebrow">
    {formatScopeLabel(story.region, story.category)}
    <span class="sep">·</span>
    {formatDateRange(story.dateFrom, story.dateUntil)}
  </p>
  <h3>
    <a
      class="cluster-title-link"
      href={storyPath(story.id)}
      on:click={(event) => onNavigate(event, storyPath(story.id))}
    >
      {story.translatedTitle ?? story.title}
    </a>
  </h3>
  {#if story.translatedTitle && story.translatedTitle !== story.title}
    <p class="original-title" title="Original title">{story.title}</p>
  {/if}

  <p class="cluster-meta">
    <strong>{story.articleCount}</strong> articles ·
    <strong>{story.sourceCount}</strong> sources
  </p>

  <div class="domain-strip" aria-label="Top domains">
    {#each story.topDomains as domain}
      <a
        class="domain-chip"
        href={sourcePath(domain)}
        on:click={(event) => onNavigate(event, sourcePath(domain))}
        title={domain}
      >
        <img class="favicon" src={faviconUrl(domain)} alt="" loading="lazy" width="14" height="14" on:error={onFaviconError} />
        <span>{domain}</span>
      </a>
    {/each}
    {#if otherSourceCount(story) > 0}
      <span class="domain-more">+{otherSourceCount(story)}</span>
    {/if}
  </div>
</header>

{#if comparison && (comparison.sharedKeywords.length > 0 || comparison.framingSummary.length > 0)}
  <section class="cluster-comparison">
    {#if comparison.sharedKeywords.length > 0}
      <div class="chip-row">
        {#each comparison.sharedKeywords.slice(0, 8) as keyword}
          <a class="chip" href={tagPath(keyword)} on:click={(event) => onNavigate(event, tagPath(keyword))}>{keyword}</a>
        {/each}
      </div>
    {/if}
    {#each comparison.framingSummary as line}
      <p class="framing-line">{line}</p>
    {/each}
  </section>
{/if}

<section class="cluster-articles" aria-label="Articles in this cluster">
  <ul>
    {#each story.articles as article}
      <li class="cluster-article">
        <div class="row-meta">
          <a
            class="row-domain"
            href={sourcePath(article.domain)}
            on:click={(event) => onNavigate(event, sourcePath(article.domain))}
            title={article.domain}
          >
            <img class="favicon" src={faviconUrl(article.domain)} alt="" loading="lazy" width="14" height="14" on:error={onFaviconError} />
            <span>{article.domain}</span>
          </a>
          {#if datePath}
            <a
              class="row-date"
              href={datePath(article.publishedAt.slice(0, 10))}
              on:click={(event) => onNavigate(event, datePath!(article.publishedAt.slice(0, 10)))}
            >{article.publishedAt.slice(0, 10)}</a>
          {:else}
            <span class="row-date">{article.publishedAt.slice(0, 10)}</span>
          {/if}
          <span
            class={`tone-dot tone-dot--${sentimentTone(article.sentiment)}`}
            title={`Sentiment ${article.sentiment.toFixed(2)}`}
          >{sentimentSymbol(article.sentiment)}</span>
          {#if article.isTranslated && article.language}
            <span class="lang-tag" title={`Translated from ${article.language.toUpperCase()}`}>
              {article.language.slice(0, 2).toUpperCase()}
            </span>
          {/if}
        </div>
        <a
          class="row-title"
          href={articlePath(article.id)}
          on:click={(event) => onNavigate(event, articlePath(article.id))}
        >{article.title}</a>
      </li>
    {/each}
  </ul>
</section>

<footer class="cluster-footer">
  <a class="open-story" href={storyPath(story.id)} on:click={(event) => onNavigate(event, storyPath(story.id))}>
    Open full story →
  </a>
</footer>

<style>
  .eyebrow {
    margin: 0 0 6px;
    color: var(--muted, #58708f);
    font-size: 0.74rem;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    font-weight: 600;
  }

  .sep {
    margin: 0 4px;
    color: rgba(88, 112, 143, 0.5);
  }

  .cluster-head h3 {
    margin: 0 0 4px;
    font-size: 1.18rem;
    line-height: 1.25;
    letter-spacing: -0.02em;
  }

  .cluster-title-link {
    color: inherit;
    text-decoration: none;
  }

  .cluster-title-link:hover {
    text-decoration: underline;
  }

  .original-title {
    margin: 0 0 8px;
    color: var(--muted, #58708f);
    font-size: 0.88rem;
    font-style: italic;
  }

  .cluster-meta {
    margin: 8px 0 6px;
    color: var(--muted, #58708f);
    font-size: 0.84rem;
  }

  .cluster-meta strong {
    color: #142033;
    font-weight: 600;
  }

  .domain-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 14px;
  }

  .domain-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 8px;
    border-radius: 999px;
    border: 1px solid var(--border, rgba(28, 46, 73, 0.12));
    background: rgba(255, 255, 255, 0.85);
    color: #2f435e;
    font-size: 0.78rem;
    text-decoration: none;
    line-height: 1;
  }

  .domain-chip:hover {
    border-color: rgba(37, 87, 167, 0.32);
    box-shadow: 0 4px 10px rgba(20, 55, 111, 0.1);
  }

  .domain-more {
    align-self: center;
    color: var(--muted, #58708f);
    font-size: 0.78rem;
  }

  .favicon {
    border-radius: 3px;
    flex: 0 0 14px;
  }

  .cluster-comparison {
    padding: 10px 0 12px;
    border-top: 1px solid rgba(28, 46, 73, 0.08);
    border-bottom: 1px solid rgba(28, 46, 73, 0.08);
    margin-bottom: 14px;
  }

  .chip-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 8px;
  }

  .chip {
    padding: 4px 10px;
    border-radius: 999px;
    background: var(--accent-soft, #dce8ff);
    color: var(--accent-strong, #0a3c96);
    font-size: 0.78rem;
    font-weight: 600;
    text-decoration: none;
  }

  .chip:hover {
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  .framing-line {
    margin: 4px 0 0;
    color: #34455d;
    font-size: 0.88rem;
    line-height: 1.4;
  }

  .cluster-articles ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .cluster-article {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 10px 12px;
    border: 1px solid var(--border, rgba(28, 46, 73, 0.12));
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.65);
    transition:
      border-color 140ms ease,
      box-shadow 140ms ease;
  }

  .cluster-article:hover {
    border-color: rgba(37, 87, 167, 0.32);
    box-shadow: 0 4px 10px rgba(20, 55, 111, 0.08);
  }

  .row-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    color: var(--muted, #58708f);
    font-size: 0.78rem;
  }

  .row-domain {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: inherit;
    text-decoration: none;
  }

  .row-domain:hover {
    color: var(--accent-strong, #0a3c96);
  }

  .row-date {
    color: inherit;
    text-decoration: none;
    border-bottom: 1px dotted rgba(88, 112, 143, 0.4);
  }

  .row-date:hover {
    color: var(--accent-strong, #0a3c96);
  }

  .tone-dot {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 700;
    line-height: 1;
  }

  .tone-dot--positive {
    background: #dff5e1;
    color: #1e6b3a;
  }

  .tone-dot--neutral {
    background: #eef0f4;
    color: #4a5568;
  }

  .tone-dot--negative {
    background: #fde2e4;
    color: #8b1e3f;
  }

  .lang-tag {
    padding: 1px 6px;
    border-radius: 4px;
    background: rgba(37, 87, 167, 0.1);
    color: var(--accent-strong, #0a3c96);
    font-size: 0.68rem;
    font-weight: 600;
    border: 1px solid rgba(37, 87, 167, 0.2);
  }

  .row-title {
    color: #142033;
    font-size: 0.95rem;
    font-weight: 600;
    line-height: 1.35;
    text-decoration: none;
  }

  .row-title:hover {
    color: var(--accent-strong, #0a3c96);
    text-decoration: underline;
  }

  .cluster-footer {
    margin-top: 14px;
    padding-top: 12px;
    border-top: 1px solid rgba(28, 46, 73, 0.08);
    text-align: right;
  }

  .open-story {
    color: var(--accent-strong, #0a3c96);
    font-weight: 600;
    text-decoration: none;
    font-size: 0.9rem;
  }

  .open-story:hover {
    text-decoration: underline;
  }
</style>
