import { ExtractionStatus, Prisma } from "@prisma/client";
import { Readability } from "@mozilla/readability";
import { JSDOM, VirtualConsole } from "jsdom";
import { Browser, chromium } from "playwright";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { assessExtractedArticleText } from "./content-quality.js";
import { DiskCache } from "./disk-cache.js";

// Browser extraction is the slowest stage of ingest (~5–10s per page);
// cache successful results keyed by URL with a 7-day TTL.
const ARTICLE_TEXT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const articleTextCache = new DiskCache<ExtractedArticleText>({
  namespace: "articles",
  ttlMs: ARTICLE_TEXT_TTL_MS,
  disableEnvVar: "ARTICLE_TEXT_CACHE_DISABLE",
  dirEnvVar: "ARTICLE_TEXT_CACHE_DIR",
});

const MAX_TEXT_LENGTH = 100_000;
let browserPromise: Promise<Browser> | null = null;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateText(value: string): string {
  return value.length > MAX_TEXT_LENGTH ? value.slice(0, MAX_TEXT_LENGTH) : value;
}

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium
      .launch({
        headless: true,
      })
      .catch((error) => {
        browserPromise = null;
        throw error;
      });
  }

  return browserPromise;
}

export async function closeArticleExtractionBrowser(): Promise<void> {
  if (!browserPromise) return;
  try {
    const browser = await browserPromise;
    await browser.close();
  } finally {
    browserPromise = null;
  }
}

function extractFallbackText(document: JSDOM["window"]["document"]): string | null {
  const metaSelectors = [
    'meta[property="og:description"]',
    'meta[name="description"]',
    'meta[name="twitter:description"]',
  ];

  for (const selector of metaSelectors) {
    const value = document.querySelector(selector)?.getAttribute("content");
    if (value && normalizeWhitespace(value)) {
      return normalizeWhitespace(value);
    }
  }

  const paragraphs = [...document.querySelectorAll("article p, main p, p")]
    .map((node) => normalizeWhitespace(node.textContent ?? ""))
    .filter((text) => text.length >= 80)
    .slice(0, 20);

  if (paragraphs.length === 0) return null;
  return paragraphs.join("\n\n");
}

async function fetchArticleHtmlWithBrowser(url: string): Promise<{ html: string; finalUrl: string }> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: env.ARTICLE_FETCH_USER_AGENT,
    locale: "en-US",
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: env.ARTICLE_BROWSER_TIMEOUT_MS,
    });
    await page.waitForLoadState("networkidle", {
      timeout: Math.min(env.ARTICLE_BROWSER_TIMEOUT_MS, 5_000),
    }).catch(() => undefined);
    await page.waitForTimeout(1500);
    return {
      html: await page.content(),
      finalUrl: page.url(),
    };
  } finally {
    await page.close();
    await context.close();
  }
}

function extractTextFromHtml(html: string, url: string, formatPrefix = ""): { text: string; format: string } | null {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("error", () => undefined);
  virtualConsole.on("warn", () => undefined);
  const dom = new JSDOM(html, { url, virtualConsole });
  const article = new Readability(dom.window.document).parse();

  const readableText = normalizeWhitespace(article?.textContent ?? "");
  if (readableText.length >= 280) {
    return {
      text: truncateText(readableText),
      format: `${formatPrefix}readability`,
    };
  }

  const fallbackText = extractFallbackText(dom.window.document);
  if (fallbackText && normalizeWhitespace(fallbackText).length >= 120) {
    return {
      text: truncateText(fallbackText),
      format: `${formatPrefix}fallback`,
    };
  }

  return null;
}

export interface ExtractedArticleText {
  text: string;
  format: string;
  originalUrl: string;
  finalUrl: string;
}

export async function resolveUrlWithBrowser(url: string): Promise<string> {
  const browserResult = await fetchArticleHtmlWithBrowser(url);
  return browserResult.finalUrl;
}

export async function extractArticleTextFromUrl(url: string): Promise<ExtractedArticleText> {
  // Cache only successful extractions. Failures (semantic-content / no-text)
  // throw and bypass the cache, so a flaky failure won't lock in for 7 days.
  const cacheKey = articleTextCache.keyFor(url);
  const cached = await articleTextCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const result = await runArticleTextExtraction(url);
  await articleTextCache.set(cacheKey, result);
  return result;
}

async function runArticleTextExtraction(url: string): Promise<ExtractedArticleText> {
  const browserResult = await fetchArticleHtmlWithBrowser(url);
  const browserExtracted = extractTextFromHtml(browserResult.html, browserResult.finalUrl, "browser:");
  if (browserExtracted) {
    const quality = assessExtractedArticleText(browserExtracted.text);
    if (!quality.ok) {
      throw new Error(`Semantic content failure: ${quality.reasons.join(", ")}`);
    }
    return {
      ...browserExtracted,
      originalUrl: url,
      finalUrl: browserResult.finalUrl,
    };
  }

  throw new Error("No readable article text found");
}

export interface EnrichArticleTextOptions {
  date?: string | undefined;
  limit?: number | undefined;
  force?: boolean | undefined;
  articleIds?: string[] | undefined;
}

export interface EnrichArticleTextResult {
  matched: number;
  attempted: number;
  succeeded: number;
  failed: number;
}

export async function enrichArticleText(options: EnrichArticleTextOptions = {}): Promise<EnrichArticleTextResult> {
  const where: Prisma.ArticleWhereInput = {};

  if (options.date) {
    where.ingestionDate = {
      gte: new Date(`${options.date}T00:00:00.000Z`),
      lte: new Date(`${options.date}T23:59:59.999Z`),
    };
  }

  if (!options.force) {
    where.OR = [
      { fullText: null },
      {
        extractionStatus: {
          in: [ExtractionStatus.PENDING, ExtractionStatus.FAILED],
        },
      },
    ];
  }

  if (options.articleIds && options.articleIds.length > 0) {
    where.id = { in: options.articleIds };
  }

  const matched = await prisma.article.count({ where });
  const articles = await prisma.article.findMany({
    where,
    orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      originalUrl: true,
    },
    ...(options.limit ? { take: options.limit } : {}),
  });

  let succeeded = 0;
  let failed = 0;

  for (const article of articles) {
    try {
      const extracted = await extractArticleTextFromUrl(article.originalUrl);
      await prisma.article.update({
        where: { id: article.id },
        data: {
          fullText: extracted.text,
          fullTextFormat: extracted.format,
          extractionStatus: ExtractionStatus.SUCCESS,
          extractedAt: new Date(),
          extractionError: null,
        },
      });
      succeeded += 1;
    } catch (error) {
      await prisma.article.update({
        where: { id: article.id },
        data: {
          extractionStatus: ExtractionStatus.FAILED,
          extractedAt: new Date(),
          extractionError: error instanceof Error ? error.message : String(error),
        },
      });
      failed += 1;
    }
  }

  return {
    matched,
    attempted: articles.length,
    succeeded,
    failed,
  };
}
