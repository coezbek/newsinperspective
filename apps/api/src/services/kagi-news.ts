import { Browser, chromium } from "playwright";
import { DiskCache } from "./disk-cache.js";

export interface KagiBatchCategoriesResponse {
  batchId: string;
  createdAt: string;
  categories: Array<{
    id: string;
    categoryId: string;
    categoryName: string;
    readCount: number;
    clusterCount: number;
  }>;
}

export interface KagiStoryArticle {
  title: string;
  link: string;
  domain: string;
  date?: string | undefined;
}

export interface KagiStory {
  id: string;
  cluster_number: number;
  title: string;
  short_summary: string;
  category?: string | undefined;
  unique_domains?: number | undefined;
  number_of_titles?: number | undefined;
  articles: KagiStoryArticle[];
}

interface KagiStoriesResponse {
  batchId: string;
  categoryId: string;
  categoryName: string;
  totalStories: number;
  stories: KagiStory[];
}

const KAGI_API_BASE = "https://news.kagi.com/api";
let kagiBrowserPromise: Promise<Browser> | null = null;

const kagiApiCache = new DiskCache<unknown>({
  namespace: "kagi-api",
  ttlMs: null,
  disableEnvVar: "KAGI_API_CACHE_DISABLE",
  dirEnvVar: "KAGI_API_CACHE_DIR",
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getKagiBrowser(): Promise<Browser> {
  if (!kagiBrowserPromise) {
    kagiBrowserPromise = chromium
      .launch({
        headless: true,
      })
      .catch((error) => {
        kagiBrowserPromise = null;
        throw error;
      });
  }

  return kagiBrowserPromise;
}

export async function closeKagiBrowser(): Promise<void> {
  if (!kagiBrowserPromise) return;
  try {
    const browser = await kagiBrowserPromise;
    await browser.close();
  } finally {
    kagiBrowserPromise = null;
  }
}

async function fetchJson<T>(path: string, options?: { forceRefresh?: boolean }): Promise<T> {
  const url = `${KAGI_API_BASE}${path}`;
  const forceRefresh = options?.forceRefresh ?? false;
  const cacheKey = kagiApiCache.keyFor(url);

  if (!forceRefresh) {
    const cached = await (kagiApiCache as DiskCache<T>).get(cacheKey);
    if (cached !== null) return cached;
  }

  const browser = await getKagiBrowser();
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  try {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await page.goto(url, {
          waitUntil: "commit",
          timeout: 30000,
        });
        const bodyText = await page.locator("body").textContent();
        if (!bodyText) {
          throw new Error(`Kagi API returned empty body for ${path}`);
        }

        if (bodyText.startsWith("429 ")) {
          throw new Error(`Kagi API rate limited request for ${path}: ${bodyText.slice(0, 80)}`);
        }

        const parsed = JSON.parse(bodyText) as T;
        await (kagiApiCache as DiskCache<T>).set(cacheKey, parsed);
        return parsed;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < 3) {
          await sleep((attempt + 1) * 1500);
          continue;
        }
      }
    }

    throw lastError ?? new Error(`Kagi API request failed for ${path}`);
  } finally {
    await page.close();
    await context.close();
  }
}

export async function fetchLatestCategories(
  options?: { forceRefresh?: boolean },
): Promise<KagiBatchCategoriesResponse> {
  return fetchJson<KagiBatchCategoriesResponse>("/batches/latest/categories", options);
}

export async function fetchLatestCategoryStories(
  categoryId: string,
  limit = 100,
  options?: { forceRefresh?: boolean },
): Promise<KagiStoriesResponse> {
  return fetchJson<KagiStoriesResponse>(
    `/batches/latest/categories/${encodeURIComponent(categoryId)}/stories?limit=${limit}`,
    options,
  );
}

export interface KagiTopCluster {
  batchId: string;
  categoryUuid: string;
  categoryId: string;
  categoryName: string;
  story: KagiStory;
}

export interface KagiCategoryFetchProgress {
  current: number;
  total: number;
  categoryName: string;
  status: "start" | "done" | "error";
  storyCount?: number;
  errorMessage?: string;
}

