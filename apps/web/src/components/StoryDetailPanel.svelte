<script lang="ts">
  import type { LinkedEntity, StoryComparison, StoryDetail } from "@news/shared";
  import EntityHighlighter from "./EntityHighlighter.svelte";
  import EntityPopover from "./EntityPopover.svelte";
  import EntityStats from "./EntityStats.svelte";
  import PerspectivePanel from "./PerspectivePanel.svelte";

  interface Props {
    story: StoryDetail;
    comparison: StoryComparison | null;
    articlePath: (id: string) => string;
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
  }

  let {
    story,
    comparison,
    articlePath,
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
  }: Props = $props();

  let entityMap: Record<string, LinkedEntity[]> = {};
  let entityLoadingByArticleId: Record<string, boolean> = {};
  let entityErrorByArticleId: Record<string, string> = {};
  let selectedEntity: LinkedEntity | null = null;
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

  function entityTextForArticle(article: StoryDetail["articles"][number]): string | null {
    if (article.fullText?.trim()) return article.fullText;
    return null;
  }

  function handleEntityClick(event: CustomEvent<{ entity: LinkedEntity }>): void {
    selectedEntity = event.detail.entity;
  }

  $effect(() => {
    if (!showEntities) return;
    if (loadedStoryId === story.id) return;
    loadedStoryId = story.id;
    void preloadStoryEntities();
  });
</script>

<div class="detail-head">
  <header>
    <p class="eyebrow">
      {formatScopeLabel(story.region, story.category)}
    </p>
    <h3>
      <a
        class="story-title-link"
        href={`/stories/${encodeURIComponent(story.id)}`}
        on:click={(event) => onNavigate(event, `/stories/${encodeURIComponent(story.id)}`)}
      >
        {story.translatedTitle ?? story.title}
      </a>
    </h3>
    {#if story.translatedTitle && story.translatedTitle !== story.title}
      <p class="original-title" title="Original title">{story.title}</p>
    {/if}
    <p>
      {story.articleCount} articles across
      {story.sourceCount} sources ·
      {formatDateRange(story.dateFrom, story.dateUntil)}
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
  articles={story.articles.map((a) => ({ id: a.id, sourceName: a.sourceName, domain: a.domain, url: a.url }))}
  {articlePath}
  {onNavigate}
  {faviconUrl}
  {onFaviconError}
/>

<div class="article-grid">
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
            <span>· {article.publishedAt.slice(0, 10)}</span>
          </p>
          <h4><a href={articlePath(article.id)} on:click={(event) => onNavigate(event, articlePath(article.id))}>{article.title}</a></h4>
        </header>
      </div>
      <div class="article-card-body">
        <div class="article-body">
          <p>{article.summary ?? "No summary available."}</p>
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
          <p class="signals">
            Sentiment {article.sentiment} · Subjectivity {article.subjectivity}
          </p>
          {#if article.keywords.length > 0}
            <p class="signals">
              {#each article.keywords as keyword, keywordIndex}
                {#if keywordIndex > 0}, {/if}
                <a href={tagPath(keyword)} on:click={(event) => onNavigate(event, tagPath(keyword))}>{keyword}</a>
              {/each}
            </p>
          {/if}
          {#if showEntities}
            <div class="entity-section">
              <div class="entity-section-head">
                <span class="signals">Named entities</span>
                {#if entityLoadingByArticleId[article.id]}
                  <span class="entity-loading">Loading entities...</span>
                {/if}
              </div>

              {#if entityErrorByArticleId[article.id]}
                <p class="entity-error">{entityErrorByArticleId[article.id]}</p>
              {:else}
                {#if entityTextForArticle(article)}
                  <div class="entity-content">
                    <div class="entity-text-card">
                      <EntityHighlighter
                        text={entityTextForArticle(article) ?? ""}
                        entities={entityMap[article.id] ?? []}
                        on:entity-click={handleEntityClick}
                      />
                    </div>
                    <div class="entity-sidebar">
                      <EntityStats
                        entities={entityMap[article.id] ?? []}
                        selectedEntityId={selectedEntity?.id ?? null}
                        onEntitySelect={(entity) => {
                          selectedEntity = entity;
                        }}
                      />
                    </div>
                  </div>
                {:else if (entityMap[article.id] ?? []).length > 0}
                  <div class="entity-sidebar entity-sidebar--full">
                    <EntityStats
                      entities={entityMap[article.id] ?? []}
                      selectedEntityId={selectedEntity?.id ?? null}
                      onEntitySelect={(entity) => {
                        selectedEntity = entity;
                      }}
                    />
                  </div>
                {:else if entityMap[article.id] !== undefined}
                  <p class="entity-empty">No named entities found</p>
                {:else if !entityLoadingByArticleId[article.id]}
                  <p class="entity-empty">Named entities pending</p>
                {/if}
              {/if}
            </div>
          {/if}
          <a href={article.url} target="_blank" rel="noreferrer">Read source</a>
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
    gap: 10px;
  }

  .article-body p {
    margin: 0;
    line-height: 1.5;
    color: #34455d;
  }

  .article-body a:last-child {
    color: var(--accent-strong, #0a3c96);
    font-weight: 600;
    text-decoration: none;
  }

  .article-body a:last-child:hover {
    text-decoration: underline;
  }

  .entity-section {
    display: grid;
    gap: 10px;
  }

  .entity-section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .entity-loading,
  .entity-error,
  .entity-empty {
    color: var(--muted, #58708f);
    font-size: 0.82rem;
  }

  .entity-empty {
    margin: 0;
    font-style: italic;
  }

  .entity-error {
    margin: 0;
    color: #8b1e3f;
  }

  .entity-content {
    display: grid;
    grid-template-columns: minmax(0, 1.5fr) minmax(220px, 0.9fr);
    gap: 12px;
    align-items: start;
  }

  .entity-text-card,
  .entity-sidebar--full {
    padding: 12px;
    border-radius: 12px;
    border: 1px solid rgba(37, 87, 167, 0.16);
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.88), rgba(240, 247, 255, 0.84));
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
