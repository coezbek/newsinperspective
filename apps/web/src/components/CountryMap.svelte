<script lang="ts">
  import { countryFlagUrl, countryIso2, countryM49 } from "../lib/country-flag.js";

  interface SourceLite {
    domain: string;
    country: string | null | undefined;
  }

  interface Props {
    articles: SourceLite[];
    width?: number;
    height?: number;
  }

  let { articles, width = 640, height = 282 }: Props = $props();

  // Robinson projection. Compresses the poles (so Greenland and Antarctica
  // don't dominate) and curves meridians so the Pacific reads narrower than
  // it does on an equirectangular grid. Table-driven, sampled every 5° and
  // linearly interpolated — accurate enough at small overview-map sizes.
  // Reference: Robinson (1974), via the standard Snyder (1987) lookup table.
  // Each row: [aa = x-scale at this latitude, bb = y-scale at this latitude].
  const ROBINSON_TABLE: Array<[number, number]> = [
    [1.0000, 0.0000], [0.9986, 0.0620], [0.9954, 0.1240], [0.9900, 0.1860],
    [0.9822, 0.2480], [0.9730, 0.3100], [0.9600, 0.3720], [0.9427, 0.4340],
    [0.9216, 0.4958], [0.8962, 0.5571], [0.8679, 0.6176], [0.8350, 0.6769],
    [0.7986, 0.7346], [0.7597, 0.7903], [0.7186, 0.8435], [0.6732, 0.8936],
    [0.6213, 0.9394], [0.5722, 0.9761], [0.5322, 1.0000],
  ];
  const ROBINSON_X = 0.8487; // unit-sphere x scale at the equator
  const ROBINSON_Y = 1.3523; // unit-sphere y at the pole
  const HALF_W = Math.PI * ROBINSON_X; // ≈ 2.6667
  // Vertical canvas covers +90° at the top down to -60° at the bottom — we
  // skip Antarctica entirely. bb(60°) = 0.7346 in the Robinson table.
  const Y_TOP = ROBINSON_Y;                // +90° → 1.3523
  const Y_BOTTOM = -ROBINSON_Y * 0.7346;   // -60° → -0.9933
  // Resulting canvas aspect ratio (W:H) ≈ 2.273:1 — see default height=282 above.

  function project(lon: number, lat: number, w: number, h: number): [number, number] {
    const absLat = Math.abs(lat);
    const idx = absLat / 5;
    const lo = Math.min(Math.floor(idx), ROBINSON_TABLE.length - 1);
    const hi = Math.min(lo + 1, ROBINSON_TABLE.length - 1);
    const t = idx - lo;
    const aa = ROBINSON_TABLE[lo][0] * (1 - t) + ROBINSON_TABLE[hi][0] * t;
    const bb = ROBINSON_TABLE[lo][1] * (1 - t) + ROBINSON_TABLE[hi][1] * t;
    const x = ROBINSON_X * (lon * Math.PI / 180) * aa;
    const y = ROBINSON_Y * (lat < 0 ? -bb : bb);
    return [
      ((x + HALF_W) / (2 * HALF_W)) * w,
      ((Y_TOP - y) / (Y_TOP - Y_BOTTOM)) * h,
    ];
  }

  type Topology = {
    transform: { scale: [number, number]; translate: [number, number] };
    arcs: Array<Array<[number, number]>>;
    objects: {
      countries: {
        geometries: Array<{
          type: "Polygon" | "MultiPolygon";
          arcs: number[][] | number[][][];
          id?: string;
          properties?: { name?: string };
        }>;
      };
    };
  };

  // Module-level promise so the 100KB topology only ever loads once per page,
  // no matter how many <CountryMap/> instances mount.
  let topoPromise: Promise<Topology> | null = null;
  function loadTopology(): Promise<Topology> {
    if (!topoPromise) {
      topoPromise = fetch("https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json")
        .then((r) => {
          if (!r.ok) throw new Error(`world-atlas fetch failed: ${r.status}`);
          return r.json();
        });
    }
    return topoPromise;
  }

  // Decode a topojson arc index. Negative ~i means traverse arc -i-1 in reverse.
  function decodeArc(
    topo: Topology,
    arcIndex: number,
  ): Array<[number, number]> {
    const reverse = arcIndex < 0;
    const raw = topo.arcs[reverse ? ~arcIndex : arcIndex];
    const [sx, sy] = topo.transform.scale;
    const [tx, ty] = topo.transform.translate;
    let x = 0;
    let y = 0;
    const out: Array<[number, number]> = [];
    for (const [dx, dy] of raw) {
      x += dx;
      y += dy;
      out.push([x * sx + tx, y * sy + ty]);
    }
    return reverse ? out.reverse() : out;
  }

  function ringToPath(topo: Topology, ring: number[], w: number, h: number): string {
    // Flatten the ring into one stream of [lon, lat] points first, then walk
    // the stream so we can detect antimeridian crossings (|Δlon| > 180°)
    // regardless of which arc the seam lands in. Russia, Fiji and the
    // Aleutian tip of Alaska all need this — without it, the line from a
    // vertex at +178° to one at −179° wraps the wrong way across the map.
    const pts: Array<[number, number]> = [];
    for (let i = 0; i < ring.length; i++) {
      const arc = decodeArc(topo, ring[i]);
      const start = i === 0 ? 0 : 1; // dedupe the seam between consecutive arcs
      for (let j = start; j < arc.length; j++) pts.push(arc[j]);
    }
    if (pts.length === 0) return "";

    let d = "";
    let prevLon = pts[0][0];
    let openSubpath = false;
    for (let i = 0; i < pts.length; i++) {
      const [lon, lat] = pts[i];
      const [px, py] = project(lon, lat, w, h);
      const cmd =
        !openSubpath || Math.abs(lon - prevLon) > 180 ? "M" : "L";
      d += `${cmd}${px.toFixed(1)} ${py.toFixed(1)}`;
      openSubpath = true;
      prevLon = lon;
    }
    return d + "Z";
  }

  function geometryToPath(
    topo: Topology,
    geom: Topology["objects"]["countries"]["geometries"][number],
    w: number,
    h: number,
  ): string {
    if (geom.type === "Polygon") {
      return (geom.arcs as number[][]).map((ring) => ringToPath(topo, ring, w, h)).join("");
    }
    return (geom.arcs as number[][][])
      .flatMap((poly) => poly.map((ring) => ringToPath(topo, ring, w, h)))
      .join("");
  }

  type CountryEntry = {
    name: string;
    iso2: string | null;
    count: number;
    domains: string[];
  };

  // Aggregate by canonicalised country name. Skip the "Global" sentinel
  // assigned to wire services / aggregators — they don't belong on a map.
  const byCountry = $derived.by((): Map<string, CountryEntry> => {
    const map = new Map<string, CountryEntry>();
    for (const a of articles) {
      const name = (a.country ?? "").trim();
      if (!name || name.toLowerCase() === "global") continue;
      const key = name.toLowerCase();
      const entry = map.get(key) ?? { name, iso2: countryIso2(name), count: 0, domains: [] };
      entry.count += 1;
      if (a.domain && !entry.domains.includes(a.domain)) entry.domains.push(a.domain);
      map.set(key, entry);
    }
    return map;
  });

  // Index counts by M49 numeric so we can match topojson features (whose
  // `id` is the numeric ISO-3166 code) without a name-string roundtrip.
  const countByM49 = $derived.by((): Map<string, CountryEntry> => {
    const out = new Map<string, CountryEntry>();
    for (const entry of byCountry.values()) {
      const m49 = countryM49(entry.name);
      if (m49) out.set(m49, entry);
    }
    return out;
  });

  const totalLocated = $derived(
    [...byCountry.values()].reduce((sum, e) => sum + e.count, 0),
  );
  const sortedEntries = $derived(
    [...byCountry.values()].sort((a, b) => b.count - a.count),
  );

  let topo = $state<Topology | null>(null);
  let loadError = $state<string | null>(null);

  $effect(() => {
    void loadTopology()
      .then((t) => {
        topo = t;
      })
      .catch((err) => {
        loadError = err instanceof Error ? err.message : "Failed to load map";
      });
  });

  // Pre-build the SVG path for every country once the topology is ready.
  const features = $derived.by(() => {
    const t = topo;
    if (!t) return [] as Array<{ id: string; name: string; d: string }>;
    return t.objects.countries.geometries
      // Drop Antarctica (M49 010) — it dominates the bottom of the map and
      // never has data anyway.
      .filter((g) => g.id !== "010")
      .map((g) => ({
        id: g.id ?? "",
        name: g.properties?.name ?? "",
        d: geometryToPath(t, g, width, height),
      }));
  });

  // Color ramp: inactive land is a clearly darker gray-blue than the ocean
  // background, and the highlight ramp starts at a saturated mid-blue (not a
  // near-white) so a single article still reads against the inactive land.
  // Capped at 5 articles so one dominant country doesn't flatten all the
  // smaller highlights into a barely-distinguishable mid-tone.
  function colorFor(count: number): string {
    if (count <= 0) return "#b9c4d3";
    const t = Math.min(1, count / 5);
    // 1 article → #6ea8e0  ·  5+ articles → #0a3a7a
    const r = Math.round(110 + (10 - 110) * t);
    const g = Math.round(168 + (58 - 168) * t);
    const b = Math.round(224 + (122 - 224) * t);
    return `rgb(${r}, ${g}, ${b})`;
  }

  let hovered = $state<CountryEntry | null>(null);
  let hoverPos = $state<{ x: number; y: number } | null>(null);
