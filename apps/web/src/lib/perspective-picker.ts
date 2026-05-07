/**
 * Pick the top-N sources from a cluster's pairwise distance matrix by
 * **extremity** (mean cosine distance to every other source).
 *
 * Why not "by article count"? Both the heatmap and the source-axis used to
 * pick top sources by how many articles they contributed. That biases toward
 * wire services (Reuters, AP, AFP) that show up in *every* cluster — which,
 * by definition of being wire feeds, frame neutrally. The visualization
 * meant to surface "where's the framing divergence?" was therefore
 * highlighting the sources with the *least* divergence to show.
 *
 * The right ranking is mean-distance-to-others, descending. Ties broken by
 * article count (heavier-source variants first) so labels stay deterministic
 * across renders.
 */

export interface PickerInput {
  /**
   * Pairwise cosine-distance matrix from the perspective sidecar:
   * `matrix[a][b]` is the distance between source a and source b.
   * Symmetric (matrix[a][b] === matrix[b][a]); diagonal omitted or 0.
   */
  matrix: Record<string, Record<string, number>>;
  /** Source names known to the matrix (caller filters; we don't re-validate). */
  sources: string[];
  /** Article count per source within the cluster (for tie-break + display). */
  articleCounts: Map<string, number>;
  /** Maximum number of sources to return. */
  n: number;
}

export interface PickedSource {
  sourceName: string;
  meanDistance: number;
  articleCount: number;
}

/**
 * Pure function: deterministic ordering, no I/O, no mutation of inputs.
 */
export function pickTopSourcesByExtremity(input: PickerInput): PickedSource[] {
  const { matrix, sources, articleCounts, n } = input;
  if (n <= 0 || sources.length === 0) return [];

  const ranked: PickedSource[] = sources.map((s) => {
    let sum = 0;
    let count = 0;
    for (const other of sources) {
      if (other === s) continue;
      // Symmetric lookup: try both directions, fall back to 0 (neutral) if absent.
      // 0 means "no information" rather than "identical"; treating it as a low
      // distance is the conservative choice — extreme sources still float to
      // the top because their *real* distances dominate the mean.
      const d = matrix[s]?.[other] ?? matrix[other]?.[s] ?? 0;
      sum += d;
      count += 1;
    }
    return {
      sourceName: s,
      meanDistance: count > 0 ? sum / count : 0,
      articleCount: articleCounts.get(s) ?? 0,
    };
  });

  ranked.sort((a, b) => {
    if (b.meanDistance !== a.meanDistance) return b.meanDistance - a.meanDistance;
    if (b.articleCount !== a.articleCount) return b.articleCount - a.articleCount;
    // Final tiebreak: source name, ascending — stable across renders.
    return a.sourceName.localeCompare(b.sourceName);
  });

  return ranked.slice(0, n);
}
