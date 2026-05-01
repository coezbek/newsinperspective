<script lang="ts">
  import { onMount } from "svelte";
  import type { SourceProfileDto, StoryComparison, StoryDetail, StoryFacetDto, StoryListItem, TagProfileDto } from "@news/shared";

  const API_BASE =
    typeof window !== "undefined"
      ? `${window.location.protocol}//${window.location.hostname}:4400`
      : "http://localhost:4400";
  const STORIES_PER_DAY = 10;
  const DEVTOOLS_LABEL_CLASS = "debug-component-labels";
  const DEVTOOLS_OVERLAY_CLASS = "debug-component-overlay";
  const DEVTOOLS_OPEN_THRESHOLD = 160;

  interface DaySection {
    date: string;
    categories: string[];
    selectedCategory: string;
    stories: StoryListItem[];
    selectedStory: StoryDetail | null;
    comparison: StoryComparison | null;
    loading: boolean;
    error: string;
  }

  type ViewState =
    | { kind: "feed" }
    | { kind: "source"; domain: string }
    | { kind: "tag"; keyword: string };

  let dates: string[] = [];
  let startDate = "";
  let preferredRegion = "";
  let settingsOpen = false;
  let daySections: DaySection[] = [];
  let currentView: ViewState = { kind: "feed" };
  let sourceProfile: SourceProfileDto | null = null;
  let sourceLoading = false;
  let sourceError = "";
  let tagProfile: TagProfileDto | null = null;
  let tagLoading = false;
  let tagError = "";
  let globalError = "";
  let loadingNextDate = false;
  let nextDateCursor = 0;
  let loadedFeedSignature = "";
  let infiniteObserver: IntersectionObserver | null = null;
  let activeDebugNodes: HTMLElement[] = [];
  let debugOverlay: HTMLDivElement | null = null;
  let debugRenderFrame: number | null = null;

  function setComponentLabelVisibility(active: boolean): void {
    if (typeof document === "undefined" || !import.meta.env.DEV) return;
    document.documentElement.classList.toggle(DEVTOOLS_LABEL_CLASS, active);
    if (!active) {
      activeDebugNodes = [];
    }
    requestDebugRender();
  }

  function devtoolsAreOpen(): boolean {
    if (typeof window === "undefined") return false;
    return window.outerWidth - window.innerWidth > DEVTOOLS_OPEN_THRESHOLD
      || window.outerHeight - window.innerHeight > DEVTOOLS_OPEN_THRESHOLD;
  }

  function shortId(value: string, max = 10): string {
    return value.length > max ? `${value.slice(0, max)}...` : value;
  }

  function componentLabel(name: string, detail?: string): string {
    return detail ? `${name} [${detail}]` : name;
  }

  function debugComponent(node: HTMLElement, label: string): { update: (value: string) => void; destroy: () => void } {
    if (!import.meta.env.DEV) {
      return {
        update() {},
        destroy() {},
      };
    }

    const applyLabel = (value: string) => {
      node.dataset.debugComponent = value;
    };

    applyLabel(label);

    return {
      update(value: string) {
        applyLabel(value);
      },
      destroy() {
        delete node.dataset.debugComponent;
      },
    };
  }

  function ensureDebugOverlay(): HTMLDivElement | null {
    if (typeof document === "undefined" || !import.meta.env.DEV) return null;
    if (debugOverlay?.isConnected) return debugOverlay;

    const overlay = document.createElement("div");
    overlay.className = DEVTOOLS_OVERLAY_CLASS;
    overlay.setAttribute("aria-hidden", "true");
    document.body.appendChild(overlay);
    debugOverlay = overlay;
    return overlay;
  }

  function clearDebugOverlay(): void {
    if (debugOverlay) {
      debugOverlay.replaceChildren();
    }
  }

  function getDebugNodeChain(target: EventTarget | null): HTMLElement[] {
    if (!(target instanceof Element)) return [];

    const chain: HTMLElement[] = [];
    let current: Element | null = target;

    while (current) {
      if (current instanceof HTMLElement && current.dataset.debugComponent) {
        chain.push(current);
      }
      current = current.parentElement;
    }

    return chain.reverse();
  }

  function sameDebugNodeChain(nextNodes: HTMLElement[]): boolean {
    return nextNodes.length === activeDebugNodes.length
      && nextNodes.every((node, index) => node === activeDebugNodes[index]);
  }

  function renderDebugOverlay(): void {
    debugRenderFrame = null;

    if (!import.meta.env.DEV || typeof document === "undefined") return;

    const overlay = ensureDebugOverlay();
    if (!overlay) return;

    clearDebugOverlay();

    if (!document.documentElement.classList.contains(DEVTOOLS_LABEL_CLASS) || activeDebugNodes.length === 0) {
      return;
    }

    const placedLabels: Array<{ top: number; left: number; right: number; bottom: number }> = [];
    const viewportPadding = 8;
    const overlapGap = 6;

    for (const node of activeDebugNodes) {
      const labelText = node.dataset.debugComponent;
      if (!labelText) continue;

      const rect = node.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;

      const label = document.createElement("div");
      label.className = `${DEVTOOLS_OVERLAY_CLASS}-label`;
      label.textContent = labelText;
      overlay.appendChild(label);

      const labelWidth = label.offsetWidth;
      const labelHeight = label.offsetHeight;
      let left = Math.round(rect.left + 8);
      let top = Math.round(rect.top - labelHeight - 6);

      if (left + labelWidth > window.innerWidth - viewportPadding) {
        left = Math.max(viewportPadding, window.innerWidth - viewportPadding - labelWidth);
      }
      if (top < viewportPadding) {
        top = Math.round(rect.top + 6);
      }

      let adjusted = true;
      while (adjusted) {
        adjusted = false;

        for (const placed of placedLabels) {
          const overlaps = left < placed.right
            && left + labelWidth > placed.left
            && top < placed.bottom
            && top + labelHeight > placed.top;

          if (!overlaps) continue;

          top = placed.bottom + overlapGap;
          if (top + labelHeight > window.innerHeight - viewportPadding) {
            top = Math.max(viewportPadding, Math.round(rect.top - labelHeight - 6));
          }
          adjusted = true;
        }
      }

      if (top + labelHeight > window.innerHeight - viewportPadding) {
        top = Math.max(viewportPadding, window.innerHeight - viewportPadding - labelHeight);
      }

      label.style.transform = `translate(${left}px, ${top}px)`;
      placedLabels.push({
        top,
        left,
        right: left + labelWidth,
        bottom: top + labelHeight,
      });
    }
  }

  function requestDebugRender(): void {
    if (!import.meta.env.DEV || typeof window === "undefined") return;
    if (debugRenderFrame !== null) return;
    debugRenderFrame = window.requestAnimationFrame(renderDebugOverlay);
  }

  function handleDebugPointer(event: MouseEvent): void {
    if (!import.meta.env.DEV || typeof document === "undefined") return;
    if (!document.documentElement.classList.contains(DEVTOOLS_LABEL_CLASS)) return;

    const nextNodes = getDebugNodeChain(event.target);
    if (sameDebugNodeChain(nextNodes)) return;

    activeDebugNodes = nextNodes;
    requestDebugRender();
  }

  function handleDebugPointerLeave(): void {
    if (activeDebugNodes.length === 0) return;
    activeDebugNodes = [];
    requestDebugRender();
  }

  function formatDateRange(dateFrom: string, dateUntil: string): string {
    return dateFrom === dateUntil ? dateFrom : `${dateFrom} to ${dateUntil}`;
  }

  function extractRegion(category: string | null): string {
    return category?.split(" | ")[0]?.trim() ?? "";
  }

  function formatCategoryLabel(category: string | null): string {
    if (!category) return "All";
    const parts = category.split(" | ").map((value) => value.trim()).filter(Boolean);
    return parts[parts.length - 1] ?? category;
  }

  function normalizeScopeLabel(value: string | null | undefined): string {
    return (value ?? "").trim().toLowerCase();
  }

  function formatScopeLabel(region: string | null | undefined, category: string | null | undefined): string {
    const formattedCategory = formatCategoryLabel(category ?? null);
    const formattedRegion = (region ?? "").trim();
    const same = normalizeScopeLabel(formattedRegion) !== "" &&
      normalizeScopeLabel(formattedRegion) === normalizeScopeLabel(formattedCategory);

    if (same) return formattedCategory;
    if (formattedRegion && formattedCategory) return `${formattedRegion} · ${formattedCategory}`;
    return formattedRegion || formattedCategory || "General";
  }

  function storySourceTotal(section: DaySection): number {
    return section.stories.reduce((sum, story) => sum + story.sourceCount, 0);
  }

  function storyArticleTotal(section: DaySection): number {
    return section.stories.reduce((sum, story) => sum + story.articleCount, 0);
  }

  function faviconUrl(domain: string): string {
    return `${API_BASE}/api/favicons/${encodeURIComponent(domain)}`;
  }

  function sourcePath(domain: string): string {
    return `/newssite/${encodeURIComponent(domain)}`;
  }

  function tagPath(keyword: string): string {
    return `/tag/${encodeURIComponent(keyword)}`;
  }

  function activeKeywordFilter(): string {
    return currentView.kind === "tag" ? currentView.keyword : "";
  }

  function parseViewFromPath(pathname: string): ViewState {
    const sourceMatch = pathname.match(/^\/newssite\/(.+)$/);
    if (sourceMatch?.[1]) {
      return { kind: "source", domain: decodeURIComponent(sourceMatch[1]) };
    }

    const tagMatch = pathname.match(/^\/tag\/(.+)$/);
    if (tagMatch?.[1]) {
      return { kind: "tag", keyword: decodeURIComponent(tagMatch[1]) };
    }

    return { kind: "feed" };
  }

  function navigate(path: string): void {
    if (typeof window === "undefined") return;
    if (window.location.pathname === path) return;
    window.history.pushState({}, "", path);
    void syncRouteFromLocation();
  }

  function handleInternalNavigation(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    navigate(path);
  }

  function handleFaviconError(event: Event): void {
    const target = event.currentTarget as HTMLImageElement | null;
    if (!target) return;
    target.style.display = "none";
  }

  function otherSourceCount(story: StoryDetail | null): number {
    if (!story) return 0;
    return Math.max(0, story.sourceCount - story.topDomains.length);
  }

  function updateSection(date: string, updater: (section: DaySection) => DaySection): void {
    daySections = daySections.map((section) =>
      section.date === date ? updater(section) : section,
    );
  }

  function getSection(date: string): DaySection | undefined {
    return daySections.find((section) => section.date === date);
  }

  async function fetchJson<T>(path: string): Promise<T> {
    const response = await fetch(`${API_BASE}${path}`);
    if (!response.ok) {
      throw new Error(`Request failed: ${response.status}`);
    }
    return response.json() as Promise<T>;
  }

  async function fetchStoriesForDay(date: string, category: string): Promise<StoryListItem[]> {
    const params = new URLSearchParams({
      date,
      offset: "0",
      limit: String(STORIES_PER_DAY),
    });

    if (preferredRegion) params.set("region", preferredRegion);
    if (category) params.set("category", category);
    if (activeKeywordFilter()) params.set("keyword", activeKeywordFilter());

    return fetchJson<StoryListItem[]>(`/api/stories?${params.toString()}`);
  }

  async function ensureFeedDatesLoaded(): Promise<void> {
    if (dates.length > 0) return;
    dates = await fetchJson<string[]>("/api/dates");
    if (!startDate && dates[0]) {
      startDate = dates[0];
    }
  }

  async function loadStoryForSection(date: string, storyId: string): Promise<void> {
    const current = getSection(date);
    if (!current || !current.stories.some((story) => story.id === storyId)) return;

    try {
      const [selectedStory, comparison] = await Promise.all([
        fetchJson<StoryDetail>(`/api/stories/${storyId}`),
        fetchJson<StoryComparison>(`/api/stories/${storyId}/comparison`),
      ]);

      updateSection(date, (section) => {
        if (!section.stories.some((story) => story.id === storyId)) return section;
        return {
          ...section,
          selectedStory,
          comparison,
        };
      });
    } catch (value) {
      const message = value instanceof Error ? value.message : "Failed to load story";
      updateSection(date, (section) => ({
        ...section,
        error: message,
      }));
    }
  }

  async function handleCategoryChange(date: string, category: string): Promise<void> {
    const section = getSection(date);
    if (!section || section.loading) return;

    const nextCategory = section.selectedCategory === category ? "" : category;
    updateSection(date, (existing) => ({
      ...existing,
      loading: true,
      selectedCategory: nextCategory,
      selectedStory: null,
      comparison: null,
      error: "",
    }));

    try {
      const stories = await fetchStoriesForDay(date, nextCategory);
      updateSection(date, (existing) => ({
        ...existing,
        loading: false,
        stories,
      }));

      if (stories[0]) {
        await loadStoryForSection(date, stories[0].id);
      }
    } catch (value) {
      const message = value instanceof Error ? value.message : "Failed to load stories";
      updateSection(date, (existing) => ({
        ...existing,
        loading: false,
        error: message,
      }));
    }
  }

  async function appendDateSection(date: string): Promise<void> {
    const placeholder: DaySection = {
      date,
      categories: [],
      selectedCategory: "",
      stories: [],
      selectedStory: null,
      comparison: null,
      loading: true,
      error: "",
    };
    daySections = [...daySections, placeholder];

    try {
      const [facets, stories] = await Promise.all([
        fetchJson<StoryFacetDto>(`/api/facets?${new URLSearchParams({
          date,
          ...(activeKeywordFilter() ? { keyword: activeKeywordFilter() } : {}),
        }).toString()}`),
        fetchStoriesForDay(date, ""),
      ]);

      const categories = (facets.categories ?? []).filter(
        (category) => !preferredRegion || extractRegion(category) === preferredRegion,
      );

      updateSection(date, (section) => ({
        ...section,
        categories,
        stories,
        loading: false,
      }));

      if (stories[0]) {
        await loadStoryForSection(date, stories[0].id);
      }
    } catch (value) {
      const message = value instanceof Error ? value.message : "Failed to load date section";
      updateSection(date, (section) => ({
        ...section,
        loading: false,
        error: message,
      }));
    }
  }

  async function loadNextDateSection(): Promise<void> {
    if (loadingNextDate) return;
    if (nextDateCursor >= dates.length) return;

    loadingNextDate = true;
    const date = dates[nextDateCursor];
    nextDateCursor += 1;

    try {
      await appendDateSection(date);
    } finally {
      loadingNextDate = false;
    }
  }

  async function resetFeed(): Promise<void> {
    globalError = "";
    daySections = [];
    loadedFeedSignature = currentView.kind === "tag" ? `tag:${currentView.keyword}` : "feed";

    const startIndex = dates.indexOf(startDate);
    nextDateCursor = startIndex >= 0 ? startIndex : 0;
    await loadNextDateSection();
  }

  async function handleStartDateChange(): Promise<void> {
    await resetFeed();
  }

  async function handlePreferredRegionChange(): Promise<void> {
    await resetFeed();
  }

  async function loadSourcePage(domain: string): Promise<void> {
    sourceLoading = true;
    sourceError = "";
    sourceProfile = null;

    try {
      sourceProfile = await fetchJson<SourceProfileDto>(`/api/sources/${encodeURIComponent(domain)}`);
    } catch (value) {
      sourceError = value instanceof Error ? value.message : "Failed to load source profile";
    } finally {
      sourceLoading = false;
    }
  }

  async function loadTagPage(keyword: string): Promise<void> {
    tagLoading = true;
    tagError = "";
    tagProfile = null;

    try {
      tagProfile = await fetchJson<TagProfileDto>(`/api/tags/${encodeURIComponent(keyword)}`);
      await ensureFeedDatesLoaded();
      await resetFeed();
    } catch (value) {
      tagError = value instanceof Error ? value.message : "Failed to load keyword profile";
    } finally {
      tagLoading = false;
    }
  }

  async function syncRouteFromLocation(): Promise<void> {
    if (typeof window === "undefined") return;
    currentView = parseViewFromPath(window.location.pathname);

    if (currentView.kind === "source") {
      await loadSourcePage(currentView.domain);
      return;
    }

    if (currentView.kind === "tag") {
      await loadTagPage(currentView.keyword);
      return;
    }

    await ensureFeedDatesLoaded();
    const nextSignature = "feed";
    if ((daySections.length === 0 || loadedFeedSignature !== nextSignature) && dates[0]) {
      await resetFeed();
    }
  }

  function observeInfiniteScroll(node: HTMLDivElement): { destroy: () => void } {
    infiniteObserver?.disconnect();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            loadNextDateSection();
          }
        }
      },
      { rootMargin: "360px 0px" },
    );

    observer.observe(node);
    infiniteObserver = observer;

    return {
      destroy() {
        observer.disconnect();
        if (infiniteObserver === observer) {
          infiniteObserver = null;
        }
      },
    };
  }

  onMount(() => {
    let devtoolsInterval: number | null = null;
    let syncDevtools: (() => void) | null = null;
    const handlePopState = () => {
      void syncRouteFromLocation();
    };

    if (import.meta.env.DEV) {
      syncDevtools = () => {
        setComponentLabelVisibility(devtoolsAreOpen());
      };

      syncDevtools();
      devtoolsInterval = window.setInterval(syncDevtools, 900);
      window.addEventListener("resize", syncDevtools);
      window.addEventListener("resize", requestDebugRender);
      window.addEventListener("scroll", requestDebugRender, true);
      document.addEventListener("mouseover", handleDebugPointer, true);
      document.addEventListener("mouseleave", handleDebugPointerLeave, true);
    }

    window.addEventListener("popstate", handlePopState);

    (async () => {
      await ensureFeedDatesLoaded();
      await syncRouteFromLocation();
    })().catch((value) => {
      globalError = value instanceof Error ? value.message : "Failed to initialize feed";
    });

    return () => {
      if (devtoolsInterval !== null) {
        window.clearInterval(devtoolsInterval);
      }
      if (syncDevtools) {
        window.removeEventListener("resize", syncDevtools);
      }
      window.removeEventListener("resize", requestDebugRender);
      window.removeEventListener("scroll", requestDebugRender, true);
      window.removeEventListener("popstate", handlePopState);
      document.removeEventListener("mouseover", handleDebugPointer, true);
      document.removeEventListener("mouseleave", handleDebugPointerLeave, true);
      if (debugRenderFrame !== null) {
        window.cancelAnimationFrame(debugRenderFrame);
        debugRenderFrame = null;
      }
      debugOverlay?.remove();
      debugOverlay = null;
      setComponentLabelVisibility(false);
      infiniteObserver?.disconnect();
    };
  });