</script>

<div class="map-wrap">
  <header class="map-head">
    <h5>Where the coverage comes from</h5>
    <p class="map-sub">
      {#if totalLocated > 0}
        {totalLocated} article{totalLocated === 1 ? "" : "s"} from {byCountry.size} countr{byCountry.size === 1 ? "y" : "ies"}
      {:else}
        No country data available for this story.
      {/if}
    </p>
  </header>

  {#if loadError}
    <p class="map-error">Couldn't load map: {loadError}</p>
  {:else}
    <div class="map-canvas" style="aspect-ratio: {width} / {height};">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="World map of source countries">
        {#if topo}
          {#each features as f, i (i)}
            {@const entry = countByM49.get(f.id) ?? null}
            <path
              role={entry ? "button" : "presentation"}
              aria-label={entry ? `${entry.name}: ${entry.count} articles` : undefined}
              d={f.d}
              fill={colorFor(entry?.count ?? 0)}
              stroke="#ffffff"
              stroke-width="0.5"
              class:has-data={entry !== null}
              onmousemove={(e) => {
                if (!entry) { hovered = null; hoverPos = null; return; }
                hovered = entry;
                const rect = (e.currentTarget as SVGPathElement).ownerSVGElement!.getBoundingClientRect();
                hoverPos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
              }}
              onmouseleave={() => { hovered = null; hoverPos = null; }}
            ></path>
          {/each}
        {/if}
      </svg>
      {#if hovered && hoverPos}
        <div class="map-tooltip" style="left: {hoverPos.x}px; top: {hoverPos.y}px;">
          {#if countryFlagUrl(hovered.name)}
            <img class="tt-flag" src={countryFlagUrl(hovered.name, 40)} alt="" loading="lazy" />
          {/if}
          <span class="tt-name">{hovered.name}</span>
          <span class="tt-count">{hovered.count} article{hovered.count === 1 ? "" : "s"}</span>
        </div>
      {/if}
    </div>

    {#if sortedEntries.length > 0}
      <ul class="map-legend">
        {#each sortedEntries as entry (entry.name)}
          <li>
            {#if countryFlagUrl(entry.name)}
              <img class="legend-flag" src={countryFlagUrl(entry.name, 40)} alt="" loading="lazy" />
            {/if}
            <span class="legend-name">{entry.name}</span>
            <span class="legend-count">{entry.count}</span>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>

<style>
  .map-wrap {
    margin: 0.75rem 0 1rem;
    padding: 0.75rem 0.9rem 0.9rem;
    border: 1px solid #e7eaef;
    border-radius: 8px;
    background: #fbfcfd;
  }
  .map-head { margin-bottom: 0.4rem; }
  .map-head h5 { margin: 0; font-size: 0.85rem; letter-spacing: 0.04em; text-transform: uppercase; color: #4a5d75; }
  .map-sub { margin: 0.15rem 0 0; font-size: 0.8rem; color: #6b7a8c; }
  .map-canvas { position: relative; width: 100%; }
  .map-canvas svg { width: 100%; height: auto; display: block; background: #eaf2fb; border-radius: 4px; }
  .map-canvas path { transition: fill 120ms; stroke: #ffffff; stroke-width: 0.4; }
  .map-canvas path.has-data { cursor: pointer; }
  .map-canvas path.has-data:hover { fill: #f4a51a; stroke: #ffffff; }
  .map-tooltip {
    position: absolute;
    transform: translate(-50%, calc(-100% - 0.5rem));
    background: #1f2937;
    color: #fff;
    padding: 0.3rem 0.55rem;
    border-radius: 4px;
    font-size: 0.78rem;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    pointer-events: none;
    white-space: nowrap;
    box-shadow: 0 2px 8px rgba(0,0,0,0.18);
  }
  .tt-flag { width: 16px; height: 12px; object-fit: cover; border-radius: 1px; }
  .tt-count { color: #b6c4d6; font-variant-numeric: tabular-nums; }
  .map-error { font-size: 0.8rem; color: #b94a48; margin: 0.4rem 0 0; }
  .map-legend {
    list-style: none;
    padding: 0;
    margin: 0.6rem 0 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem 0.7rem;
    font-size: 0.78rem;
  }
  .map-legend li { display: inline-flex; align-items: center; gap: 0.3rem; }
  .legend-flag { width: 14px; height: 10px; object-fit: cover; border-radius: 1px; }
  .legend-name { color: #2d3a4d; }
  .legend-count { color: #6b7a8c; font-variant-numeric: tabular-nums; }
</style>
