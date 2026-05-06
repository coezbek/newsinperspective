export interface FeedCandidate {
  url: string;
  category: string | null;
  sourceName: string | null;
}

export interface NormalizedArticleInput {
  originalUrl: string;
  canonicalUrl: string;
  textFingerprint: string | null;
  title: string;
  summary: string | null;
  contentSnippet: string | null;
  publishedAt: Date | null;
  sourceName: string;
  domain: string;
  language: string | null;
  category: string | null;
  authorNames: string[];
}

export interface ArticleFeatureSet {
  keywords: string[];
  keywordsEnglish: string[];
  entities: string[];
  personEntities: string[];
  organizationEntities: string[];
  placeEntities: string[];
  sentiment: number;
  subjectivity: number;
  biasSignals: string[];
  language: string | null;
  translatedTitle: string | null;
  translatedSummary: string | null;
  translatedFullText: string | null;
}
