<script lang="ts">
  import type { LinkedEntity } from "@news/shared";

  interface Props {
    entity: LinkedEntity;
  }

  let { entity }: Props = $props();

  function getEntityTypeLabel(type: string): string {
    const labels: Record<string, string> = {
      PERSON: "Person",
      GPE: "Location",
      ORG: "Organization",
      EVENT: "Event",
    };
    return labels[type] || type;
  }

  function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    } as Record<string, string>)[ch]!);
  }

  function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function highlightTerm(text: string, term: string): string {
    const escaped = escapeHtml(text);
    if (!term.trim()) return escaped;
    // Highlight whole term and any single-word fragment of it (e.g. surname).
    const tokens = [term, ...term.split(/\s+/).filter((t) => t.length >= 3)];
    const unique = [...new Set(tokens)].sort((a, b) => b.length - a.length);
    const pattern = new RegExp(`(${unique.map(escapeRegex).join("|")})`, "gi");
    return escaped.replace(pattern, "<strong>$1</strong>");
  }
</script>

<div class="hover-card" role="tooltip">
  {#if entity.imageUrl}
    <img class="hover-card-image" src={entity.imageUrl} alt="" loading="lazy" />
  {/if}
  <div class="hover-card-body">
    <div class="hover-card-title-row">
      <strong class="hover-card-title">{entity.entityText}</strong>
      <span class="hover-card-type">{getEntityTypeLabel(entity.entityType)}</span>
    </div>
    {#if entity.summary}
      <p class="hover-card-summary">{@html highlightTerm(entity.summary, entity.entityText)}</p>
    {/if}
    <p class="hover-card-hint">Click for details</p>
  </div>
</div>

<style>
  .hover-card {
    display: flex;
    gap: 14px;
    width: 460px;
    max-width: calc(100vw - 24px);
    padding: 14px;
    background: #ffffff;
    border: 1px solid rgba(28, 46, 73, 0.18);
    border-radius: 12px;
    box-shadow: 0 18px 44px rgba(20, 43, 77, 0.22);
    color: #142033;
    font-size: 0.92rem;
    line-height: 1.45;
    pointer-events: none;
  }

  .hover-card-image {
    flex-shrink: 0;
    width: 110px;
    height: 110px;
    object-fit: cover;
    border-radius: 8px;
    background: #f1f4f9;
  }

  .hover-card-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .hover-card-title-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 6px;
  }

  .hover-card-title {
    font-size: 0.92rem;
    color: #142033;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hover-card-type {
    flex-shrink: 0;
    font-size: 0.7rem;
    color: #58708f;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .hover-card-summary {
    margin: 0;
    color: #34445c;
    /* No clamping — let the card grow vertically to fit the summary so words
       don't get cut off mid-glyph. */
  }

  .hover-card-summary :global(strong) {
    color: #142033;
    font-weight: 600;
  }

  .hover-card-hint {
    margin: 2px 0 0 0;
    color: #8095b0;
    font-size: 0.72rem;
  }
</style>
