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
  /**
   * Abstractive summary of the article's distinctive framing — written by
   * the LLM at enrichment time, intended for SBERT embedding rather than
   * display. Bounded length (~600-1000 chars) so it never trips the
   * output-token cap that truncates `translatedFullText`. Falls back to
   * `translatedFullText` when null (heuristic-only enrichment, older rows).
   */
  framingSummary: string | null;
  /**
   * `false` when the LLM determines the text is not a real article
   * (corporate boilerplate, paywall page, photo-credit page, etc).
   * Downstream stages should treat non-newsworthy articles like
   * empty-text articles. `null` means we haven't asked the LLM yet
   * (heuristic-only enrichment path).
   */
  isNewsworthy: boolean | null;
  notNewsworthyReason: string | null;
}
