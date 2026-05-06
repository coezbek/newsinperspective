/**
 * Compute corpus-wide stop words from historical article text and emit them
 * to a JSON file the perspective sidecar reads at startup.
 *
 * "Stop words" here means terms whose document-frequency exceeds a threshold
 * (default 20% of articles) — i.e., words common enough across the corpus that
 * they carry no per-source distinctive signal. This replaces the hand-curated
 * NEWS_STOPWORDS list with something derived from the actual data.
 *
 * CLI:
 *   tsx build-corpus-stopwords.ts                 # all articles, default thresholds
 *   tsx build-corpus-stopwords.ts --df=0.15       # term must appear in ≥15% of articles
 *   tsx build-corpus-stopwords.ts --top=2000      # cap output to top 2000 terms
 *   tsx build-corpus-stopwords.ts --out=path.json # override output path
 *   tsx build-corpus-stopwords.ts --min-articles=200  # require this many articles before computing
 */
import "../config/env.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { prisma } from "../lib/prisma.js";

const TOKEN_RE = /[a-zA-Z]{3,}/g;

function parseFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = process.argv.find((value) => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  const matches = text.match(TOKEN_RE);
  if (!matches) return tokens;
  for (const m of matches) tokens.add(m.toLowerCase());
  return tokens;
}

async function main(): Promise<void> {
  const dfThreshold = Number.parseFloat(parseFlag("df") ?? "0.20");
  const topCap = Number.parseInt(parseFlag("top") ?? "5000", 10);
  const minArticles = Number.parseInt(parseFlag("min-articles") ?? "20", 10);
  const outPath = resolve(parseFlag("out") ?? "apps/perspective/data/corpus-stopwords.json");

  console.log(`Building corpus stop words: df>=${dfThreshold}, top<=${topCap}, out=${outPath}`);

  // Prefer translatedFullText for non-English articles so the corpus is
  // homogeneous English (matches what TF-IDF will see at query time).
  const articles = await prisma.article.findMany({
    select: { fullText: true, translatedFullText: true, language: true },
  });

  const df = new Map<string, number>();
  let totalWithText = 0;
  for (const article of articles) {
    const isEnglish =
      !article.language || article.language.toLowerCase().slice(0, 2) === "en";
    const source = (!isEnglish && article.translatedFullText) || article.fullText || "";
    if (!source.trim()) continue;
    totalWithText += 1;
    for (const token of tokenize(source)) {
      df.set(token, (df.get(token) ?? 0) + 1);
    }
  }

  const total = totalWithText;
  console.log(
    `Corpus: ${articles.length} article rows, ${total} with usable text, ${df.size} unique tokens`,
  );
  if (total < minArticles) {
    console.error(
      `Only ${total} articles with text; need at least ${minArticles}. Aborting (no file written).`,
    );
    process.exitCode = 1;
    return;
  }

  const minDf = Math.ceil(dfThreshold * total);
  const stopWords = Array.from(df.entries())
    .filter(([, count]) => count >= minDf)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topCap)
    .map(([term, count]) => ({ term, df: count, ratio: +(count / total).toFixed(4) }));

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        articleCount: total,
        dfThreshold,
        terms: stopWords.map((s) => s.term),
        // Diagnostic detail kept alongside in case humans want to inspect.
        details: stopWords,
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(
    `Wrote ${stopWords.length} stop-word terms (out of ${df.size} unique tokens) to ${outPath}`,
  );
  console.log("Top 30 by document frequency:");
  for (const s of stopWords.slice(0, 30)) {
    console.log(`  ${s.term.padEnd(20)} df=${s.df}  ratio=${s.ratio}`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
