<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import type { LinkedEntity } from "@news/shared";
  import EntityHoverCard from "./EntityHoverCard.svelte";
  import { portal } from "../lib/portal";

  interface Props {
    text: string;
    entities: LinkedEntity[];
    perspectiveWords?: string[];
  }

  let { text = "", entities = [], perspectiveWords = [] }: Props = $props();

  let hoveredEntity: LinkedEntity | null = $state(null);
  let hoverX = $state(0);
  let hoverY = $state(0);
  let hoverAnchorEl: HTMLDivElement | null = $state(null);
  let hoverTargetRect: DOMRect | null = null;
  const HOVER_MARGIN = 8;
  const HOVER_OFFSET = 6;

  function clampHoverPosition(): void {
    if (!hoverAnchorEl || !hoverTargetRect) return;
    const card = hoverAnchorEl.firstElementChild as HTMLElement | null;
    const cardWidth = card?.offsetWidth ?? hoverAnchorEl.offsetWidth;
    const cardHeight = card?.offsetHeight ?? hoverAnchorEl.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const desiredCenter = hoverTargetRect.left + hoverTargetRect.width / 2;
    const minLeft = HOVER_MARGIN + cardWidth / 2;
    const maxLeft = vw - HOVER_MARGIN - cardWidth / 2;
    hoverX = Math.max(minLeft, Math.min(maxLeft, desiredCenter));

    let top = hoverTargetRect.bottom + HOVER_OFFSET;
    if (top + cardHeight > vh - HOVER_MARGIN) {
      const above = hoverTargetRect.top - HOVER_OFFSET - cardHeight;
      if (above >= HOVER_MARGIN) {
        top = above;
      } else {
        top = Math.max(HOVER_MARGIN, vh - HOVER_MARGIN - cardHeight);
      }
    }
    hoverY = top;
  }

  function handleEntityEnter(entity: LinkedEntity, ev: MouseEvent): void {
    hoveredEntity = entity;
    const target = ev.currentTarget as HTMLElement;
    hoverTargetRect = target.getBoundingClientRect();
    hoverX = hoverTargetRect.left + hoverTargetRect.width / 2;
    hoverY = hoverTargetRect.bottom + HOVER_OFFSET;
  }

  $effect(() => {
    if (!hoveredEntity || !hoverAnchorEl) return;
    clampHoverPosition();
  });

  function handleEntityLeave(): void {
    hoveredEntity = null;
  }

  function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function splitByPerspective(
    content: string,
    words: string[],
  ): Array<{ type: "text" | "perspective"; content: string }> {
    const sorted = [...new Set(words.filter((w) => w.trim().length > 0))].sort(
      (a, b) => b.length - a.length,
    );
    if (sorted.length === 0 || !content) return [{ type: "text", content }];
    const pattern = new RegExp(`\\b(${sorted.map(escapeRegex).join("|")})\\b`, "gi");
    const out: Array<{ type: "text" | "perspective"; content: string }> = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      if (match.index > lastIndex) {
        out.push({ type: "text", content: content.slice(lastIndex, match.index) });
      }
      out.push({ type: "perspective", content: match[0] });
      lastIndex = match.index + match[0].length;
      if (match[0].length === 0) pattern.lastIndex++;
    }
    if (lastIndex < content.length) {
      out.push({ type: "text", content: content.slice(lastIndex) });
    }
    return out;
  }

  const dispatch = createEventDispatcher<{ "entity-click": { entity: LinkedEntity } }>();

  /**
   * Segment the text into parts: marked (entity) and unmarked (regular text).
   *
   * Entity highlighting is purely client-side surface-form matching: the API
   * returns the distinct entities for the article and we find every occurrence
   * of each surface form in the displayed text. Longest-form-first so e.g.
   * "Donald Trump" wins over a bare "Trump" inside the same span.
   */
  function segmentText(
    fullText: string,
    allEntities: LinkedEntity[]
  ): Array<{ type: "text" | "entity"; content: string; entity?: LinkedEntity }> {
    if (!fullText || allEntities.length === 0) {
      return [{ type: "text", content: fullText }];
    }

    // Map surface form (lowercased) → entity, preferring the longer surface
    // form when two entities share a prefix.
    const sorted = [...allEntities]
      .filter((e) => e.entityText && e.entityText.trim().length >= 2)
      .sort((a, b) => b.entityText.length - a.entityText.length);

    const pattern = new RegExp(
      `\\b(?:${sorted.map((e) => escapeRegex(e.entityText)).join("|")})\\b`,
      "g",
    );
    const byLower = new Map<string, LinkedEntity>();
    for (const e of sorted) {
      const key = e.entityText.toLowerCase();
      if (!byLower.has(key)) byLower.set(key, e);
    }

    const segments: Array<{ type: "text" | "entity"; content: string; entity?: LinkedEntity }> = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(fullText)) !== null) {
      const entity = byLower.get(match[0].toLowerCase());
      if (!entity) {
        if (match[0].length === 0) pattern.lastIndex++;
        continue;
      }
      if (match.index > lastIndex) {
        segments.push({ type: "text", content: fullText.slice(lastIndex, match.index) });
      }
      segments.push({ type: "entity", content: match[0], entity });
      lastIndex = match.index + match[0].length;
      if (match[0].length === 0) pattern.lastIndex++;
    }
    if (lastIndex < fullText.length) {
      segments.push({ type: "text", content: fullText.slice(lastIndex) });
    }
    return segments;
  }

  function getCSSClassForEntityType(entityType: string): string {
    return `entity--${entityType.toLowerCase()}`;
  }

  function handleEntityClick(entity: LinkedEntity): void {
    hoveredEntity = null;
    dispatch("entity-click", { entity });
  }

  const segments = $derived(segmentText(text, entities));
  type ExpandedSegment =
    | { type: "text"; content: string }
    | { type: "perspective"; content: string }
    | { type: "entity"; content: string; entity?: LinkedEntity };

  function expandSegments(
    base: Array<{ type: "text" | "entity"; content: string; entity?: LinkedEntity }>,
    words: string[],
  ): ExpandedSegment[] {
    const out: ExpandedSegment[] = [];
    for (const segment of base) {
      if (segment.type !== "text") {
        out.push({ type: "entity", content: segment.content, entity: segment.entity });
        continue;
      }
      for (const part of splitByPerspective(segment.content, words)) {
        out.push(part);
      }
    }
    return out;
  }

  const expandedSegments = $derived(expandSegments(segments, perspectiveWords));
