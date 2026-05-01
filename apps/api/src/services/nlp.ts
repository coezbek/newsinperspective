import { ArticleFeatureSet } from "../domain/types.js";
import {
  detectLanguageFromText,
  detectBiasSignals,
  extractEntities,
  extractKeywords,
  scoreSentiment,
  scoreSubjectivity,
} from "../domain/text.js";
import { extractArticleEnrichmentWithOpenRouter } from "./openrouter-article-enrichment.js";
import { extractKeywordsWithOpenRouter } from "./openrouter-keywords.js";

export function buildArticleFeatures(
  title: string,
  summary: string | null,
  body: string | null,
  language: string | null,
): ArticleFeatureSet {
  const detectedLanguage = language ?? detectLanguageFromText(title, summary, body);
  // When language inference is unknown, downstream tokenization uses a combined stopword set.
  const analysisLanguage = detectedLanguage ?? null;
  return {
    keywords: extractKeywords(analysisLanguage, title, summary, body),
    keywordsEnglish: extractKeywords(analysisLanguage, title, summary, body),
    entities: extractEntities(title, summary, body),
    personEntities: [],
    organizationEntities: [],
    placeEntities: [],
    sentiment: scoreSentiment(analysisLanguage, title, summary, body),
    subjectivity: scoreSubjectivity(analysisLanguage, title, summary, body),
    biasSignals: detectBiasSignals(title, summary, body),
    language: detectedLanguage,
    translatedTitle: null,
    translatedSummary: null,
  };
}

export async function buildArticleFeaturesWithOpenRouter(
  title: string,
  summary: string | null,
  body: string | null,
  language: string | null,
  options?: {
    maxKeywords?: number;
    onAttemptLog?: (message: string) => void;
  },
): Promise<ArticleFeatureSet> {
  const base = buildArticleFeatures(title, summary, body, language);
  const openrouter = await extractArticleEnrichmentWithOpenRouter({
    title,
    summary,
    body,
    language: base.language,
    ...(typeof options?.maxKeywords === "number" ? { maxKeywords: options.maxKeywords } : {}),
    ...(options?.onAttemptLog ? { onAttemptLog: options.onAttemptLog } : {}),
  });

  const personEntities = openrouter.persons.length > 0 ? openrouter.persons : base.personEntities;
  const organizationEntities = openrouter.organizations.length > 0 ? openrouter.organizations : base.organizationEntities;
  const placeEntities = openrouter.places.length > 0 ? openrouter.places : base.placeEntities;
  const mergedEntities = [...new Set([...base.entities, ...personEntities, ...organizationEntities, ...placeEntities])];

  return {
    ...base,
    keywords: openrouter.keywords.length > 0 ? openrouter.keywords : base.keywords,
    keywordsEnglish: openrouter.keywords.length > 0 ? openrouter.keywords : base.keywordsEnglish,
    entities: mergedEntities,
    personEntities,
    organizationEntities,
    placeEntities,
    language: openrouter.language ?? base.language,
    translatedTitle: openrouter.translatedTitle ?? base.translatedTitle,
    translatedSummary: openrouter.translatedSummary ?? base.translatedSummary,
  };
}

interface ClusterKeywordArticle {
  title: string;
  summary: string | null;
  body: string | null;
  language: string | null;
  keywords?: string[] | null;
}

interface ClusterKeywordResult {
  keywords: string[];
  source: "openrouter";
  status: "ready" | "keywords_pending";
  model: string | null;
  error: string | null;
}

function joinText(parts: Array<string | null | undefined>, maxLength: number): string {
  const text = parts.filter((value): value is string => Boolean(value)).join("\n\n");
  return text.slice(0, maxLength);
}

function pickLanguage(values: Array<string | null | undefined>): string | null {
  const histogram = new Map<string, number>();
  for (const value of values) {
    if (!value) continue;
    histogram.set(value, (histogram.get(value) ?? 0) + 1);
  }
  const sorted = [...histogram.entries()].sort((left, right) => right[1] - left[1]);
  return sorted[0]?.[0] ?? null;
}

export function buildClusterKeywordFallback(
  articles: ClusterKeywordArticle[],
  limit = 8,
): string[] {
  const counts = new Map<string, number>();

  for (const article of articles) {
    const keywords = article.keywords ?? buildArticleFeatures(
      article.title,
      article.summary,
      article.body,
      article.language,
    ).keywordsEnglish;

    for (const keyword of keywords) {
      const normalized = keyword.trim();
      if (!normalized) continue;
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1];
      return left[0].localeCompare(right[0]);
    })
    .slice(0, limit)
    .map(([keyword]) => keyword);
}

export async function buildClusterKeywordsWithOpenRouter(
  clusterTitle: string,
  articles: ClusterKeywordArticle[],
  options?: {
    maxKeywords?: number;
    onAttemptLog?: (message: string) => void;
  },
): Promise<ClusterKeywordResult> {
  const topArticles = articles.slice(0, 6);
  const language = pickLanguage(topArticles.map((article) => article.language));
  const summary = joinText(topArticles.map((article) => article.summary), 3000);
  const body = joinText(topArticles.map((article) => article.body), 6000);

  const openrouter = await extractKeywordsWithOpenRouter({
    title: clusterTitle,
    summary,
    body,
    language,
    maxKeywords: options?.maxKeywords ?? 8,
    ...(options?.onAttemptLog ? { onAttemptLog: options.onAttemptLog } : {}),
  });

  if (!openrouter.error && openrouter.keywords.length > 0) {
    return {
      keywords: openrouter.keywords,
      source: "openrouter",
      status: "ready",
      model: openrouter.model,
      error: null,
    };
  }

  return {
    keywords: [],
    source: "openrouter",
    status: "keywords_pending",
    model: openrouter.model,
    error: openrouter.error,
  };
}