</script>

<svelte:head>
  <title>
    {currentView.kind === "source"
      ? `${currentView.domain} · NewsInPerspective`
      : currentView.kind === "tag"
        ? `${currentView.keyword} · NewsInPerspective`
        : "NewsInPerspective"}
  </title>
</svelte:head>

<main class="shell" use:debugComponent={componentLabel("AppShell")}>
  <section class="hero panel" use:debugComponent={componentLabel("HeroPanel")}>
    <p class="eyebrow">NewsInPerspective</p>
    <div class="hero-row">
      <div>
        <h1>See how the same story moves across outlets, regions, and days.</h1>
        <p class="lede">
          {#if currentView.kind === "feed"}
            Each date section shows its own category chooser, top story feed, and cluster explorer.
            Scroll down to load the next day.
          {:else if currentView.kind === "source"}
            Source profiles combine outlet metadata with the stories currently associated with that domain.
          {:else}
            Keyword pages show where a topic appears, which sources publish it, and what other entities travel with it.
          {/if}
        </p>
      </div>

      <button class="settings-button" type="button" on:click={() => (settingsOpen = !settingsOpen)}>
        <span aria-hidden="true">⚙</span>
        <span>Settings</span>
      </button>
    </div>

    {#if settingsOpen && currentView.kind === "feed"}
      <div class="settings-panel" use:debugComponent={componentLabel("SettingsPanel")}>
        <label>
          <span>Start date</span>
          <select bind:value={startDate} on:change={handleStartDateChange}>
            {#each dates as date}
              <option value={date}>{date}</option>
            {/each}
          </select>
        </label>

        <label>
          <span>Preferred region</span>
          <select bind:value={preferredRegion} on:change={handlePreferredRegionChange}>
            <option value="">All regions</option>
            {#each [...new Set(daySections.flatMap((section) => section.categories.map((category) => extractRegion(category)).filter(Boolean)))] as region}
              <option value={region}>{region}</option>
            {/each}
          </select>
        </label>
      </div>
    {/if}
  </section>

  {#if globalError}
    <p class="error" use:debugComponent={componentLabel("GlobalError")}>{globalError}</p>
  {/if}

  {#if currentView.kind === "source"}
    <section class="panel focus-page" use:debugComponent={componentLabel("SourcePage", currentView.domain)}>
      <div class="detail-head">
        <div>
          <p class="eyebrow">News Source</p>
          <div class="source-title-row">
            <img class="favicon source-favicon" src={faviconUrl(currentView.domain)} alt="" loading="lazy" width="18" height="18" on:error={handleFaviconError} />
            <h2>{currentView.domain}</h2>
          </div>
        </div>
        <div class="page-actions">
          <a href="/" class="tab back-link" on:click={(event) => handleInternalNavigation(event, "/")}>Back to feed</a>
        </div>
      </div>

      {#if sourceLoading}
        <p class="loading">Loading source profile...</p>
      {:else if sourceError}
        <p class="error">{sourceError}</p>
      {:else if sourceProfile}
        <div class="focus-grid">
          <section class="panel inset-panel">
            <p class="eyebrow">Profile</p>
            <h3>{sourceProfile.sourceName}</h3>
            <p>{sourceProfile.description ?? "No enriched source description is available yet."}</p>
            <div class="chip-row">
              {#if sourceProfile.country}<span class="chip">Country: {sourceProfile.country}</span>{/if}
              {#if sourceProfile.countryOfOrigin}<span class="chip">Origin: {sourceProfile.countryOfOrigin}</span>{/if}
              {#if sourceProfile.headquarters}<span class="chip">HQ: {sourceProfile.headquarters}</span>{/if}
              {#if sourceProfile.mediaOwner}<span class="chip">Owner: {sourceProfile.mediaOwner}</span>{/if}
              {#if sourceProfile.ownershipType}<span class="chip">Ownership: {sourceProfile.ownershipType}</span>{/if}
              {#if sourceProfile.employeeCount}<span class="chip">Employees: {sourceProfile.employeeCount}</span>{/if}
            </div>
            {#if sourceProfile.wikipediaUrl}
              <p><a href={sourceProfile.wikipediaUrl} target="_blank" rel="noreferrer">Wikipedia</a></p>
            {/if}
            {#if sourceProfile.associatedEntities.length > 0}
              <div class="chip-row">
                {#each sourceProfile.associatedEntities as entity}
                  <span class="chip">{entity}</span>
                {/each}
              </div>
            {/if}
          </section>

          <section class="panel inset-panel">
            <p class="eyebrow">Facets</p>
            <div class="inline-stats">
              <div class="inline-stat"><span class="stat-label">Articles</span><strong>{sourceProfile.articleCount}</strong></div>
              <div class="inline-stat"><span class="stat-label">Sentiment</span><strong>{sourceProfile.averageSentiment}</strong></div>
              <div class="inline-stat"><span class="stat-label">Latest story</span><strong>{sourceProfile.latestStoryDate ?? "n/a"}</strong></div>
            </div>
            <div class="facet-list">
              {#each sourceProfile.topCategories as facet}
                <span class="chip">{facet.label} · {facet.count}</span>
              {/each}
            </div>
            <div class="facet-list">
              {#each sourceProfile.topKeywords as keyword}
                <a href={tagPath(keyword)} class="chip chip-link" on:click={(event) => handleInternalNavigation(event, tagPath(keyword))}>{keyword}</a>
              {/each}
            </div>
            <div class="facet-list">
              {#each sourceProfile.commonBiasSignals as signal}
                <span class="chip">{signal}</span>
              {/each}
            </div>
          </section>
        </div>

        <section class="panel inset-panel">
          <p class="eyebrow">Stories Featuring This Source</p>
          <div class="stories">
            {#each sourceProfile.stories as story}
              <article class="story-card">
                <span class="meta">
                  {formatCategoryLabel(story.category)} · {story.importanceScore} score · {story.sourceCount} sources
                </span>
                <strong>{story.title}</strong>
                <span class="signals">{formatDateRange(story.dateFrom, story.dateUntil)}</span>
                <span class="story-keywords">
                  {#each story.keywords as keyword, index}
                    {#if index > 0}, {/if}
                    <a href={tagPath(keyword)} on:click={(event) => handleInternalNavigation(event, tagPath(keyword))}>{keyword}</a>
                  {/each}
                </span>
              </article>
            {/each}
          </div>
        </section>
      {/if}
    </section>
  {:else if currentView.kind === "tag"}
    <section class="panel focus-page" use:debugComponent={componentLabel("TagPage", currentView.keyword)}>
      <div class="detail-head">
        <div>
          <p class="eyebrow">Keyword</p>
          <h2>{currentView.keyword}</h2>
        </div>
        <div class="page-actions">
          <a href="/" class="tab back-link" on:click={(event) => handleInternalNavigation(event, "/")}>Back to feed</a>
        </div>
      </div>

      {#if tagLoading}
        <p class="loading">Loading keyword profile...</p>
      {:else if tagError}
        <p class="error">{tagError}</p>
      {:else if tagProfile}
        <div class="focus-grid">
          <section class="panel inset-panel">
            <p class="eyebrow">Overview</p>
            <div class="inline-stats">
              <div class="inline-stat"><span class="stat-label">Stories</span><strong>{tagProfile.storyCount}</strong></div>
              <div class="inline-stat"><span class="stat-label">Articles</span><strong>{tagProfile.articleCount}</strong></div>
              <div class="inline-stat"><span class="stat-label">Sources</span><strong>{tagProfile.sourceCount}</strong></div>
            </div>
            <p>{tagProfile.dateFrom ?? "n/a"} to {tagProfile.dateUntil ?? "n/a"}</p>
            <div class="facet-list">
              {#each tagProfile.topDomains as facet}
                <a href={sourcePath(facet.label)} class="chip chip-link" on:click={(event) => handleInternalNavigation(event, sourcePath(facet.label))}>{facet.label} · {facet.count}</a>
              {/each}
            </div>
            <div class="facet-list">
              {#each tagProfile.topCategories as facet}
                <span class="chip">{facet.label} · {facet.count}</span>
              {/each}
            </div>
          </section>

          <section class="panel inset-panel">
            <p class="eyebrow">Related Terms</p>
            <div class="facet-list">
              {#each tagProfile.relatedKeywords as keyword}
                <a href={tagPath(keyword)} class="chip chip-link" on:click={(event) => handleInternalNavigation(event, tagPath(keyword))}>{keyword}</a>
              {/each}
            </div>
            <div class="facet-list">
              {#each tagProfile.relatedEntities as entity}
                <span class="chip">{entity}</span>
              {/each}
            </div>
          </section>
        </div>
      {/if}
    </section>
  {/if}

  {#if currentView.kind !== "source"}
    {#each daySections as section (section.date)}
    <section class="day-block panel" use:debugComponent={componentLabel("DaySection", section.date)}>
      <div class="day-separator" use:debugComponent={componentLabel("DaySeparator", section.date)}>
        <span>{section.date}</span>
      </div>

      <div class="day-head" use:debugComponent={componentLabel("DayHeader", section.date)}>
        <div>
          <p class="eyebrow">Top Stories</p>
          <h2>{section.date}</h2>
        </div>
        <div class="inline-stats">
          <div class="inline-stat">
            <span class="stat-label">Clusters</span>
            <strong>{section.stories.length}</strong>
          </div>
          <div class="inline-stat">
            <span class="stat-label">Sources</span>
            <strong>{storySourceTotal(section)}</strong>
          </div>
          <div class="inline-stat">
            <span class="stat-label">Articles</span>
            <strong>{storyArticleTotal(section)}</strong>
          </div>
        </div>
      </div>

      <div class="tab-row" use:debugComponent={componentLabel("CategoryTabs", section.date)}>
        <button
          class="tab"
          class:selected={!section.selectedCategory}
          use:debugComponent={componentLabel("CategoryTab", "All")}
          on:click={() => handleCategoryChange(section.date, "")}
        >
          All
        </button>
        {#each section.categories as category}
          <button
            class="tab"
            class:selected={section.selectedCategory === category}
            use:debugComponent={componentLabel("CategoryTab", formatCategoryLabel(category))}
            on:click={() => handleCategoryChange(section.date, category)}
          >
            {formatCategoryLabel(category)}
          </button>
        {/each}
      </div>

      <div class="day-layout" use:debugComponent={componentLabel("DayLayout", section.date)}>
        <div class="stories-column" use:debugComponent={componentLabel("StoryFeed", section.date)}>
          {#if section.error}
            <p class="error" use:debugComponent={componentLabel("SectionError", section.date)}>{section.error}</p>
          {/if}

          {#if section.loading && section.stories.length === 0}
            <p class="loading" use:debugComponent={componentLabel("StoryFeedLoading", section.date)}>Loading stories...</p>
          {/if}

          {#if !section.loading && section.stories.length === 0}
            <p class="loading" use:debugComponent={componentLabel("StoryFeedEmpty", section.date)}>No stories available for this date and category.</p>
          {/if}

          <div class="stories" use:debugComponent={componentLabel("StoryList", section.date)}>
            {#each section.stories as story}
              <button
                class="story-card"
                class:active={section.selectedStory?.id === story.id}
                use:debugComponent={componentLabel("StoryCard", shortId(story.id))}
                on:click={() => loadStoryForSection(section.date, story.id)}
              >
                <span class="meta">
                  {formatCategoryLabel(story.category)} · {story.importanceScore} score · {story.sourceCount} sources
                </span>
                <strong>{story.title}</strong>
                <span class="signals">{formatDateRange(story.dateFrom, story.dateUntil)}</span>
                <span class="story-keywords">
                  {#each story.keywords as keyword, index}
                    {#if index > 0}, {/if}
                    <a href={tagPath(keyword)} on:click|stopPropagation={(event) => handleInternalNavigation(event, tagPath(keyword))}>{keyword}</a>
                  {/each}
                </span>
              </button>
            {/each}
          </div>
        </div>

        <section class="detail panel" use:debugComponent={componentLabel("StoryDetail", section.date)}>
          {#if section.selectedStory}
            <div class="detail-head" use:debugComponent={componentLabel("DetailHeader", shortId(section.selectedStory.id))}>
              <header use:debugComponent={componentLabel("SelectedStoryHeader", shortId(section.selectedStory.id))}>
                <p class="eyebrow">
                  {formatScopeLabel(section.selectedStory.region, section.selectedStory.category)}
                </p>
                <h3>{section.selectedStory.title}</h3>
                <p>
                  {section.selectedStory.articleCount} articles across
                  {section.selectedStory.sourceCount} sources ·
                  {formatDateRange(section.selectedStory.dateFrom, section.selectedStory.dateUntil)}
                </p>
                <div
                  class="domain-strip"
                  aria-label="Top domains"
                  use:debugComponent={componentLabel("TopDomains", shortId(section.selectedStory.id))}
                >
                  {#each section.selectedStory.topDomains as domain}
                    <a
                      class="domain-chip domain-link"
                      href={sourcePath(domain)}
                      on:click={(event) => handleInternalNavigation(event, sourcePath(domain))}
                    >
                      <img
                        class="favicon"
                        src={faviconUrl(domain)}
                        alt=""
                        loading="lazy"
                        width="14"
                        height="14"
                        on:error={handleFaviconError}
                      />
                      <span>{domain}</span>
                    </a>
                  {/each}
                  {#if otherSourceCount(section.selectedStory) > 0}
                    <span class="domain-more">and {otherSourceCount(section.selectedStory)} other sources</span>
                  {/if}
                </div>
              </header>

              <div class="comparison" use:debugComponent={componentLabel("ComparisonSummary", shortId(section.selectedStory.id))}>
                {#if section.comparison}
                  <div class="chip-row">
                    {#each section.comparison.sharedKeywords as keyword}
                    <a href={tagPath(keyword)} class="chip" on:click={(event) => handleInternalNavigation(event, tagPath(keyword))}>{keyword}</a>
                    {/each}
                  </div>

                  {#each section.comparison.framingSummary as line}
                    <p>{line}</p>
                  {/each}
                {/if}
              </div>
            </div>

            <div class="article-grid" use:debugComponent={componentLabel("ArticleList", shortId(section.selectedStory.id))}>
              {#each section.selectedStory.articles as article}
                <article
                  id={`article-${article.id}`}
                  class="article-entry"
                  use:debugComponent={componentLabel("ArticleCard", `${article.domain} / ${shortId(article.id, 8)}`)}
                >
                  <div class="article-head-rail">
                    <header class="article-head" use:debugComponent={componentLabel("ArticleHeader", article.domain)}>
                      <p class="meta article-meta">
                        <a class="domain-chip domain-link" href={sourcePath(article.domain)} on:click={(event) => handleInternalNavigation(event, sourcePath(article.domain))}>
                          <img
                            class="favicon"
                            src={faviconUrl(article.domain)}
                            alt=""
                            loading="lazy"
                            width="14"
                            height="14"
                            on:error={handleFaviconError}
                          />
                          <span>{article.domain}</span>
                        </a>
                        <span>· {article.publishedAt.slice(0, 10)}</span>
                      </p>
                      <h4>{article.title}</h4>
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
                            <a href={`#article-${peer.articleId}`}>{peer.domain}</a>
                          {/each}
                        </p>
                      {:else if article.syndicatedDomains.length > 0}
                        <p class="signals">
                          Possible near-duplicate coverage on {article.syndicatedDomains.join(", ")}
                        </p>
                      {/if}
                      <p class="signals">
                        Sentiment {article.sentiment} · Subjectivity {article.subjectivity} ·
                        Bias &lt;not yet determined&gt;
                      </p>
                      {#if article.keywords.length > 0}
                        <p class="signals">
                          {#each article.keywords as keyword, keywordIndex}
                            {#if keywordIndex > 0}, {/if}
                            <a href={tagPath(keyword)} on:click={(event) => handleInternalNavigation(event, tagPath(keyword))}>{keyword}</a>
                          {/each}
                        </p>
                      {/if}
                      <a href={article.url} target="_blank" rel="noreferrer">Read source</a>
                    </div>
                  </div>
                </article>
              {/each}
            </div>
          {:else}
            <div class="empty" use:debugComponent={componentLabel("DetailEmptyState", section.date)}>
              <h3>Select a cluster</h3>
              <p>Pick a story card to inspect the cross-source detail.</p>
            </div>
          {/if}
        </section>
      </div>
    </section>
    {/each}

    <div
      class="load-anchor"
      use:observeInfiniteScroll
      use:debugComponent={componentLabel("InfiniteScrollAnchor")}
    >
      {#if loadingNextDate}
        <p>Loading next day...</p>
      {:else if nextDateCursor >= dates.length && daySections.length > 0}
        <p>No more dates.</p>
      {/if}
    </div>
  {/if}
</main>

<style>
  :global(:root) {
    --bg: #edf3f8;
    --panel: rgba(255, 255, 255, 0.84);
    --panel-strong: rgba(255, 255, 255, 0.96);
    --border: rgba(28, 46, 73, 0.12);
    --border-strong: rgba(37, 87, 167, 0.24);
    --text: #142033;
    --muted: #58708f;
    --accent: #0f62fe;
    --accent-soft: #dce8ff;
    --accent-strong: #0a3c96;
    --shadow: 0 20px 50px rgba(22, 43, 77, 0.12);
  }

  :global(body) {
    margin: 0;
    font-family: "IBM Plex Sans", "Avenir Next", "Segoe UI", sans-serif;
    background:
      radial-gradient(circle at top left, rgba(84, 161, 255, 0.2), transparent 28%),
      radial-gradient(circle at top right, rgba(11, 98, 254, 0.12), transparent 34%),
      linear-gradient(180deg, var(--bg) 0%, #f7fbff 100%);
    color: var(--text);
  }

  a {
    color: inherit;
  }

  .shell {
    max-width: 1320px;
    margin: 0 auto;
    padding: 24px 20px 60px;
  }

  .panel {
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.9), rgba(255, 255, 255, 0.78));
    border: 1px solid var(--border);
    border-radius: 26px;
    box-shadow: var(--shadow);
    backdrop-filter: blur(16px);
  }

  .hero,
  .day-block {
    padding: 20px 22px;
    margin-bottom: 16px;
  }

  .focus-page {
    padding: 22px;
  }

  .focus-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
    margin-bottom: 16px;
  }

  .inset-panel {
    padding: 18px;
    margin-bottom: 16px;
  }

  .facet-list {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 12px;
  }

  .hero-row,
  .day-head {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: 16px;
  }

  .eyebrow,
  .meta,
  .signals,
  .stat-label {
    color: var(--muted);
    font-size: 0.78rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  h1,
  h2,
  h3,
  h4 {
    margin: 0;
    letter-spacing: -0.03em;
  }

  h1 {
    margin: 6px 0 10px;
    font-size: clamp(1.45rem, 2vw, 2.2rem);
    line-height: 1.04;
    max-width: 36ch;
  }

  h2 {
    margin-top: 6px;
    font-size: 1.18rem;
  }

  h3 {
    font-size: 1.12rem;
  }

  h4 {
    font-size: 1.02rem;
    margin: 8px 0;
  }

  .lede {
    max-width: 60ch;
    margin: 0;
    color: #34455d;
    font-size: 0.93rem;
    line-height: 1.5;
  }

  .settings-button,
  .tab,
  .story-card {
    font: inherit;
  }

  .settings-button {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    border: 1px solid var(--border);
    background: rgba(255, 255, 255, 0.76);
    color: var(--text);
    border-radius: 999px;
    padding: 10px 14px;
    cursor: pointer;
    font-weight: 600;
    white-space: nowrap;
  }

  .settings-panel {
    margin-top: 16px;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 220px));
    gap: 14px;
  }

  label {
    display: grid;
    gap: 6px;
  }

  select {
    margin-top: 6px;
    padding: 12px 14px;
    border-radius: 14px;
    border: 1px solid var(--border);
    background: rgba(255, 255, 255, 0.93);
    color: var(--text);
    font: inherit;
  }

  .day-separator {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    padding: 8px 12px;
    background: linear-gradient(135deg, var(--accent-soft), rgba(207, 226, 255, 0.9));
    color: var(--accent-strong);
    font-weight: 700;
    letter-spacing: 0.02em;
    margin-bottom: 16px;
  }

  .inline-stats {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    justify-content: end;
  }

  .inline-stat {
    min-width: 88px;
    padding: 10px 12px;
    border-radius: 14px;
    border: 1px solid var(--border-strong);
    background: linear-gradient(135deg, var(--panel-strong), rgba(220, 232, 255, 0.62));
    display: grid;
    gap: 2px;
  }

  .inline-stat strong {
    font-size: 1.2rem;
    line-height: 1;
  }

  .tab-row {
    display: flex;
    gap: 10px;
    overflow-x: auto;
    padding: 12px 0 4px;
    margin-bottom: 10px;
  }

  .tab {
    border: 1px solid var(--border);
    background: rgba(255, 255, 255, 0.76);
    color: var(--text);
    border-radius: 999px;
    padding: 10px 14px;
    white-space: nowrap;
    font-weight: 600;
    cursor: pointer;
  }

  .tab.selected {
    background: linear-gradient(135deg, var(--accent), var(--accent-strong));
    color: #fff;
    border-color: transparent;
  }

  .day-layout {
    display: grid;
    grid-template-columns: minmax(0, 0.95fr) minmax(340px, 0.8fr);
    gap: 16px;
    align-items: start;
  }

  .day-layout > * {
    min-width: 0;
  }

  .stories {
    display: grid;
    gap: 12px;
  }

  .story-card {
    width: 100%;
    text-align: left;
    border: 1px solid transparent;
    border-radius: 18px;
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(238, 246, 255, 0.9));
    padding: 14px;
    display: grid;
    gap: 8px;
    cursor: pointer;
    transition:
      border-color 140ms ease,
      box-shadow 140ms ease;
  }

  .story-card:hover,
  .story-card.active {
    border-color: var(--border-strong);
    box-shadow: 0 12px 24px rgba(20, 55, 111, 0.12);
  }

  .story-keywords {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .story-keywords a {
    display: inline-flex;
    align-items: center;
    min-height: 28px;
    padding: 0 12px;
    border-radius: 999px;
    border: 1px solid rgba(15, 98, 254, 0.16);
    background: rgba(220, 232, 255, 0.86);
    color: var(--accent-strong);
    font-size: 0.84rem;
    line-height: 1;
    text-decoration: none;
    text-underline-offset: 3px;
  }

  .story-keywords a:hover {
    text-decoration: underline;
  }

  .detail {
    padding: 16px;
    overflow: visible;
  }

  .detail-head {
    position: relative;
    z-index: 10; /* Ensures the main panel header always stays above scrolling list items */
    border-bottom: 1px solid var(--border);
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

  .back-link {
    display: inline-flex;
    align-items: center;
    text-decoration: none;
  }

  .source-title-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 6px;
  }

  .source-favicon {
    flex: 0 0 auto;
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
    border: 1px solid var(--border);
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
    border-color: var(--border-strong);
    box-shadow: 0 6px 14px rgba(20, 55, 111, 0.12);
  }

  .chip-link {
    text-decoration: none;
  }

  .chip-link:hover,
  .chip:hover {
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  .domain-more {
    display: inline-flex;
    align-items: center;
    color: var(--muted);
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
    background: var(--accent-soft);
    color: var(--accent-strong);
    font-size: 0.84rem;
    font-weight: 600;
  }

  .article-grid {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 14px;
    max-height: 560px;
    overflow-y: auto;
    overflow-x: hidden;
    /* 1. Remove padding-top and scroll-padding-top to eliminate the Y-axis gap */
    padding-right: 6px;
    background: linear-gradient(180deg, rgba(245, 249, 255, 0.92), rgba(245, 249, 255, 0) 44px);
    
    /* 2. Optional: If you want visual spacing above the list, use margin instead so it sits OUTSIDE the scroll area */
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
    border: 1px solid var(--border);
    border-top: 0;
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.96), rgba(242, 248, 255, 0.84));
    overflow: hidden;
    transition:
      border-color 140ms ease,
      box-shadow 140ms ease;
  }

  .article-entry:hover .article-head,
  .article-entry:hover .article-card-body {
    border-color: var(--border-strong);
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
    border: 1px solid var(--border);
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

  .article-head h4 {
    margin: 0;
  }

  .article-body {
    padding: 12px 14px 14px;
  }

  article p {
    margin: 6px 0;
    color: #34445c;
    line-height: 1.52;
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  article h4 {
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  article a {
    color: var(--accent);
    font-weight: 700;
    text-decoration: none;
  }

  article a:hover {
    text-decoration: underline;
  }

  .loading,
  .empty {
    color: var(--muted);
  }

  .empty {
    min-height: 180px;
    display: grid;
    place-content: center;
    text-align: center;
  }

  .error {
    margin: 0 0 12px;
    color: #b42318;
  }

  .load-anchor {
    min-height: 56px;
    display: grid;
    place-items: center;
    color: var(--muted);
  }

  :global(.debug-component-overlay) {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 2147483647;
    overflow: hidden;
  }

  :global(.debug-component-overlay-label) {
    position: absolute;
    padding: 4px 8px;
    border-radius: 999px;
    background: rgba(20, 32, 51, 0.94);
    color: #f8fbff;
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    white-space: nowrap;
    max-width: min(32ch, calc(100vw - 16px));
    overflow: hidden;
    text-overflow: ellipsis;
    box-shadow: 0 8px 18px rgba(20, 32, 51, 0.18);
  }

  @media (max-width: 980px) {
    .focus-grid {
      grid-template-columns: 1fr;
    }

    .hero-row,
    .day-head,
    .day-layout {
      grid-template-columns: 1fr;
      display: grid;
    }

    .settings-panel {
      grid-template-columns: 1fr;
    }

    .inline-stats {
      justify-content: start;
    }

    .article-grid {
      max-height: none;
      overflow: visible;
      padding-right: 0;
    }
  }
</style>
