<script lang="ts">
  import type { LinkedEntity, StoryComparison, StoryDetail } from "@news/shared";
  import EntityPopover from "./EntityPopover.svelte";
  import PerspectivePanel from "./PerspectivePanel.svelte";

  interface Props {
    story: StoryDetail;
    comparison: StoryComparison | null;
    articlePath: (id: string) => string;
    comparePath?: (aId: string, bId: string) => string;
    sourcePath: (domain: string) => string;
    tagPath: (keyword: string) => string;
    faviconUrl: (domain: string) => string;
    formatDateRange: (dateFrom: string, dateUntil: string) => string;
    formatScopeLabel: (region: string | null | undefined, category: string | null | undefined) => string;
    otherSourceCount: (story: StoryDetail | null) => number;
    onNavigate: (event: MouseEvent, path: string) => void;
    onFaviconError: (event: Event) => void;
    apiBase: string;
    showEntities?: boolean;
    datePath?: (date: string) => string;
  }

  let {
    story,
    comparison,
    articlePath,
    comparePath,
    sourcePath,
    tagPath,
    faviconUrl,
    formatDateRange,
    formatScopeLabel,
    otherSourceCount,
    onNavigate,
    onFaviconError,
    apiBase,
    showEntities = false,
    datePath,
  }: Props = $props();

  let entityMap = $state<Record<string, LinkedEntity[]>>({});
  let entityLoadingByArticleId = $state<Record<string, boolean>>({});
  let entityErrorByArticleId = $state<Record<string, string>>({});
  let selectedEntity = $state<LinkedEntity | null>(null);
  let loadedStoryId = "";

  async function fetchArticleEntities(articleId: string): Promise<void> {
    entityLoadingByArticleId = { ...entityLoadingByArticleId, [articleId]: true };
    entityErrorByArticleId = { ...entityErrorByArticleId, [articleId]: "" };

    try {
      const response = await fetch(
        `${apiBase}/api/articles/${encodeURIComponent(articleId)}/entities?minConfidence=0.2&limit=50`,
      );

      if (!response.ok) {
        throw new Error(`Failed to fetch entities: ${response.status} ${response.statusText}`);
      }

      const payload = await response.json() as { entities?: LinkedEntity[] };
      entityMap = {
        ...entityMap,
        [articleId]: payload.entities ?? [],
      };
    } catch (error) {
      entityErrorByArticleId = {
        ...entityErrorByArticleId,
        [articleId]: error instanceof Error ? error.message : "Failed to fetch entities",
      };
    } finally {
      entityLoadingByArticleId = { ...entityLoadingByArticleId, [articleId]: false };
    }
  }

  async function preloadStoryEntities(): Promise<void> {
    entityMap = {};
    entityLoadingByArticleId = {};
    entityErrorByArticleId = {};
    selectedEntity = null;

    await Promise.all(story.articles.map((article) => fetchArticleEntities(article.id)));
  }

  $effect(() => {
    if (!showEntities) return;
    if (loadedStoryId === story.id) return;
    loadedStoryId = story.id;
    void preloadStoryEntities();
  });

  function sentimentLabel(score: number): { label: string; tone: "positive" | "neutral" | "negative" } {
    if (score > 0.05) return { label: "Positive sentiment", tone: "positive" };
    if (score < -0.05) return { label: "Negative sentiment", tone: "negative" };
    return { label: "Neutral sentiment", tone: "neutral" };
  }
</script>