</script>

<div class="entity-highlighted-text">
  {#each expandedSegments as segment}
    {#if segment.type === "text"}
      {segment.content}
    {:else if segment.type === "perspective"}
      <mark class="perspective-word">{segment.content}</mark>
    {:else if segment.entity}
      <mark
        class="entity {getCSSClassForEntityType(segment.entity.entityType)}"
        role="button"
        tabindex="0"
        on:click={() => handleEntityClick(segment.entity!)}
        on:mouseenter={(e) => handleEntityEnter(segment.entity!, e)}
        on:mouseleave={handleEntityLeave}
        on:focus={(e) => handleEntityEnter(segment.entity!, e as unknown as MouseEvent)}
        on:blur={handleEntityLeave}
        on:keydown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleEntityClick(segment.entity!);
          }
        }}
      >
        {segment.content}
      </mark>
    {/if}
  {/each}
</div>

{#if hoveredEntity}
  <div bind:this={hoverAnchorEl} use:portal class="hover-card-anchor" style="left: {hoverX}px; top: {hoverY}px;">
    <EntityHoverCard entity={hoveredEntity} />
  </div>
{/if}

<style>
  .entity-highlighted-text {
    word-break: break-word;
    overflow-wrap: anywhere;
  }

  mark {
    padding: 2px 4px;
    border-radius: 3px;
    cursor: pointer;
    font-weight: 500;
    transition:
      background-color 140ms ease,
      box-shadow 140ms ease;
    background-color: var(--entity-default-bg, #fef08a);
    color: inherit;
    text-decoration: none;
  }

  mark:hover {
    box-shadow: 0 0 0 2px currentColor;
  }

  /* Entity type color coding */
  mark.entity--person {
    --entity-default-bg: #dbeafe;
    color: var(--entity-person-text, #0c4a6e);
  }

  mark.entity--person:hover {
    background-color: #bfdbfe;
  }

  mark.entity--gpe {
    --entity-default-bg: #dcfce7;
    color: var(--entity-gpe-text, #14532d);
  }

  mark.entity--gpe:hover {
    background-color: #bbf7d0;
  }

  mark.entity--org {
    --entity-default-bg: #fce7f3;
    color: var(--entity-org-text, #500724);
  }

  mark.entity--org:hover {
    background-color: #fbcfe8;
  }

  mark.entity--event {
    --entity-default-bg: #fed7aa;
    color: var(--entity-event-text, #5a2e0f);
  }

  mark.entity--event:hover {
    background-color: #fdba74;
  }

  mark.perspective-word {
    background-color: #fff3b0;
    color: #6b4e00;
    cursor: default;
    /* Zero padding/border AND inherited font-weight so toggling on hover does
       not shift surrounding text (bolder glyphs are wider). */
    font-weight: inherit;
    padding: 0;
    border-radius: 2px;
    box-shadow: 0 0 0 2px #fff3b0;
  }

  mark.perspective-word:hover {
    box-shadow: 0 0 0 2px #fff3b0;
  }

  /* Focus state for accessibility */
  mark:focus {
    outline: 2px solid var(--accent, #0f62fe);
    outline-offset: 2px;
  }

  .hover-card-anchor {
    position: fixed;
    transform: translateX(-50%);
    z-index: 950;
    pointer-events: none;
  }
</style>