type KagiCategory = KagiBatchCategoriesResponse["categories"][number];

function compareCategoryPriority(left: KagiCategory, right: KagiCategory): number {
  const clusterDelta = right.clusterCount - left.clusterCount;
  if (clusterDelta !== 0) return clusterDelta;
  return right.readCount - left.readCount;
}

function sourceCountFor(story: KagiStory): number {
  return story.unique_domains ?? story.articles.length;
}

function compareClustersBySourceCount(left: KagiTopCluster, right: KagiTopCluster): number {
  const sourceDelta = sourceCountFor(right.story) - sourceCountFor(left.story);
  if (sourceDelta !== 0) return sourceDelta;
  return (right.story.articles.length ?? 0) - (left.story.articles.length ?? 0);
}

async function fetchTopClustersForCategories(
  batchId: string,
  categories: KagiCategory[],
  onProgress?: (progress: KagiCategoryFetchProgress) => void,
): Promise<KagiTopCluster[]> {
  const clusters: KagiTopCluster[] = [];

  for (const [index, category] of categories.entries()) {
    const current = index + 1;
    const total = categories.length;
    onProgress?.({
      current,
      total,
      categoryName: category.categoryName,
      status: "start",
    });

    try {
      let storiesResponse = await fetchLatestCategoryStories(
        category.id,
        Math.min(100, category.clusterCount || 100),
      );
      let stories = Array.isArray(storiesResponse.stories) ? storiesResponse.stories : [];
      if (stories.length === 0 && category.clusterCount > 0) {
        storiesResponse = await fetchLatestCategoryStories(
          category.id,
          Math.min(100, category.clusterCount || 100),
          { forceRefresh: true },
        );
        stories = Array.isArray(storiesResponse.stories) ? storiesResponse.stories : [];
      }

      clusters.push(
        ...stories.map((story) => ({
          batchId,
          categoryUuid: category.id,
          categoryId: category.categoryId,
          categoryName: category.categoryName,
          story,
        })),
      );
      onProgress?.({
        current,
        total,
        categoryName: category.categoryName,
        status: "done",
        storyCount: stories.length,
      });
      await sleep(250);
    } catch (error) {
      onProgress?.({
        current,
        total,
        categoryName: category.categoryName,
        status: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return clusters;
}

function categoryKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

const categoryAliasMap: Record<string, string[]> = {
  world: ["world", "international", "global"],
  usa: ["usa", "us", "unitedstates", "america", "u.s.", "u.s.a"],
  business: ["business"],
  technology: ["technology", "tech"],
  sports: ["sports", "sport"],
  science: ["science"],
  gaming: ["gaming", "games", "videogames", "game"],
};

function categoryTargetKeys(target: string): Set<string> {
  const canonical = categoryKey(target);
  const aliases = categoryAliasMap[canonical] ?? [target];
  return new Set(aliases.map((value) => categoryKey(value)));
}

function findBestCategoryMatch(categories: KagiCategory[], target: string): KagiCategory | null {
  const targets = categoryTargetKeys(target);
  return (
    categories
      .filter((category) => targets.has(categoryKey(category.categoryName)))
      .sort(compareCategoryPriority)[0] ?? null
  );
}

function dedupeClusters(clusters: KagiTopCluster[]): KagiTopCluster[] {
  const seen = new Set<string>();
  const deduped: KagiTopCluster[] = [];
  for (const cluster of clusters) {
    const key = `${cluster.batchId}:${cluster.story.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(cluster);
  }
  return deduped;
}

export async function listTopClustersBySourceCount(limit = 10): Promise<KagiTopCluster[]> {
  const categories = await fetchLatestCategories({ forceRefresh: true });
  const categoryList = Array.isArray(categories.categories) ? categories.categories : [];

  if (categoryList.length === 0) {
    throw new Error(`Kagi categories response did not include a categories array: ${JSON.stringify(categories).slice(0, 500)}`);
  }

  const prioritizedCategories = categoryList
    .filter((category) => category.clusterCount > 0)
    .sort(compareCategoryPriority)
    .slice(0, 30);

  const clusters = await fetchTopClustersForCategories(categories.batchId, prioritizedCategories);
  return clusters
    .sort(compareClustersBySourceCount)
    .slice(0, limit);
}

export interface KagiIngestionSelectionOptions {
  globalLimit?: number;
  perCategoryLimit?: number;
  requiredCategories?: string[];
  onCategoryFetchProgress?: (progress: KagiCategoryFetchProgress) => void;
  onStageMessage?: (message: string) => void;
}

export interface KagiIngestionCoverage {
  requestedCategory: string;
  matchedCategory: string | null;
  selectedCount: number;
}

export interface KagiIngestionSelectionResult {
  clusters: KagiTopCluster[];
  coverage: KagiIngestionCoverage[];
}

const defaultIngestionCategories = [
  "World",
  "USA",
  "Business",
  "Technology",
  "Sports",
  "Science",
  "Gaming",
];

export async function listClustersForIngestion(
  options: KagiIngestionSelectionOptions = {},
): Promise<KagiIngestionSelectionResult> {
  const globalLimit = options.globalLimit ?? 10;
  const perCategoryLimit = options.perCategoryLimit ?? 5;
  const requiredCategories = options.requiredCategories ?? defaultIngestionCategories;
  const onCategoryFetchProgress = options.onCategoryFetchProgress;
  const onStageMessage = options.onStageMessage;

  onStageMessage?.("Fetching latest Kagi categories...");
  const categories = await fetchLatestCategories({ forceRefresh: true });
  const categoryList = Array.isArray(categories.categories) ? categories.categories : [];

  if (categoryList.length === 0) {
    throw new Error(
      `Kagi categories response did not include a categories array: ${JSON.stringify(categories).slice(0, 500)}`,
    );
  }

  const prioritizedCategories = categoryList
    .filter((category) => category.clusterCount > 0)
    .sort(compareCategoryPriority)
    .slice(0, 30);

  const requiredMatches = requiredCategories
    .map((requestedCategory) => ({
      requestedCategory,
      match: findBestCategoryMatch(categoryList, requestedCategory),
    }))
    .filter((item): item is { requestedCategory: string; match: KagiCategory } => Boolean(item.match));

  const categoriesToFetchMap = new Map<string, KagiCategory>();
  for (const category of prioritizedCategories) {
    categoriesToFetchMap.set(category.id, category);
  }
  for (const item of requiredMatches) {
    categoriesToFetchMap.set(item.match.id, item.match);
  }

  onStageMessage?.(`Fetching stories for ${categoriesToFetchMap.size} categories...`);
  const fetchedClusters = await fetchTopClustersForCategories(
    categories.batchId,
    [...categoriesToFetchMap.values()],
    onCategoryFetchProgress,
  );
  onStageMessage?.(`Fetched ${fetchedClusters.length} candidate clusters.`);
  const allClusters = fetchedClusters.sort(compareClustersBySourceCount);

  const selected: KagiTopCluster[] = [];
  const seen = new Set<string>();

  const pushUnique = (cluster: KagiTopCluster): boolean => {
    const key = `${cluster.batchId}:${cluster.story.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    selected.push(cluster);
    return true;
  };

  for (const cluster of allClusters.slice(0, globalLimit)) {
    pushUnique(cluster);
  }

  const coverage: KagiIngestionCoverage[] = requiredCategories.map((requestedCategory) => ({
    requestedCategory,
    matchedCategory: null,
    selectedCount: 0,
  }));

  for (const coverageItem of coverage) {
    const match = findBestCategoryMatch(categoryList, coverageItem.requestedCategory);
    if (!match) continue;

    coverageItem.matchedCategory = match.categoryName;

    const categoryTop = allClusters
      .filter((cluster) => cluster.categoryId === match.categoryId)
      .slice(0, perCategoryLimit);

    coverageItem.selectedCount = categoryTop.length;
    for (const cluster of categoryTop) {
      pushUnique(cluster);
    }
  }

  return {
    clusters: selected.sort(compareClustersBySourceCount),
    coverage,
  };
}