<div class="detail-head" class:detail-head--focus={showEntities}>
  <header>
    {#if !showEntities}
      <p class="eyebrow">
        {formatScopeLabel(story.region, story.category)}
      </p>
    {/if}
    <h3>
      <a
        class="story-title-link"
        href={`/stories/${encodeURIComponent(story.id)}`}
        on:click={(event) => onNavigate(event, `/stories/${encodeURIComponent(story.id)}`)}
        title={story.translatedTitle && story.translatedTitle !== story.title ? story.title : undefined}
      >
        {story.translatedTitle ?? story.title}
      </a>
    </h3>
    <p>
      {story.articleCount} articles across
      {story.sourceCount} sources{#if !showEntities} ·
      {formatDateRange(story.dateFrom, story.dateUntil)}{/if}
    </p>
    <div class="domain-strip" aria-label="Top domains">
      {#each story.topDomains as domain}
        <a
          class="domain-chip domain-link"
          href={sourcePath(domain)}
          on:click={(event) => onNavigate(event, sourcePath(domain))}
        >
          <img
            class="favicon"
            src={faviconUrl(domain)}
            alt=""
            loading="lazy"
            width="14"
            height="14"
            on:error={onFaviconError}
          />
          <span>{domain}</span>
        </a>
      {/each}
      {#if otherSourceCount(story) > 0}
        <span class="domain-more">and {otherSourceCount(story)} other sources</span>
      {/if}
    </div>
  </header>

  <div class="comparison">
    {#if comparison}
      <div class="chip-row">
        {#each comparison.sharedKeywords as keyword}
          <a href={tagPath(keyword)} class="chip" on:click={(event) => onNavigate(event, tagPath(keyword))}>{keyword}</a>
        {/each}
      </div>

      {#each comparison.framingSummary as line}
        <p>{line}</p>
      {/each}
    {/if}
  </div>
</div>

<PerspectivePanel
  clusterId={story.id}
  {apiBase}
  articles={story.articles.map((a) => ({ id: a.id, sourceName: a.sourceName, domain: a.domain, url: a.url, hasFullText: !!a.fullText }))}
  {articlePath}
  {comparePath}
  {onNavigate}
  {faviconUrl}
  {onFaviconError}
/>

<div class="article-grid" class:article-grid--focus={showEntities}>
  {#each story.articles as article}
    <article id={`article-${article.id}`} class="article-entry">
      <div class="article-head-rail">
        <header class="article-head">
          <p class="meta article-meta">
            <a class="domain-chip domain-link" href={sourcePath(article.domain)} on:click={(event) => onNavigate(event, sourcePath(article.domain))}>
              <img
                class="favicon"
                src={faviconUrl(article.domain)}
                alt=""
                loading="lazy"
                width="14"
                height="14"
                on:error={onFaviconError}
              />
              <span>{article.domain}</span>
            </a>
            <span>·</span>
            {#if datePath}
              <a
                class="article-date-link"
                href={datePath(article.publishedAt.slice(0, 10))}
                on:click={(event) => onNavigate(event, datePath!(article.publishedAt.slice(0, 10)))}
              >{article.publishedAt.slice(0, 10)}</a>
            {:else}
              <span>{article.publishedAt.slice(0, 10)}</span>
            {/if}
            <span class={`sentiment-pill sentiment-pill--${sentimentLabel(article.sentiment).tone}`} title={`Sentiment score ${article.sentiment.toFixed(2)}`}>{sentimentLabel(article.sentiment).label}</span>
            {#if article.isTranslated && article.language}
              <span class="lang-pill" title={`Translated from ${article.language.toUpperCase()} to English`}>
                {article.language.slice(0, 2).toUpperCase()} → EN
              </span>
            {/if}
          </p>
          <h4><a href={articlePath(article.id)} on:click={(event) => onNavigate(event, articlePath(article.id))}>{article.title}</a></h4>
        </header>
      </div>
      <div class="article-card-body">
        <div class="article-body">
          <div class="article-main">
            {#if article.summary}
              <p>{article.summary}</p>
            {:else if article.extractionStatus === "PENDING"}
              <p class="placeholder-pending">Summary pending</p>
            {:else}
              <p class="placeholder-pending">Summary pending</p>
            {/if}
            {#if article.nearDuplicatePeers.length > 0}
              <p class="signals">
                Possible near-duplicate coverage:
                {#each article.nearDuplicatePeers as peer, peerIndex}
                  {#if peerIndex > 0}, {/if}
                  <a href={articlePath(peer.articleId)} on:click={(event) => onNavigate(event, articlePath(peer.articleId))}>{peer.domain}</a>
                {/each}
              </p>
            {:else if article.syndicatedDomains.length > 0}
              <p class="signals">
                Possible near-duplicate coverage on {article.syndicatedDomains.join(", ")}
              </p>
            {/if}
            <a class="read-source" href={article.url} target="_blank" rel="noreferrer">Read source ↗</a>
          </div>
          <aside class="article-tag-strip" aria-label="Keywords and entities">
            {#if article.keywords.length > 0}
              <div class="tag-row">
                <span class="tag-row-label">Keywords</span>
                <div class="tag-row-chips">
                  {#each article.keywords.slice(0, 4) as keyword}
                    <a href={tagPath(keyword)} class="story-chip" on:click={(event) => onNavigate(event, tagPath(keyword))}>{keyword}</a>
                  {/each}
                  {#if article.keywords.length > 4}
                    <a href={articlePath(article.id)} class="story-chip story-chip--more" on:click={(event) => onNavigate(event, articlePath(article.id))}>+{article.keywords.length - 4} more</a>
                  {/if}
                </div>
              </div>
            {/if}
            {#if showEntities}
              {@const ents = entityMap[article.id] ?? []}
              {#if entityLoadingByArticleId[article.id]}
                <div class="tag-row">
                  <span class="tag-row-label">Entities</span>
                  <span class="entity-loading">Loading…</span>
                </div>
              {:else if entityErrorByArticleId[article.id]}
                <div class="tag-row">
                  <span class="tag-row-label">Entities</span>
                  <span class="entity-error">{entityErrorByArticleId[article.id]}</span>
                </div>
              {:else if ents.length > 0}
                <div class="tag-row">
                  <span class="tag-row-label">Entities</span>
                  <div class="tag-row-chips">
                    {#each ents.slice(0, 4) as entity}
                      <button type="button" class="story-chip story-chip--entity" on:click={() => { selectedEntity = entity; }}>{entity.entityText}</button>
                    {/each}
                    {#if ents.length > 4}
                      <a href={articlePath(article.id)} class="story-chip story-chip--more" on:click={(event) => onNavigate(event, articlePath(article.id))}>+{ents.length - 4} more</a>
                    {/if}
                  </div>
                </div>
              {/if}
            {/if}
          </aside>
        </div>
      </div>
    </article>
  {/each}
</div>

<EntityPopover entity={selectedEntity} onClose={() => {
  selectedEntity = null;
}} />

<style>
  .eyebrow,
  .signals {
    color: var(--muted, #58708f);
    font-size: 0.78rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  h3,
  h4 {
    margin: 0;
    letter-spacing: -0.03em;
  }

  .story-title-link {
    color: inherit;
    text-decoration: none;
  }

  .story-title-link:hover {
    text-decoration: underline;
  }

  h3 {
    font-size: 1.12rem;
  }

  h4 {
    font-size: 1.02rem;
    margin: 8px 0;
  }

  a {
    color: inherit;
  }

  .detail-head {
    position: relative;
    z-index: 10;
    border-bottom: 1px solid var(--border, rgba(28, 46, 73, 0.12));
    margin: -2px -2px 12px;
    padding: 2px 2px 0;
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.99), rgba(255, 255, 255, 0.95));
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: 16px;
  }

  .page-actions {
    flex: 0 0 auto;
    padding-top: 4px;
  }

  .inline-actions {
    margin-top: 10px;
  }

  .back-link {
    display: inline-flex;
    align-items: center;
    text-decoration: none;
  }

  .comparison {
    padding: 12px 0 18px;
    margin-bottom: 8px;
  }

  .domain-strip {
    margin-top: 10px;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .domain-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 9px;
    border-radius: 999px;
    border: 1px solid var(--border, rgba(28, 46, 73, 0.12));
    background: rgba(255, 255, 255, 0.86);
    color: #2f435e;
    font-size: 0.82rem;
    line-height: 1;
  }

  .domain-link {
    text-decoration: none;
    color: inherit;
  }

  .domain-link:hover {
    border-color: var(--border-strong, rgba(37, 87, 167, 0.24));
    box-shadow: 0 6px 14px rgba(20, 55, 111, 0.12);
  }

  .domain-more {
    display: inline-flex;
    align-items: center;
    color: var(--muted, #58708f);
    font-size: 0.8rem;
    padding-left: 2px;
  }

  .favicon {
    border-radius: 3px;
    flex: 0 0 14px;
  }

  .article-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .chip-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 10px;
  }

  .chip {
    padding: 6px 10px;
    border-radius: 999px;
    background: var(--accent-soft, #dce8ff);
    color: var(--accent-strong, #0a3c96);
    font-size: 0.84rem;
    font-weight: 600;
    text-decoration: none;
  }

  .chip:hover {
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  .article-grid {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 14px;
    max-height: 560px;
    overflow-y: auto;
    overflow-x: hidden;
    padding-right: 6px;
    background: linear-gradient(180deg, rgba(245, 249, 255, 0.92), rgba(245, 249, 255, 0) 44px);
    margin-top: 10px;
  }

  .article-grid--focus {
    max-height: none;
    overflow-y: visible;
    overflow-x: visible;
    padding-right: 0;
  }

  .article-grid--focus .article-head-rail {
    position: static;
  }

  .article-date-link {
    color: inherit;
    text-decoration: none;
    border-bottom: 1px dotted rgba(88, 112, 143, 0.5);
  }

  .article-date-link:hover {
    color: var(--accent-strong, #0a3c96);
    border-bottom-color: currentColor;
  }

  .article-entry {
    position: relative;
  }

  .article-head-rail {
    position: sticky;
    top: 0;
    z-index: 8;
    background: linear-gradient(180deg, rgba(245, 249, 255, 0.98), rgba(245, 249, 255, 0.94));
  }

  .article-card-body {
    position: relative;
    z-index: 1;
    margin-top: -1px;
    padding: 0;
    border-radius: 0 0 16px 16px;
    border: 1px solid var(--border, rgba(28, 46, 73, 0.12));
    border-top: 0;
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.96), rgba(242, 248, 255, 0.84));
    overflow: hidden;
    transition:
      border-color 140ms ease,
      box-shadow 140ms ease;
  }

  .article-entry:hover .article-head,
  .article-entry:hover .article-card-body {
    border-color: var(--border-strong, rgba(37, 87, 167, 0.24));
  }

  .article-entry:hover .article-card-body {
    box-shadow: 0 12px 24px rgba(20, 55, 111, 0.12);
  }

  .article-head {
    position: relative;
    margin: 0;
    padding: 10px 14px 8px;
    display: grid;
    gap: 6px;
    border: 1px solid var(--border, rgba(28, 46, 73, 0.12));
    border-bottom: 1px solid rgba(20, 55, 111, 0.08);
    border-radius: 16px 16px 0 0;
    background: #f7fbff;
    box-shadow:
      0 1px 0 rgba(20, 55, 111, 0.08),
      0 8px 16px rgba(20, 55, 111, 0.06);
  }

  .article-head .meta {
    margin: 0;
  }

  .article-body {
    padding: 14px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(330px, 27rem);
    gap: 18px;
    align-items: start;
  }

  .article-main {
    display: grid;
    gap: 10px;
    min-width: 0;
  }

  .article-body p {
    margin: 0;
    line-height: 1.5;
    color: #34455d;
  }

  @media (max-width: 760px) {
    .article-body {
      grid-template-columns: 1fr;
    }
  }

  .read-source {
    color: var(--accent-strong, #0a3c96);
    font-weight: 600;
    text-decoration: none;
    justify-self: start;
  }

  .read-source:hover {
    text-decoration: underline;
  }

  .entity-loading,
  .entity-error {
    color: var(--muted, #58708f);
    font-size: 0.82rem;
  }

  .placeholder-pending {
    margin: 0;
    color: var(--muted, #58708f);
    font-size: 0.85rem;
    font-style: italic;
  }

  .entity-error {
    color: #8b1e3f;
  }

  .article-tag-strip {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 10px 12px;
    border-radius: 12px;
    background: rgba(245, 249, 255, 0.7);
    border: 1px solid rgba(28, 46, 73, 0.08);
    min-width: 0;
  }

  .tag-row {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .tag-row-label {
    color: var(--muted, #58708f);
    font-size: 0.72rem;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    font-weight: 600;
  }

  .tag-row-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .story-chip {
    display: inline-block;
    padding: 6px 10px;
    border-radius: 999px;
    background: var(--accent-soft, #dce8ff);
    color: var(--accent-strong, #0a3c96);
    font-size: 0.84rem;
    font-weight: 600;
    text-decoration: none;
    border: 0;
    cursor: pointer;
    line-height: 1.2;
    font-family: inherit;
  }

  .story-chip:hover {
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  .story-chip--more {
    background: transparent;
    color: var(--muted, #58708f);
    border: 1px dashed rgba(88, 112, 143, 0.4);
  }

  .story-chip--more:hover {
    text-decoration: none;
    border-color: var(--accent-strong, #0a3c96);
    color: var(--accent-strong, #0a3c96);
  }

  .sentiment-pill,
  .lang-pill {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.02em;
    line-height: 1.4;
    text-transform: none;
  }

  .sentiment-pill--positive {
    background: #dff5e1;
    color: #1e6b3a;
  }

  .sentiment-pill--neutral {
    background: #eef0f4;
    color: #4a5568;
  }

  .sentiment-pill--negative {
    background: #fde2e4;
    color: #8b1e3f;
  }

  .lang-pill {
    background: rgba(37, 87, 167, 0.1);
    color: var(--accent-strong, #0a3c96);
    border: 1px solid rgba(37, 87, 167, 0.2);
  }

  .entity-sidebar {
    min-width: 0;
  }

  @media (max-width: 980px) {
    .entity-content {
      grid-template-columns: 1fr;
    }
  }
</style>
