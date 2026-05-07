<script lang="ts">
  import { onMount } from "svelte";
  import { fly } from "svelte/transition";
  import EntityHighlighter from "./components/EntityHighlighter.svelte";
  import EntityPopover from "./components/EntityPopover.svelte";
  import EntityStats from "./components/EntityStats.svelte";
  import ClusterSummary from "./components/ClusterSummary.svelte";
  import StoryDetailPanel from "./components/StoryDetailPanel.svelte";
  import PipelinePage from "./components/PipelinePage.svelte";
  import PerspectiveStatsPage from "./components/PerspectiveStatsPage.svelte";
  import type { ArticleDetail, LinkedEntity, SourceProfileDto, StoryComparison, StoryDetail, StoryFacetDto, StoryListItem, TagProfileDto } from "@news/shared";

  const API_BASE =
    typeof window !== "undefined"
      ? `${window.location.protocol}//${window.location.hostname}:4400`
      : "http://localhost:4400";
  const STORIES_PER_DAY = 10;
  const DEVTOOLS_LABEL_CLASS = "debug-component-labels";
  const DEVTOOLS_OVERLAY_CLASS = "debug-component-overlay";

  interface DaySection {
    date: string;
    categories: string[];
    selectedCategory: string;
    stories: StoryListItem[];
    topAllCluster: StoryListItem | null;
    selectedStory: StoryDetail | null;
    comparison: StoryComparison | null;
    loading: boolean;
    error: string;
  }

  type ViewState =
    | { kind: "feed" }
    | { kind: "date"; date: string }
    | { kind: "source"; domain: string }
    | { kind: "tag"; keyword: string }
    | { kind: "story"; id: string }
    | { kind: "article"; id: string }
    | { kind: "compare"; aId: string; bId: string }
    | { kind: "about" }
    | { kind: "pipeline" }
    | { kind: "perspective" };

  interface ArticleSlot {
    id: string;
    detail: ArticleDetail | null;
    loading: boolean;
    error: string;
    entities: LinkedEntity[];
    entitiesLoading: boolean;
    entitiesError: string;
    selectedEntity: LinkedEntity | null;
    perspectiveWords: string[];
    perspectiveLoading: boolean;
    hoveredPerspective: string | null;
  }

  function makeArticleSlot(id = ""): ArticleSlot {
    return {
      id,
      detail: null,
      loading: false,
      error: "",
      entities: [],
      entitiesLoading: false,
      entitiesError: "",
      selectedEntity: null,
      perspectiveWords: [],
      perspectiveLoading: false,
      hoveredPerspective: null,
    };
  }

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
  let storyPageDetail: StoryDetail | null = null;
  let storyPageComparison: StoryComparison | null = null;
  let storyPageLoading = false;
  let storyPageError = "";
  let articleSlot: ArticleSlot = makeArticleSlot();
  let compareSlotA: ArticleSlot = makeArticleSlot();
  let compareSlotB: ArticleSlot = makeArticleSlot();
  let globalError = "";
  let loadingNextDate = false;
  const HERO_ROTATING_WORDS = ["outlets", "regions", "days", "framings", "narratives"];
  let heroRotatingIndex = 0;
  let heroRotateTimer: ReturnType<typeof setInterval> | null = null;
  $: featuredCluster = daySections[0]?.topAllCluster ?? daySections[0]?.stories?.[0] ?? null;
  $: featuredDomains = (featuredCluster?.topDomains ?? []).slice(0, 6);
  $: featuredSources = (() => {
    const domains = featuredDomains;
    const articles = featuredCluster?.topDomainArticles ?? [];
    const byDomain = new Map(articles.map((entry) => [entry.domain, entry]));
    return domains.map((domain) => {
      const match = byDomain.get(domain);
      return { domain, articleId: match?.articleId ?? null, url: match?.url ?? null };
    });
  })();
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

  function debugFlagEnabled(): boolean {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("debug") === "1";
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

  async function refreshFavicon(domain: string): Promise<void> {
    try {
      await fetch(`${API_BASE}/api/favicons/${encodeURIComponent(domain)}?refresh=true`, { cache: "no-store" });
    } catch (error) {
      console.warn(`Favicon refresh failed for ${domain}`, error);
      return;
    }
    const newSrc = `${API_BASE}/api/favicons/${encodeURIComponent(domain)}?v=${Date.now()}`;
    document.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
      const src = img.getAttribute("src") ?? "";
      const match = src.match(/\/api\/favicons\/([^?\/]+)/);
      const imgDomain = match ? decodeURIComponent(match[1]) : img.dataset.faviconDomain;
      if (imgDomain === domain) {
        delete img.dataset.faviconDomain;
        img.src = newSrc;
      }
    });
  }

  function handleGlobalFaviconShiftClick(event: MouseEvent): void {
    if (!event.shiftKey) return;
    const target = event.target;
    if (!(target instanceof HTMLImageElement)) return;
    const src = target.getAttribute("src") ?? "";
    const match = src.match(/\/api\/favicons\/([^?\/]+)/);
    const domain = match ? decodeURIComponent(match[1]) : target.dataset.faviconDomain;
    if (!domain) return;
    event.preventDefault();
    event.stopPropagation();
    void refreshFavicon(domain);
  }

  function sourcePath(domain: string): string {
    return `/newssite/${encodeURIComponent(domain)}`;
  }

  function tagPath(keyword: string): string {
    return `/tag/${encodeURIComponent(keyword)}`;
  }

  function storyPath(id: string): string {
    return `/stories/${encodeURIComponent(id)}`;
  }

  function datePath(date: string): string {
    return `/date/${encodeURIComponent(date)}`;
  }

  function articlePath(id: string): string {
    return `/articles/${encodeURIComponent(id)}`;
  }

  function comparePath(aId: string, bId: string): string {
    return `/compare/${encodeURIComponent(aId)}/${encodeURIComponent(bId)}`;
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

    const storyMatch = pathname.match(/^\/stories\/(.+)$/);
    if (storyMatch?.[1]) {
      return { kind: "story", id: decodeURIComponent(storyMatch[1]) };
    }

    const articleMatch = pathname.match(/^\/articles\/(.+)$/);
    if (articleMatch?.[1]) {
      return { kind: "article", id: decodeURIComponent(articleMatch[1]) };
    }

    const compareMatch = pathname.match(/^\/compare\/([^/]+)\/([^/]+)$/);
    if (compareMatch?.[1] && compareMatch[2]) {
      return {
        kind: "compare",
        aId: decodeURIComponent(compareMatch[1]),
        bId: decodeURIComponent(compareMatch[2]),
      };
    }

    const dateMatch = pathname.match(/^\/date\/(\d{4}-\d{2}-\d{2})$/);
    if (dateMatch?.[1]) {
      return { kind: "date", date: dateMatch[1] };
    }

    if (pathname === "/about") {
      return { kind: "about" };
    }

    if (pathname === "/pipeline") {
      return { kind: "pipeline" };
    }

    if (pathname === "/perspective") {
      return { kind: "perspective" };
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

  const FAVICON_PLACEHOLDER =
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'>" +
        "<rect width='16' height='16' rx='3' fill='#d4d4d8'/>" +
        "<circle cx='8' cy='8' r='3.4' fill='none' stroke='#ffffff' stroke-width='1.1'/>" +
        "<path d='M2.6 8h10.8M8 2.6c2.4 3 2.4 7.8 0 10.8M8 2.6c-2.4 3-2.4 7.8 0 10.8' " +
        "stroke='#ffffff' stroke-width='0.9' fill='none'/>" +
        "</svg>",
    );

  function handleFaviconError(event: Event): void {
    const target = event.currentTarget as HTMLImageElement | null;
    if (!target) return;
    if (target.src === FAVICON_PLACEHOLDER) return;
    const match = target.src.match(/\/api\/favicons\/([^?\/]+)/);
    if (match) target.dataset.faviconDomain = decodeURIComponent(match[1]);
    target.src = FAVICON_PLACEHOLDER;
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

  function escapeHtml(value: string): string {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function highlightWords(text: string, words: string[]): string {
    const escaped = escapeHtml(text);
    if (!words || words.length === 0) return escaped;
    const sorted = [...new Set(words.filter((w) => w.trim().length > 0))].sort((a, b) => b.length - a.length);
    if (sorted.length === 0) return escaped;
    const pattern = new RegExp(`\\b(${sorted.map(escapeRegex).join("|")})\\b`, "gi");
    return escaped.replace(pattern, '<mark class="perspective-word">$1</mark>');
  }

  function splitParagraphs(text: string): Array<{ text: string }> {
    if (!text) return [];
    return text
      .split(/\n\s*\n+/)
      .map((chunk) => chunk.trim())
      .filter((chunk) => chunk.length > 0)
      .map((chunk) => ({ text: chunk }));
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
      topAllCluster: null,
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
        topAllCluster: section.topAllCluster ?? stories[0] ?? null,
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

  async function loadStoryPage(id: string): Promise<void> {
    storyPageLoading = true;
    storyPageError = "";
    storyPageDetail = null;
    storyPageComparison = null;

    try {
      const [detail, comparison] = await Promise.all([
        fetchJson<StoryDetail>(`/api/stories/${id}`),
        fetchJson<StoryComparison>(`/api/stories/${id}/comparison`),
      ]);
      storyPageDetail = detail;
      storyPageComparison = comparison;
    } catch (value) {
      storyPageError = value instanceof Error ? value.message : "Failed to load story";
    } finally {
      storyPageLoading = false;
    }
  }

  async function loadArticleSlot(id: string, assign: (slot: ArticleSlot) => void): Promise<void> {
    let slot: ArticleSlot = { ...makeArticleSlot(id), loading: true };
    assign(slot);

    const update = (patch: Partial<ArticleSlot>): void => {
      slot = { ...slot, ...patch };
      assign(slot);
    };

    try {
      const detail = await fetchJson<ArticleDetail>(`/api/articles/${id}`);
      update({ detail, entitiesLoading: true });
      try {
        const entityResponse = await fetchJson<{ entities: LinkedEntity[] }>(
          `/api/articles/${id}/entities?minConfidence=0.2`,
        );
        update({ entities: entityResponse.entities ?? [], entitiesLoading: false });
      } catch (value) {
        update({
          entitiesError: value instanceof Error ? value.message : "Failed to load entities",
          entitiesLoading: false,
        });
      }
      const clusterId = detail?.relatedStory?.id;
      const sourceName = detail?.sourceName;
      if (clusterId && sourceName) {
        update({ perspectiveLoading: true });
        try {
          const perspective = await fetchJson<{ distinctive_words: { source_name: string; words: string[] }[] }>(
            `/api/clusters/${encodeURIComponent(clusterId)}/perspective`,
          );
          const target = sourceName.toLowerCase();
          const row = perspective.distinctive_words.find((r) => r.source_name.toLowerCase() === target);
          update({ perspectiveWords: row?.words ?? [], perspectiveLoading: false });
        } catch {
          update({ perspectiveWords: [], perspectiveLoading: false });
        }
      }
    } catch (value) {
      update({
        error: value instanceof Error ? value.message : "Failed to load article",
        entitiesLoading: false,
      });
    } finally {
      update({ loading: false });
    }
  }

  async function loadArticlePage(id: string): Promise<void> {
    await loadArticleSlot(id, (slot) => {
      articleSlot = slot;
    });
  }

  async function loadComparePage(aId: string, bId: string): Promise<void> {
    compareSlotA = makeArticleSlot(aId);
    compareSlotB = makeArticleSlot(bId);
    await Promise.all([
      loadArticleSlot(aId, (slot) => {
        compareSlotA = slot;
      }),
      loadArticleSlot(bId, (slot) => {
        compareSlotB = slot;
      }),
    ]);
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

    if (currentView.kind === "story") {
      await loadStoryPage(currentView.id);
      return;
    }

    if (currentView.kind === "article") {
      await loadArticlePage(currentView.id);
      return;
    }

    if (currentView.kind === "compare") {
      await loadComparePage(currentView.aId, currentView.bId);
      return;
    }

    if (currentView.kind === "about") {
      return;
    }

    if (currentView.kind === "pipeline") {
      return;
    }

    await ensureFeedDatesLoaded();

    if (currentView.kind === "date") {
      const requested = currentView.date;
      const sig = `date:${requested}`;
      if (loadedFeedSignature !== sig || daySections.length === 0) {
        daySections = [];
        nextDateCursor = dates.length; // disable infinite scroll
        loadedFeedSignature = sig;
        globalError = "";
        await appendDateSection(requested);
      }
      return;
    }

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
    const handlePopState = () => {
      void syncRouteFromLocation();
    };

    if (import.meta.env.DEV && debugFlagEnabled()) {
      setComponentLabelVisibility(true);
      window.addEventListener("resize", requestDebugRender);
      window.addEventListener("scroll", requestDebugRender, true);
      document.addEventListener("mouseover", handleDebugPointer, true);
      document.addEventListener("mouseleave", handleDebugPointerLeave, true);
    }

    window.addEventListener("popstate", handlePopState);

    heroRotateTimer = setInterval(() => {
      heroRotatingIndex = (heroRotatingIndex + 1) % HERO_ROTATING_WORDS.length;
    }, 2600);

    (async () => {
      await ensureFeedDatesLoaded();
      await syncRouteFromLocation();
    })().catch((value) => {
      globalError = value instanceof Error ? value.message : "Failed to initialize feed";
    });

    return () => {
      window.removeEventListener("resize", requestDebugRender);
      window.removeEventListener("scroll", requestDebugRender, true);
      window.removeEventListener("popstate", handlePopState);
      if (heroRotateTimer !== null) {
        clearInterval(heroRotateTimer);
        heroRotateTimer = null;
      }
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
        : currentView.kind === "story" && storyPageDetail
          ? `${storyPageDetail.translatedTitle ?? storyPageDetail.title} · NewsInPerspective`
          : currentView.kind === "article" && articleSlot.detail
            ? `${articleSlot.detail.title} · NewsInPerspective`
          : currentView.kind === "compare"
            ? "Compare articles · NewsInPerspective"
          : currentView.kind === "date"
            ? `${currentView.date} · NewsInPerspective`
          : currentView.kind === "about"
            ? "About · NewsInPerspective"
            : currentView.kind === "perspective"
              ? "Perspective stats · NewsInPerspective"
              : "NewsInPerspective"}
  </title>
</svelte:head>

<svelte:window on:click|capture={handleGlobalFaviconShiftClick} />

<main class="shell" use:debugComponent={componentLabel("AppShell")}>
  <section class="hero panel" use:debugComponent={componentLabel("HeroPanel")}>
    <div class="hero-aurora" aria-hidden="true">
      <span class="aurora-blob blob-a"></span>
      <span class="aurora-blob blob-b"></span>
      <span class="aurora-blob blob-c"></span>
      <span class="aurora-grid"></span>
    </div>

    <p class="eyebrow brand-line">
      <a href="/" class="brand-link" on:click={(event) => handleInternalNavigation(event, "/")}>NewsInPerspective</a>
      <span class="brand-pulse" aria-hidden="true"></span>
    </p>
    <div class="hero-row">
      <div class="hero-copy">
        <h1 class="hero-title">
          See how the <span class="hero-accent">same story</span> moves across
          <span class="hero-rotator" aria-live="polite">
            <span class="hero-rotator-sizer" aria-hidden="true">
              {HERO_ROTATING_WORDS.reduce((a, b) => (b.length > a.length ? b : a), "")}
            </span>
            {#key heroRotatingIndex}
              <span class="hero-rotator-word" in:fly={{ y: 6, duration: 280, opacity: 0 }} out:fly={{ y: -6, duration: 200, opacity: 0 }}>
                {HERO_ROTATING_WORDS[heroRotatingIndex]}
              </span>
            {/key}
          </span>
        </h1>
        <p class="lede">
          {#if currentView.kind === "feed"}
            Each date section shows its own category chooser, top story feed, and cluster explorer.
            Scroll down to load the next day.
          {:else if currentView.kind === "source"}
            Source profiles combine outlet metadata with the stories currently associated with that domain.
          {:else if currentView.kind === "story"}
            Story pages show the full cross-source cluster detail and give each cluster a stable route.
          {:else if currentView.kind === "article"}
            Article pages focus on one source version of a story and are the best place for article-level enrichment.
          {:else if currentView.kind === "compare"}
            Compare two articles from the same story side by side — same enrichment, different framings.
          {:else}
            Keyword pages show where a topic appears, which sources publish it, and what other entities travel with it.
          {/if}
        </p>
      </div>

      {#if currentView.kind === "feed"}
        <button class="settings-button" type="button" on:click={() => (settingsOpen = !settingsOpen)}>
          <span aria-hidden="true">⚙</span>
          <span>Settings</span>
        </button>
      {/if}
    </div>

    {#if currentView.kind === "feed"}
      <div class="cluster-strip" use:debugComponent={componentLabel("HeroClusterStrip")}>
        {#if featuredCluster}
          <div class="cluster-strip-header">
            <span class="cluster-strip-tag">Live · top cluster</span>
            <a
              class="cluster-strip-title"
              href={storyPath(featuredCluster.id)}
              on:click={(event) => handleInternalNavigation(event, storyPath(featuredCluster.id))}
            >
              {featuredCluster.translatedTitle ?? featuredCluster.title}
            </a>
            <span class="cluster-strip-meta">
              {featuredCluster.sourceCount} sources · {featuredCluster.articleCount} articles
            </span>
          </div>
          <div class="cluster-arc" role="list" aria-label="Sources covering this story">
            <span class="cluster-arc-line" aria-hidden="true"></span>
            {#each featuredSources as source, idx (source.domain)}
              <a
                class="cluster-node"
                role="listitem"
                href={source.articleId ? articlePath(source.articleId) : sourcePath(source.domain)}
                on:click={(event) =>
                  handleInternalNavigation(
                    event,
                    source.articleId ? articlePath(source.articleId) : sourcePath(source.domain),
                  )}
                style="--i: {idx}; --n: {featuredSources.length}"
                title={source.domain}
              >
                <span class="cluster-node-dot">
                  <img src={faviconUrl(source.domain)} alt="" loading="lazy" on:error={handleFaviconError} />
                </span>
                <span class="cluster-node-label">{source.domain}</span>
              </a>
            {/each}
            {#if featuredCluster.sourceCount > featuredSources.length}
              <a
                class="cluster-node cluster-node-more"
                href={storyPath(featuredCluster.id)}
                on:click={(event) => handleInternalNavigation(event, storyPath(featuredCluster.id))}
                style="--i: {featuredSources.length}; --n: {featuredSources.length + 1}"
                title="See all sources"
              >
                <span class="cluster-node-dot cluster-node-dot-more">+{featuredCluster.sourceCount - featuredSources.length}</span>
                <span class="cluster-node-label">more</span>
              </a>
            {/if}
          </div>
        {:else}
          <div class="cluster-strip-skeleton" aria-hidden="true">
            <div class="cluster-strip-header">
              <span class="cluster-strip-tag">Live · top cluster</span>
              <span class="cluster-strip-title cluster-strip-title-placeholder"></span>
              <span class="cluster-strip-meta cluster-strip-meta-placeholder"></span>
            </div>
            <div class="cluster-arc">
              <span class="cluster-arc-bar"></span>
            </div>
          </div>
        {/if}
      </div>
    {/if}

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
                <strong><a href={storyPath(story.id)} on:click={(event) => handleInternalNavigation(event, storyPath(story.id))}>{story.translatedTitle ?? story.title}</a></strong>
                <span class="signals">{formatDateRange(story.dateFrom, story.dateUntil)}</span>
                <span class="story-keywords">
                  {#each story.keywords as keyword}
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
    <section class="panel focus-page tag-page" use:debugComponent={componentLabel("TagPage", currentView.keyword)}>
      <div class="tag-hero">
        <div class="tag-hero-main">
          <p class="eyebrow">Keyword</p>
          <h1 class="tag-hero-title"># {currentView.keyword}</h1>
          {#if tagProfile}
            <p class="tag-hero-range">{tagProfile.dateFrom ?? "n/a"} → {tagProfile.dateUntil ?? "n/a"}</p>
          {/if}
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
        <div class="tag-stat-row">
          <div class="tag-stat-card"><span class="stat-label">Stories</span><strong>{tagProfile.storyCount}</strong></div>
          <div class="tag-stat-card"><span class="stat-label">Articles</span><strong>{tagProfile.articleCount}</strong></div>
          <div class="tag-stat-card"><span class="stat-label">Sources</span><strong>{tagProfile.sourceCount}</strong></div>
          {#if tagProfile.topCategories[0]}
            <div class="tag-stat-card tag-stat-card--wide">
              <span class="stat-label">Top category</span>
              <strong>{tagProfile.topCategories[0].label}</strong>
            </div>
          {/if}
        </div>

        <div class="focus-grid tag-grid">
          <section class="panel inset-panel top-sources-panel">
            <p class="eyebrow">Most covered by</p>
            {#if tagProfile.topDomains.length === 0}
              <p class="placeholder-pending">No source coverage yet.</p>
            {:else}
              {@const topFive = tagProfile.topDomains.slice(0, 5)}
              {@const maxCount = Math.max(...topFive.map((d) => d.count), 1)}
              <ol class="top-sources-list">
                {#each topFive as facet, idx}
                  <li class="top-source-row">
                    <span class="top-source-rank">{idx + 1}</span>
                    <a
                      class="top-source-link"
                      href={sourcePath(facet.label)}
                      on:click={(event) => handleInternalNavigation(event, sourcePath(facet.label))}
                    >
                      <img class="favicon top-source-favicon" src={faviconUrl(facet.label)} alt="" loading="lazy" width="20" height="20" on:error={handleFaviconError} />
                      <span class="top-source-name">{facet.label}</span>
                    </a>
                    <div class="top-source-bar" aria-hidden="true">
                      <div class="top-source-bar-fill" style="width: {(facet.count / maxCount) * 100}%"></div>
                    </div>
                    <span class="top-source-count">{facet.count}</span>
                  </li>
                {/each}
              </ol>
            {/if}
            {#if tagProfile.topCategories.length > 0}
              <div class="facet-list facet-list--tight">
                {#each tagProfile.topCategories as facet}
                  <span class="chip">{facet.label} · {facet.count}</span>
                {/each}
              </div>
            {/if}
          </section>

          <section class="panel inset-panel">
            <p class="eyebrow">Related Terms</p>
            {#if tagProfile.relatedKeywords.length === 0 && tagProfile.relatedEntities.length === 0}
              <p class="placeholder-pending">No related terms yet.</p>
            {/if}
            {#if tagProfile.relatedKeywords.length > 0}
              <div class="facet-list">
                {#each tagProfile.relatedKeywords as keyword}
                  <a href={tagPath(keyword)} class="chip chip-link" on:click={(event) => handleInternalNavigation(event, tagPath(keyword))}>{keyword}</a>
                {/each}
              </div>
            {/if}
            {#if tagProfile.relatedEntities.length > 0}
              <div class="facet-list">
                {#each tagProfile.relatedEntities as entity}
                  <span class="chip">{entity}</span>
                {/each}
              </div>
            {/if}
          </section>
        </div>

        <section class="panel inset-panel">
          <p class="eyebrow">Stories Using This Keyword</p>
          <div class="stories">
            {#each tagProfile.stories as story}
              <article class="story-card">
                <span class="meta">
                  {formatCategoryLabel(story.category)} · {story.importanceScore} score · {story.sourceCount} sources
                </span>
                <strong><a href={storyPath(story.id)} on:click={(event) => handleInternalNavigation(event, storyPath(story.id))}>{story.translatedTitle ?? story.title}</a></strong>
                <span class="signals">{formatDateRange(story.dateFrom, story.dateUntil)}</span>
                <span class="story-keywords">
                  {#each story.keywords as keyword}
                    <a href={tagPath(keyword)} on:click={(event) => handleInternalNavigation(event, tagPath(keyword))}>{keyword}</a>
                  {/each}
                </span>
              </article>
            {/each}
          </div>
        </section>
      {/if}
    </section>
  {:else if currentView.kind === "story"}
    <section class="panel focus-page story-page" use:debugComponent={componentLabel("StoryPage", shortId(currentView.id))}>
      {#if storyPageLoading}
        <p class="loading" use:debugComponent={componentLabel("StoryPageLoading")}>Loading story detail...</p>
      {:else if storyPageError}
        <p class="error" use:debugComponent={componentLabel("StoryPageError")}>{storyPageError}</p>
      {:else if storyPageDetail}
        <header class="article-header-strip" use:debugComponent={componentLabel("StoryHeaderStrip", shortId(storyPageDetail.id))}>
          <span class="eyebrow">Story</span>
          <span class="article-header-sep">·</span>
          <span>{formatScopeLabel(storyPageDetail.region, storyPageDetail.category)}</span>
          <span class="article-header-sep">·</span>
          <a
            class="article-date-link"
            href={datePath(storyPageDetail.dateFrom)}
            on:click={(event) => handleInternalNavigation(event, datePath(storyPageDetail!.dateFrom))}
            title={`Open ${storyPageDetail.dateFrom} feed`}
          >{formatDateRange(storyPageDetail.dateFrom, storyPageDetail.dateUntil)}</a>
          <div class="article-header-actions">
            <a href="/" class="tab back-link" on:click={(event) => handleInternalNavigation(event, "/")}>Back to feed</a>
          </div>
        </header>
        <StoryDetailPanel
          story={storyPageDetail}
          comparison={storyPageComparison}
          {articlePath}
          {comparePath}
          {sourcePath}
          {tagPath}
          {faviconUrl}
          {formatDateRange}
          {formatScopeLabel}
          {otherSourceCount}
          onNavigate={handleInternalNavigation}
          onFaviconError={handleFaviconError}
          apiBase={API_BASE}
          showEntities={true}
          {datePath}
        />
      {/if}
    </section>
  {:else if currentView.kind === "article"}
    <section class="panel focus-page article-page">
      {#if articleSlot.loading}
        <p class="loading">Loading article...</p>
      {:else if articleSlot.error}
        <p class="error">{articleSlot.error}</p>
      {:else if articleSlot.detail}
        {@const applyPatch = (patch: Partial<ArticleSlot>) => (articleSlot = { ...articleSlot, ...patch })}
        {@render sectionHeader(articleSlot, applyPatch)}
        <div class="article-layout">
          <div class="article-main">
            {@render sectionTitle(articleSlot)}
            {@render sectionSummary(articleSlot)}
            {@render sectionTranslation(articleSlot)}
            {@render sectionBody(articleSlot, applyPatch)}
            {@render sectionNearDup(articleSlot)}
            {@render sectionSentiment(articleSlot)}
          </div>
          <aside class="article-aside">
            {@render sectionTags(articleSlot)}
            {@render sectionPerspective(articleSlot, applyPatch)}
            {@render sectionEntities(articleSlot, applyPatch)}
          </aside>
        </div>
        <EntityPopover entity={articleSlot.selectedEntity} onClose={() => applyPatch({ selectedEntity: null })} />
      {/if}
    </section>
  {:else if currentView.kind === "compare"}
    {@const compareStory = compareSlotA.detail?.relatedStory ?? compareSlotB.detail?.relatedStory ?? null}
    <section class="panel focus-page compare-page">
      <header class="article-header-strip">
        <span class="eyebrow">Compare articles</span>
        {#if compareStory}
          <span class="article-header-sep">·</span>
          <span>from story:</span>
          <a
            href={storyPath(compareStory.id)}
            on:click={(event) => handleInternalNavigation(event, storyPath(compareStory.id))}
          >{compareStory.translatedTitle ?? compareStory.title}</a>
        {/if}
        <div class="article-header-actions">
          <a
            href={compareStory ? storyPath(compareStory.id) : "/"}
            class="tab back-link"
            on:click={(event) => handleInternalNavigation(event, compareStory ? storyPath(compareStory.id) : "/")}
          >
            {compareStory ? "Back to story" : "Back to feed"}
          </a>
        </div>
      </header>
      {#if compareSlotA.loading || compareSlotB.loading}
        <p class="loading">Loading articles…</p>
      {:else if compareSlotA.error || compareSlotB.error}
        <p class="error">{compareSlotA.error || compareSlotB.error}</p>
      {:else if compareSlotA.detail && compareSlotB.detail}
        {@const applyA = (patch: Partial<ArticleSlot>) => (compareSlotA = { ...compareSlotA, ...patch })}
        {@const applyB = (patch: Partial<ArticleSlot>) => (compareSlotB = { ...compareSlotB, ...patch })}
        <div class="compare-grid">
          {@render sectionHeader(compareSlotA, applyA)}
          {@render sectionHeader(compareSlotB, applyB)}
          {@render sectionTitle(compareSlotA)}
          {@render sectionTitle(compareSlotB)}
          {@render sectionSummary(compareSlotA, false)}
          {@render sectionSummary(compareSlotB, false)}
          {@render sectionTranslation(compareSlotA)}
          {@render sectionTranslation(compareSlotB)}
          {@render sectionBody(compareSlotA, applyA)}
          {@render sectionBody(compareSlotB, applyB)}
          {@render sectionNearDup(compareSlotA)}
          {@render sectionNearDup(compareSlotB)}
          {@render sectionSentiment(compareSlotA)}
          {@render sectionSentiment(compareSlotB)}
          {@render sectionTags(compareSlotA)}
          {@render sectionTags(compareSlotB)}
          {@render sectionPerspective(compareSlotA, applyA)}
          {@render sectionPerspective(compareSlotB, applyB)}
          {@render sectionEntities(compareSlotA, applyA)}
          {@render sectionEntities(compareSlotB, applyB)}
        </div>
        <EntityPopover entity={compareSlotA.selectedEntity} onClose={() => applyA({ selectedEntity: null })} />
        <EntityPopover entity={compareSlotB.selectedEntity} onClose={() => applyB({ selectedEntity: null })} />
      {/if}
    </section>
  {/if}

  {#snippet sectionHeader(slot: ArticleSlot, _applyPatch: (patch: Partial<ArticleSlot>) => void)}
    {#if slot.detail}
      {@const detail = slot.detail}
      {@const publishedDate = detail.publishedAt.slice(0, 10)}
      {@const feedDate = detail.relatedStory?.date ?? publishedDate}
      <header class="article-header-strip compare-section">
        <a
          class="eyebrow article-eyebrow-link"
          href={articlePath(detail.id)}
          on:click={(event) => handleInternalNavigation(event, articlePath(detail.id))}
          title="Open article page"
        >Article →</a>
        <span class="article-header-sep">·</span>
        <a class="domain-chip domain-link" href={sourcePath(detail.domain)} on:click={(event) => handleInternalNavigation(event, sourcePath(detail.domain))}>
          <img class="favicon" src={faviconUrl(detail.domain)} alt="" loading="lazy" width="14" height="14" on:error={handleFaviconError} />
          <span>{detail.domain}</span>
        </a>
        <span class="article-header-sep">·</span>
        <a
          class="article-date-link"
          href={datePath(feedDate)}
          on:click={(event) => handleInternalNavigation(event, datePath(feedDate))}
          title={feedDate !== publishedDate
            ? `Published ${publishedDate}; clustered into the ${feedDate} feed`
            : `Open ${feedDate} feed`}
        >{publishedDate}</a>
        {#if detail.fullTextIsTranslated && detail.language}
          <span class="article-header-sep">·</span>
          <span class="lang-pill" title="Translated from {detail.language.toUpperCase()} to English">
            {detail.language.slice(0, 2).toUpperCase()} → EN
          </span>
        {/if}
        <div class="article-header-actions">
          <a class="tab tab--primary" href={detail.url} target="_blank" rel="noreferrer">Read original ↗</a>
        </div>
      </header>
    {/if}
  {/snippet}

  {#snippet sectionTitle(slot: ArticleSlot)}
    <div class="compare-section article-title-section">
      {#if slot.detail}
        <h2 class="article-title">{slot.detail.title}</h2>
        {#if slot.detail.originalTitle}
          <p class="article-original-title" lang={slot.detail.language ?? undefined}>
            {slot.detail.originalTitle}
          </p>
        {/if}
      {/if}
    </div>
  {/snippet}

  {#snippet sectionSummary(slot: ArticleSlot, showRelatedStory = true)}
    {@const activePerspective = slot.hoveredPerspective ? [slot.hoveredPerspective] : []}
    <div class="compare-section article-summary-callout">
      <span class="article-summary-label">Summary</span>
      {#if slot.detail?.summary}
        <p>{@html highlightWords(slot.detail.summary, activePerspective)}</p>
      {:else if slot.detail}
        <p class="placeholder-pending">Summary pending</p>
      {/if}
      {#if showRelatedStory && slot.detail?.relatedStory}
        <p class="article-summary-story">
          Part of story:
          <a href={storyPath(slot.detail.relatedStory.id)} on:click={(event) => handleInternalNavigation(event, storyPath(slot.detail!.relatedStory!.id))}>
            {slot.detail.relatedStory.translatedTitle ?? slot.detail.relatedStory.title}
          </a>
        </p>
      {/if}
    </div>
  {/snippet}

  {#snippet sectionTranslation(slot: ArticleSlot)}
    <div class="compare-section">
      {#if slot.detail?.fullTextIsTranslated}
        <p class="translation-notice">
          Translated from {(slot.detail.language ?? "source").toUpperCase()}.
          <a href={slot.detail.url} target="_blank" rel="noreferrer">Read the original →</a>
        </p>
      {/if}
    </div>
  {/snippet}

  {#snippet sectionBody(slot: ArticleSlot, applyPatch: (patch: Partial<ArticleSlot>) => void)}
    {@const activePerspective = slot.hoveredPerspective ? [slot.hoveredPerspective] : []}
    <div class="compare-section">
      {#if slot.detail?.fullText}
        <div class="article-body-text">
          {#each splitParagraphs(slot.detail.fullText) as paragraph, i (i)}
            <p class="article-paragraph">
              <EntityHighlighter
                text={paragraph.text}
                entities={slot.entities}
                perspectiveWords={activePerspective}
                on:entity-click={(event) => applyPatch({ selectedEntity: event.detail.entity })}
              />
            </p>
          {/each}
        </div>
      {:else if slot.detail?.contentSnippet}
        <p>{@html highlightWords(slot.detail.contentSnippet, activePerspective)}</p>
      {:else if slot.detail?.extractionStatus === "PENDING"}
        <p class="placeholder-pending">Article body extraction pending</p>
      {:else if slot.detail?.extractionStatus === "FAILED"}
        <p class="placeholder-pending">Article body extraction failed</p>
      {:else if slot.detail}
        <p class="placeholder-pending">No body available</p>
      {/if}
    </div>
  {/snippet}

  {#snippet sectionNearDup(slot: ArticleSlot)}
    <div class="compare-section">
      {#if slot.detail && slot.detail.nearDuplicatePeers.length > 0}
        <div class="other-coverage">
          <h4 class="other-coverage-title">Also covered by</h4>
          <ul class="other-coverage-list">
            {#each slot.detail.nearDuplicatePeers as peer (peer.articleId)}
              <li class="other-coverage-item">
                <a class="other-coverage-link" href={articlePath(peer.articleId)} on:click={(event) => handleInternalNavigation(event, articlePath(peer.articleId))}>
                  <img class="favicon" src={faviconUrl(peer.domain)} alt="" loading="lazy" width="14" height="14" on:error={handleFaviconError} />
                  <span class="other-coverage-domain">{peer.domain}</span>
                  <span class="other-coverage-headline">{peer.title}</span>
                </a>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    </div>
  {/snippet}

  {#snippet sentimentPill(score: number)}
    {@const tone = score > 0.01 ? "positive" : score < -0.01 ? "negative" : "neutral"}
    {@const label = tone === "positive" ? "Positive" : tone === "negative" ? "Negative" : "Neutral"}
    <span class={`sentiment-pill sentiment-pill--${tone}`} title={`Sentiment score ${score.toFixed(4)}`}>
      {label}{#if tone !== "neutral"} {score.toFixed(2)}{/if}
    </span>
  {/snippet}

  {#snippet sectionSentiment(slot: ArticleSlot)}
    <div class="compare-section">
      {#if slot.detail}
        {@render sentimentPill(slot.detail.sentiment)}
      {/if}
    </div>
  {/snippet}

  {#snippet sectionTags(slot: ArticleSlot)}
    <section class="aside-block compare-section">
      <h4 class="aside-title">Tags</h4>
      {#if slot.detail && slot.detail.keywords.length > 0}
        <div class="chip-row">
          {#each slot.detail.keywords as keyword}
            <a href={tagPath(keyword)} class="chip" on:click={(event) => handleInternalNavigation(event, tagPath(keyword))}>{keyword}</a>
          {/each}
        </div>
      {:else}
        <p class="placeholder-pending">Tags pending</p>
      {/if}
    </section>
  {/snippet}

  {#snippet sectionPerspective(slot: ArticleSlot, applyPatch: (patch: Partial<ArticleSlot>) => void)}
    <section class="aside-block compare-section">
      <h4 class="aside-title">Distinctive vs. other sources</h4>
      {#if slot.perspectiveWords.length > 0}
        <p class="aside-hint">Hover a term to highlight it in the article.</p>
        <div class="chip-row">
          {#each slot.perspectiveWords as word}
            <span
              class="chip perspective-word-chip"
              class:active={slot.hoveredPerspective === word}
              on:mouseenter={() => applyPatch({ hoveredPerspective: word })}
              on:mouseleave={() => applyPatch({ hoveredPerspective: null })}
              on:focus={() => applyPatch({ hoveredPerspective: word })}
              on:blur={() => applyPatch({ hoveredPerspective: null })}
              role="button"
              tabindex="0"
            >{word}</span>
          {/each}
        </div>
      {:else if slot.perspectiveLoading}
        <p class="signals">Loading distinctive words…</p>
      {:else}
        <p class="placeholder-pending">Distinctive words pending</p>
      {/if}
    </section>
  {/snippet}

  {#snippet sectionEntities(slot: ArticleSlot, applyPatch: (patch: Partial<ArticleSlot>) => void)}
    <section class="aside-block compare-section">
      <h4 class="aside-title">Named entities</h4>
      {#if slot.entities.length > 0}
        <EntityStats
          entities={slot.entities}
          selectedEntityId={slot.selectedEntity?.id ?? null}
          onEntitySelect={(entity) => applyPatch({ selectedEntity: entity })}
        />
      {:else if slot.entitiesLoading}
        <p class="signals">Loading entities…</p>
      {:else if slot.entitiesError}
        <p class="entity-error">{slot.entitiesError}</p>
      {:else}
        <p class="placeholder-pending">Named entities pending</p>
      {/if}
    </section>
  {/snippet}

  {#if currentView.kind === "about"}
    <section class="panel focus-page about-page" use:debugComponent={componentLabel("AboutPage")}>
      <div class="detail-head">
        <div>
          <p class="eyebrow">About</p>
          <h2>About NewsInPerspective</h2>
        </div>
        <div class="page-actions">
          <a href="/" class="tab back-link" on:click={(event) => handleInternalNavigation(event, "/")}>Back to feed</a>
        </div>
      </div>

      <p>
        This is an NLP experiment for the
        <a href="https://coursehandbook.uts.edu.au/subject/2026/36118" target="_blank" rel="noreferrer">UTS Applied Natural Language Processing (36118)</a>
        class, Autumn 2026.
      </p>

      <h3>Subject coordinator &amp; teachers</h3>
      <ul>
        <li>
          <a href="https://www.linkedin.com/in/arnick-abdollahi-28416b80/" target="_blank" rel="noreferrer">Dr Arnick Abdollahi</a>
          (subject coordinator) &mdash;
          <a href="https://profiles.uts.edu.au/Arnick.Abdollahi" target="_blank" rel="noreferrer">UTS profile</a>
        </li>
        <li>
          <a href="https://www.linkedin.com/in/mutazag/" target="_blank" rel="noreferrer">Mutaz Abu Ghazaleh</a>
          (teacher, Founder of MAGTech.ai)
        </li>
        <li>
          <a href="https://www.linkedin.com/in/sarah-fawcett-6b120114a/" target="_blank" rel="noreferrer">Sarah Fawcett</a>
          (teacher)
        </li>
      </ul>

      <h3>Authors</h3>
      <ul>
        <li><a href="https://www.linkedin.com/in/coezbek/" target="_blank" rel="noreferrer">Christopher Oezbek</a></li>
        <li>Raul Perez Garcia</li>
        <li><a href="https://www.linkedin.com/in/siqi-zhang-a785b334b/" target="_blank" rel="noreferrer">Siqi Zhang</a></li>
        <li>Myeongjin Han</li>
        <li>Andrew Fenelon</li>
      </ul>

      <h3>Source code</h3>
      <p>
        The full source code for this project is on GitHub:
        <a href="https://github.com/coezbek/newsinperspective" target="_blank" rel="noreferrer">github.com/coezbek/newsinperspective</a>.
      </p>

      <h3>Technologies used</h3>
      <ul>
        <li>News data from <a href="https://kite.kagi.com/" target="_blank" rel="noreferrer">Kagi News (Kite)</a></li>
        <li><a href="https://svelte.dev/" target="_blank" rel="noreferrer">Svelte</a> + <a href="https://vitejs.dev/" target="_blank" rel="noreferrer">Vite</a> for the web frontend</li>
        <li><a href="https://nodejs.org/" target="_blank" rel="noreferrer">Node.js</a> + <a href="https://fastify.dev/" target="_blank" rel="noreferrer">Fastify</a> + <a href="https://www.typescriptlang.org/" target="_blank" rel="noreferrer">TypeScript</a> for the API</li>
        <li><a href="https://www.prisma.io/" target="_blank" rel="noreferrer">Prisma</a> ORM with <a href="https://www.postgresql.org/" target="_blank" rel="noreferrer">PostgreSQL</a></li>
        <li><a href="https://openrouter.ai/" target="_blank" rel="noreferrer">OpenRouter</a> for LLM-based keyword and entity enrichment</li>
        <li>Named entity recognition and entity linking against <a href="https://www.wikidata.org/" target="_blank" rel="noreferrer">Wikidata</a></li>
      </ul>
    </section>
  {/if}

  {#if currentView.kind === "pipeline"}
    <section class="panel focus-page" use:debugComponent={componentLabel("PipelinePageWrapper")}>
      <div class="detail-head">
        <div>
          <p class="eyebrow">Operations</p>
          <h2>Pipeline</h2>
        </div>
        <div class="page-actions">
          <a href="/" class="tab back-link" on:click={(event) => handleInternalNavigation(event, "/")}>Back to feed</a>
        </div>
      </div>
      <PipelinePage apiBase={API_BASE} />
    </section>
  {/if}

  {#if currentView.kind === "perspective"}
    <PerspectiveStatsPage apiBase={API_BASE} onNavigate={handleInternalNavigation} />
  {/if}

  {#if currentView.kind === "date"}
    <section class="panel focus-page" use:debugComponent={componentLabel("DatePageHeader", currentView.date)}>
      <div class="detail-head">
        <div>
          <p class="eyebrow">Day</p>
          <h2>{currentView.date}</h2>
        </div>
        <div class="page-actions">
          <a href="/" class="tab back-link" on:click={(event) => handleInternalNavigation(event, "/")}>Back to feed</a>
        </div>
      </div>
    </section>
  {/if}

  {#if currentView.kind === "feed" || currentView.kind === "tag" || currentView.kind === "date"}
    {#each daySections as section (section.date)}
    <section class="day-block panel" use:debugComponent={componentLabel("DaySection", section.date)}>
      <div class="day-bar" use:debugComponent={componentLabel("DayBar", section.date)}>
        <div class="day-bar-lead">
          <span class="day-pill" use:debugComponent={componentLabel("DaySeparator", section.date)}>{section.date}</span>
          <p class="eyebrow" use:debugComponent={componentLabel("DayHeader", section.date)}>Top Stories</p>
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

        <div class="day-bar-stats">
          <span><strong>{section.stories.length}</strong> clusters</span>
          <span aria-hidden="true">·</span>
          <span><strong>{storySourceTotal(section)}</strong> sources</span>
          <span aria-hidden="true">·</span>
          <span><strong>{storyArticleTotal(section)}</strong> articles</span>
        </div>
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
                <strong>
                  <a href={storyPath(story.id)} on:click|stopPropagation={(event) => handleInternalNavigation(event, storyPath(story.id))}>
                    {story.translatedTitle ?? story.title}
                  </a>
                </strong>
                <span class="signals">{formatDateRange(story.dateFrom, story.dateUntil)}</span>
                <span class="story-keywords">
                  {#each story.keywords as keyword}
                    <a href={tagPath(keyword)} on:click|stopPropagation={(event) => handleInternalNavigation(event, tagPath(keyword))}>{keyword}</a>
                  {/each}
                </span>
              </button>
            {/each}
          </div>
        </div>

        <section class="detail panel" use:debugComponent={componentLabel("ClusterSummary", section.date)}>
          {#if section.selectedStory}
            <div use:debugComponent={componentLabel("ClusterSummaryHeader", shortId(section.selectedStory.id))}>
              <ClusterSummary
                story={section.selectedStory}
                comparison={section.comparison}
                {articlePath}
                {storyPath}
                {sourcePath}
                {tagPath}
                {datePath}
                {faviconUrl}
                {formatDateRange}
                {formatScopeLabel}
                {otherSourceCount}
                onNavigate={handleInternalNavigation}
                onFaviconError={handleFaviconError}
              />
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

    {#if currentView.kind !== "date"}
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
  {/if}

  </main>

<footer class="site-footer" use:debugComponent={componentLabel("SiteFooter")}>
  <span>© {new Date().getFullYear()} <a href="/" on:click={(event) => handleInternalNavigation(event, "/")}>NewsInPerspective</a></span>
  <span class="footer-sep" aria-hidden="true">·</span>
  <a href="/about" on:click={(event) => handleInternalNavigation(event, "/about")}>About</a>
  <span class="footer-sep" aria-hidden="true">·</span>
  <a href="/pipeline" on:click={(event) => handleInternalNavigation(event, "/pipeline")}>Pipeline</a>
  <span class="footer-sep" aria-hidden="true">·</span>
  <a href="/perspective" on:click={(event) => handleInternalNavigation(event, "/perspective")}>Perspective stats</a>
  <span class="footer-sep" aria-hidden="true">·</span>
  <a href="https://github.com/coezbek/newsinperspective" target="_blank" rel="noreferrer">GitHub</a>
</footer>

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
    padding: 24px 20px 96px;
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

  .hero {
    position: relative;
    overflow: hidden;
    isolation: isolate;
  }

  .hero-aurora {
    position: absolute;
    inset: 0;
    z-index: -1;
    pointer-events: none;
    overflow: hidden;
  }

  .aurora-blob {
    position: absolute;
    width: 420px;
    height: 420px;
    border-radius: 50%;
    filter: blur(60px);
    opacity: 0.55;
    will-change: transform;
  }

  .aurora-blob.blob-a {
    background: radial-gradient(circle at 30% 30%, #7aa2ff, transparent 65%);
    top: -160px;
    left: -120px;
    animation: aurora-drift-a 18s ease-in-out infinite alternate;
  }

  .aurora-blob.blob-b {
    background: radial-gradient(circle at 60% 40%, #ff9ec7, transparent 65%);
    top: -80px;
    right: -120px;
    animation: aurora-drift-b 22s ease-in-out infinite alternate;
  }

  .aurora-blob.blob-c {
    background: radial-gradient(circle at 50% 50%, #74e0c6, transparent 65%);
    bottom: -200px;
    left: 30%;
    width: 480px;
    height: 480px;
    opacity: 0.4;
    animation: aurora-drift-c 26s ease-in-out infinite alternate;
  }

  .aurora-grid {
    position: absolute;
    inset: 0;
    background-image:
      linear-gradient(rgba(20, 32, 51, 0.05) 1px, transparent 1px),
      linear-gradient(90deg, rgba(20, 32, 51, 0.05) 1px, transparent 1px);
    background-size: 32px 32px;
    mask-image: radial-gradient(ellipse at center, rgba(0, 0, 0, 0.6), transparent 75%);
  }

  @keyframes aurora-drift-a {
    0% { transform: translate(0, 0) scale(1); }
    100% { transform: translate(80px, 60px) scale(1.15); }
  }
  @keyframes aurora-drift-b {
    0% { transform: translate(0, 0) scale(1); }
    100% { transform: translate(-70px, 90px) scale(1.1); }
  }
  @keyframes aurora-drift-c {
    0% { transform: translate(0, 0) scale(1); }
    100% { transform: translate(-50px, -70px) scale(1.2); }
  }

  .brand-line {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }

  .brand-pulse {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #2bd49c;
    box-shadow: 0 0 0 0 rgba(43, 212, 156, 0.55);
    animation: brand-pulse 2.4s ease-out infinite;
  }

  @keyframes brand-pulse {
    0% { box-shadow: 0 0 0 0 rgba(43, 212, 156, 0.55); }
    70% { box-shadow: 0 0 0 10px rgba(43, 212, 156, 0); }
    100% { box-shadow: 0 0 0 0 rgba(43, 212, 156, 0); }
  }

  .hero-title {
    font-size: clamp(1.7rem, 2.6vw, 2.6rem);
    font-weight: 700;
    line-height: 1.05;
    max-width: 22ch;
  }

  .hero-accent {
    background: linear-gradient(95deg, #3a5cff 0%, #b045ff 55%, #ff5b8a 100%);
    background-size: 200% 100%;
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    animation: hero-accent-shift 6s ease-in-out infinite alternate;
  }

  @keyframes hero-accent-shift {
    0% { background-position: 0% 50%; }
    100% { background-position: 100% 50%; }
  }

  .hero-rotator {
    position: relative;
    display: inline-block;
    vertical-align: baseline;
    line-height: inherit;
  }

  .hero-rotator-sizer {
    visibility: hidden;
    display: inline-block;
    white-space: pre;
  }

  .hero-rotator-word {
    position: absolute;
    left: 0;
    top: 0;
    white-space: pre;
    background: linear-gradient(95deg, #1aa37a, #3a5cff);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    font-weight: 700;
  }

  .cluster-strip {
    position: relative;
    margin-top: 18px;
    padding: 14px 18px 18px;
    border-radius: 18px;
    background: rgba(255, 255, 255, 0.55);
    border: 1px solid rgba(20, 32, 51, 0.08);
    backdrop-filter: blur(8px);
  }

  .cluster-strip-header {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 10px 14px;
    margin-bottom: 18px;
  }

  .cluster-strip-tag {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    border-radius: 999px;
    background: linear-gradient(95deg, rgba(58, 92, 255, 0.12), rgba(176, 69, 255, 0.12));
    color: #3a5cff;
    font-size: 0.7rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    font-weight: 600;
  }

  .cluster-strip-title {
    font-weight: 600;
    font-size: 1rem;
    color: #14202f;
    text-decoration: none;
    flex: 1 1 auto;
    min-width: 0;
  }
  .cluster-strip-title:hover { text-decoration: underline; }

  .cluster-strip-meta {
    color: var(--muted);
    font-size: 0.78rem;
    letter-spacing: 0.04em;
  }

  .cluster-arc {
    position: relative;
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    gap: 8px;
    padding: 8px 4px 4px;
    min-height: 64px;
  }

  .cluster-arc-line {
    position: absolute;
    left: 16px;
    right: 16px;
    top: 32px;
    height: 1px;
    background: linear-gradient(90deg, transparent, rgba(58, 92, 255, 0.35), rgba(176, 69, 255, 0.35), transparent);
    pointer-events: none;
  }

  .cluster-node {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    text-decoration: none;
    color: #34455d;
    flex: 0 0 auto;
    transition: transform 180ms ease;
    /* gentle staggered float */
    animation: cluster-node-float 4.8s ease-in-out infinite;
    animation-delay: calc(var(--i, 0) * 240ms);
  }

  .cluster-node:hover {
    transform: translateY(-3px);
  }

  .cluster-node-dot {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: #fff;
    border: 1px solid rgba(20, 32, 51, 0.1);
    box-shadow: 0 6px 14px rgba(20, 32, 51, 0.12);
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }
  .cluster-node-dot img {
    width: 22px;
    height: 22px;
    object-fit: contain;
  }
  .cluster-node-dot-more {
    background: linear-gradient(135deg, #3a5cff, #b045ff);
    color: #fff;
    font-size: 0.72rem;
    font-weight: 600;
    border: none;
  }

  .cluster-node-label {
    font-size: 0.72rem;
    color: var(--muted);
    max-width: 22ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cluster-node-skeleton .cluster-node-dot {
    background: linear-gradient(90deg, rgba(20,32,51,0.06), rgba(20,32,51,0.12), rgba(20,32,51,0.06));
    background-size: 200% 100%;
    animation: cluster-skeleton 1.4s ease-in-out infinite;
  }

  .cluster-strip-title-placeholder,
  .cluster-strip-meta-placeholder {
    display: inline-block;
    height: 1em;
    border-radius: 6px;
    background: linear-gradient(90deg, rgba(20,32,51,0.06), rgba(20,32,51,0.12), rgba(20,32,51,0.06));
    background-size: 200% 100%;
    animation: cluster-skeleton 1.4s ease-in-out infinite;
  }
  .cluster-strip-title-placeholder {
    flex: 1 1 auto;
    min-width: 0;
    max-width: 32ch;
  }
  .cluster-strip-meta-placeholder {
    width: 14ch;
    height: 0.78rem;
  }
  .cluster-arc-bar {
    flex: 1 1 auto;
    align-self: stretch;
    border-radius: 12px;
    background: linear-gradient(90deg, rgba(20,32,51,0.06), rgba(20,32,51,0.12), rgba(20,32,51,0.06));
    background-size: 200% 100%;
    animation: cluster-skeleton 1.4s ease-in-out infinite;
  }

  @keyframes cluster-node-float {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-3px); }
  }
  @keyframes cluster-skeleton {
    0% { background-position: 100% 0; }
    100% { background-position: -100% 0; }
  }

  @media (prefers-reduced-motion: reduce) {
    .aurora-blob,
    .hero-accent,
    .cluster-node,
    .cluster-node-skeleton .cluster-node-dot,
    .brand-pulse {
      animation: none !important;
    }
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

  .facet-list--tight {
    gap: 6px;
    margin-top: 14px;
  }

  .tag-page .tag-hero {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    padding: 4px 4px 14px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 18px;
  }

  .tag-hero-title {
    margin: 6px 0 6px;
    font-size: clamp(1.8rem, 3vw, 2.6rem);
    line-height: 1.04;
    background: linear-gradient(135deg, var(--accent-strong, #1d4ed8), #6f3ad9);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }

  .tag-hero-range {
    margin: 0;
    color: var(--muted);
    font-size: 0.85rem;
    letter-spacing: 0.02em;
  }

  .tag-stat-row {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
    margin-bottom: 16px;
  }

  .tag-stat-card {
    padding: 14px 16px;
    border-radius: 16px;
    border: 1px solid var(--border-strong);
    background: linear-gradient(135deg, var(--panel-strong), rgba(220, 232, 255, 0.62));
    display: grid;
    gap: 4px;
  }

  .tag-stat-card strong {
    font-size: 1.5rem;
    line-height: 1.1;
    letter-spacing: -0.02em;
  }

  .tag-stat-card--wide strong {
    font-size: 1.05rem;
    line-height: 1.2;
  }

  .top-sources-panel {
    background: linear-gradient(160deg, rgba(255, 255, 255, 0.95), rgba(232, 240, 255, 0.7));
  }

  .top-sources-list {
    list-style: none;
    padding: 0;
    margin: 12px 0 0;
    display: grid;
    gap: 10px;
  }

  .top-source-row {
    display: grid;
    grid-template-columns: 22px minmax(120px, 1fr) minmax(80px, 2fr) auto;
    align-items: center;
    gap: 12px;
  }

  .top-source-rank {
    font-weight: 700;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    font-size: 0.95rem;
  }

  .top-source-link {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    text-decoration: none;
    color: var(--text);
    min-width: 0;
  }

  .top-source-link:hover .top-source-name {
    text-decoration: underline;
  }

  .top-source-favicon {
    width: 20px;
    height: 20px;
    border-radius: 4px;
    flex: 0 0 auto;
  }

  .top-source-name {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .top-source-bar {
    height: 8px;
    background: rgba(20, 55, 111, 0.08);
    border-radius: 999px;
    overflow: hidden;
  }

  .top-source-bar-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--accent-strong, #1d4ed8), #6f3ad9);
    border-radius: 999px;
    transition: width 200ms ease;
  }

  .top-source-count {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    color: #2f435e;
    min-width: 2ch;
    text-align: right;
  }

  @media (max-width: 720px) {
    .tag-stat-row {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .top-source-row {
      grid-template-columns: 20px minmax(100px, 1fr) auto;
    }

    .top-source-bar {
      grid-column: 1 / -1;
    }
  }

  .hero-row {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: 16px;
  }

  .day-bar {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    column-gap: 16px;
    row-gap: 12px;
    margin-bottom: 16px;
  }

  .day-bar-lead {
    display: flex;
    align-items: center;
    gap: 12px;
    grid-column: 1;
    grid-row: 1;
    min-width: 0;
  }

  .day-bar-stats {
    grid-column: 2;
    grid-row: 1;
    display: flex;
    align-items: baseline;
    gap: 6px;
    color: var(--muted);
    font-size: 0.78rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .day-bar-stats strong {
    color: var(--text);
    font-size: 0.9rem;
    font-weight: 700;
  }

  .day-bar .tab-row {
    grid-column: 1 / -1;
    grid-row: 2;
    flex-wrap: wrap;
    overflow: visible;
    min-width: 0;
    margin: 0;
    padding: 0;
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

  .day-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    padding: 8px 12px;
    background: linear-gradient(135deg, var(--accent-soft), rgba(207, 226, 255, 0.9));
    color: var(--accent-strong);
    font-weight: 700;
    letter-spacing: 0.02em;
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
    padding: 0;
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

  .chip-link,
  a.chip {
    text-decoration: none;
  }

  .perspective-words-block {
    margin: 8px 0 12px;
  }

  .perspective-words-block .signals {
    display: block;
    margin-bottom: 4px;
  }

  .chip.perspective-word-chip {
    background: #fff3b0;
    color: #6b4e00;
    cursor: default;
    transition: box-shadow 120ms ease, transform 120ms ease;
  }

  .chip.perspective-word-chip:hover,
  .chip.perspective-word-chip.active {
    box-shadow: 0 0 0 2px #d9a200;
    transform: translateY(-1px);
  }

  .aside-hint {
    margin: -4px 0 8px;
    color: #58708f;
    font-size: 0.78rem;
    font-style: italic;
  }

  .placeholder-pending {
    margin: 0;
    color: var(--muted, #58708f);
    font-size: 0.85rem;
    font-style: italic;
  }

  :global(mark.perspective-word) {
    background: #fff3b0;
    color: inherit;
    /* Zero padding so toggling the mark on hover does not reflow text. */
    padding: 0;
    border-radius: 2px;
    font-weight: inherit;
    box-shadow: 0 0 0 2px #fff3b0;
  }

  .chip-link:hover,
  a.chip:hover {
    text-decoration: none;
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

  .article-original-title {
    margin: 4px 0 12px;
    color: var(--muted, #58708f);
    font-size: 0.95rem;
    font-style: italic;
    font-weight: 500;
  }

  .article-page {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .article-header-strip {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    color: var(--muted, #58708f);
    font-size: 0.88rem;
    position: relative;
    z-index: 11; /* sit above the next `.detail-head` so its negative margin doesn't clip the back button */
  }

  .story-page > .article-header-strip {
    margin-bottom: 8px;
  }

  .article-header-strip .eyebrow {
    margin: 0;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-size: 0.74rem;
    color: var(--muted, #58708f);
  }

  a.article-eyebrow-link {
    text-decoration: none;
    border-bottom: 1px dotted rgba(88, 112, 143, 0.5);
  }
  a.article-eyebrow-link:hover {
    color: var(--accent-strong, #0a3c96);
    border-bottom-color: currentColor;
  }

  .article-header-sep {
    color: rgba(88, 112, 143, 0.5);
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

  .article-header-actions {
    margin-left: auto;
    display: flex;
    gap: 8px;
  }

  .compare-page {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .compare-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    grid-auto-rows: min-content;
    gap: 14px 18px;
    align-items: stretch;
  }

  .compare-section {
    min-width: 0;
    align-self: stretch;
  }

  @media (max-width: 1100px) {
    .compare-grid {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  .article-layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(260px, 320px);
    gap: 20px;
    align-items: start;
  }

  .article-main {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .article-title {
    margin: 0;
    font-size: 1.55rem;
    line-height: 1.25;
    color: #142033;
  }

  .article-body-text {
    color: #142033;
  }

  .article-aside {
    position: sticky;
    top: 16px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .aside-block {
    padding: 12px 14px;
    border-radius: 12px;
    border: 1px solid rgba(37, 87, 167, 0.16);
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.88), rgba(240, 247, 255, 0.84));
  }

  .aside-title {
    margin: 0 0 8px;
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #58708f;
    font-weight: 600;
  }

  .article-summary-story {
    margin: 8px 0 0;
    padding-top: 8px;
    border-top: 1px solid rgba(37, 87, 167, 0.16);
    color: #34445c;
    font-size: 0.9rem;
  }

  @media (max-width: 980px) {
    .article-layout {
      grid-template-columns: minmax(0, 1fr);
    }
    .article-aside {
      position: static;
    }
    .article-header-actions {
      margin-left: 0;
      width: 100%;
    }
  }

  .lang-pill {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border-radius: 999px;
    background: rgba(15, 98, 254, 0.1);
    color: #0a3c96;
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.04em;
  }

  .sentiment-pill {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.02em;
    line-height: 1.4;
  }
  .sentiment-pill--positive { background: #dff5e1; color: #1e6b3a; }
  .sentiment-pill--neutral  { background: #eef0f4; color: #4a5568; }
  .sentiment-pill--negative { background: #fde2e4; color: #8b1e3f; }

  .tab--primary {
    background: linear-gradient(135deg, var(--accent), var(--accent-strong));
    color: #fff;
    border-color: transparent;
    text-decoration: none;
  }

  .article-summary-callout {
    margin: 8px 0 12px;
    padding: 12px 14px;
    border-left: 3px solid var(--accent, #0f62fe);
    background: rgba(220, 232, 255, 0.45);
    border-radius: 0 10px 10px 0;
  }

  .article-summary-callout p {
    margin: 4px 0 0;
    color: #142033;
    font-size: 0.96rem;
    line-height: 1.5;
  }

  .article-summary-label {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #58708f;
    font-weight: 600;
  }

  .translation-notice {
    margin: 0 0 10px;
    color: #58708f;
    font-size: 0.82rem;
    font-style: italic;
  }

  .article-paragraph {
    margin: 0 0 12px;
    line-height: 1.6;
  }

  .article-paragraph:last-child {
    margin-bottom: 0;
  }

  .other-coverage {
    margin-top: 18px;
    padding: 12px 14px;
    border-radius: 12px;
    border: 1px solid rgba(37, 87, 167, 0.16);
    background: rgba(245, 249, 255, 0.6);
  }

  .other-coverage-title {
    margin: 0 0 8px;
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #58708f;
    font-weight: 600;
  }

  .other-coverage-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .other-coverage-link {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border-radius: 8px;
    color: #142033;
    text-decoration: none;
    transition: background-color 120ms ease;
  }

  .other-coverage-link:hover {
    background: rgba(255, 255, 255, 0.7);
  }

  .other-coverage-domain {
    flex-shrink: 0;
    font-weight: 600;
    color: #0a3c96;
    font-size: 0.85rem;
  }

  .other-coverage-headline {
    flex: 1;
    min-width: 0;
    color: #34445c;
    font-size: 0.88rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
  .entity-error {
    color: var(--muted);
    font-size: 0.82rem;
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

  .brand-link {
    text-decoration: none;
    color: inherit;
  }

  .brand-link:hover {
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  .about-page ul {
    margin: 6px 0 16px;
    padding-left: 20px;
    line-height: 1.6;
  }

  .about-page a {
    color: var(--accent);
    text-decoration: none;
    font-weight: 600;
  }

  .about-page a:hover {
    text-decoration: underline;
  }

  .site-footer {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 100;
    padding: 10px 16px;
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 10px;
    color: var(--muted);
    font-size: 0.82rem;
    border-top: 1px solid var(--border);
    background: rgba(255, 255, 255, 0.88);
    backdrop-filter: blur(10px);
  }

  .site-footer a {
    color: var(--accent-strong);
    text-decoration: none;
    font-weight: 600;
  }

  .site-footer a:hover {
    text-decoration: underline;
  }

  .footer-sep {
    opacity: 0.6;
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
    .day-layout {
      grid-template-columns: 1fr;
      display: grid;
    }

    .day-bar {
      grid-template-columns: 1fr;
    }

    .day-bar-stats {
      grid-column: 1;
      grid-row: auto;
      flex-wrap: wrap;
      white-space: normal;
    }

    .day-bar .tab-row {
      grid-column: 1;
      grid-row: auto;
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

    .entity-content {
      grid-template-columns: 1fr;
    }
  }
</style>
