<script lang="ts">
  import type { LinkedEntity } from "@news/shared";
  import { portal } from "../lib/portal";

  interface Props {
    entity: LinkedEntity | null;
    onClose: () => void;
  }

  let { entity = null, onClose }: Props = $props();

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
    const tokens = [term, ...term.split(/\s+/).filter((t) => t.length >= 3)];
    const unique = [...new Set(tokens)].sort((a, b) => b.length - a.length);
    const pattern = new RegExp(`(${unique.map(escapeRegex).join("|")})`, "gi");
    return escaped.replace(pattern, "<strong>$1</strong>");
  }

  /**
   * The stored entity context is a fixed-window slice (±50 chars), so it
   * usually starts and ends mid-word. Snap to word boundaries and add
   * ellipsis markers so the snippet reads cleanly.
   */
  function tidyContext(raw: string): string {
    let s = raw.trim();
    const startedMidWord = /^[a-zà-öø-ÿ]/i.test(s) && !/^[A-ZÀ-ÖØ-Þ]/.test(s);
    const endedMidWord = !/[.!?…"”')\]]$/.test(s);
    if (startedMidWord) {
      const cut = s.search(/\s/);
      if (cut > 0 && cut < s.length - 1) s = s.slice(cut + 1);
      s = `… ${s}`;
    }
    if (endedMidWord) {
      const cut = s.lastIndexOf(" ");
      if (cut > s.length / 2) s = s.slice(0, cut);
      s = `${s} …`;
    }
    return s;
  }

  function getEntityTypeLabel(type: string): string {
    const labels: Record<string, string> = {
      PERSON: "Person",
      GPE: "Location",
      ORG: "Organization",
      EVENT: "Event",
    };
    return labels[type] || type;
  }

  function getEntityTypeColor(type: string): string {
    const colors: Record<string, string> = {
      PERSON: "#0c4a6e",
      GPE: "#14532d",
      ORG: "#500724",
      EVENT: "#5a2e0f",
    };
    return colors[type] || "#142033";
  }

  function handleBackdropClick(e: MouseEvent): void {
    if (e.target === e.currentTarget) {
      onClose();
    }
  }

  function handleKeyDown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      onClose();
    }
  }
</script>

<svelte:window on:keydown={handleKeyDown} />

{#if entity}
  <div use:portal class="popover-backdrop" on:click={handleBackdropClick} role="presentation">
    <div class="popover" role="dialog" aria-modal="true">
      <div class="popover-header">
        <div class="popover-title-row">
          <h3>{entity.entityText}</h3>
          <button
            class="close-button"
            type="button"
            aria-label="Close"
            on:click={onClose}
          >
            ✕
          </button>
        </div>
        <span
          class="entity-type-badge"
          style="background-color: {getEntityTypeColor(entity.entityType)};"
        >
          {getEntityTypeLabel(entity.entityType)}
        </span>
      </div>

      <div class="popover-body">
        {#if entity.imageUrl}
          <div class="image-section">
            <img class="entity-image" src={entity.imageUrl} alt={entity.entityText} loading="lazy" />
          </div>
        {/if}

        {#if entity.summary}
          <div class="summary-section">
            <p class="summary-text">{@html highlightTerm(entity.summary, entity.entityText)}</p>
          </div>
        {/if}

        {#if entity.wikipediaUrl}
          <div class="links-section">
            <a
              href={entity.wikipediaUrl}
              target="_blank"
              rel="noreferrer"
              class="wikipedia-link"
            >
              View on Wikipedia
              <span aria-hidden="true">→</span>
            </a>
          </div>
        {/if}

        <div class="metadata-section">
          {#if entity.confidence}
            <div class="metadata-item">
              <span class="metadata-label">Recognition Confidence</span>
              <span class="metadata-value">{(entity.confidence * 100).toFixed(0)}%</span>
            </div>
          {/if}

          {#if entity.context}
            <div class="metadata-item">
              <span class="metadata-label">Context in this article</span>
              <p class="metadata-context">{@html highlightTerm(tidyContext(entity.context), entity.entityText)}</p>
            </div>
          {/if}
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .popover-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(20, 32, 51, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 16px;
    backdrop-filter: blur(4px);
  }

  .popover {
    background: linear-gradient(135deg, rgba(255, 255, 255, 0.98), rgba(255, 255, 255, 0.94));
    border: 1px solid rgba(37, 87, 167, 0.24);
    border-radius: 20px;
    box-shadow: 0 20px 50px rgba(22, 43, 77, 0.24);
    max-width: 480px;
    width: 100%;
    max-height: 90vh;
    overflow-y: auto;
    animation: slideUp 200ms cubic-bezier(0.32, 0.72, 0.36, 1);
  }

  .summary-text :global(strong) {
    color: #142033;
    font-weight: 600;
  }

  @keyframes slideUp {
    from {
      opacity: 0;
      transform: translateY(16px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .popover-header {
    padding: 20px;
    border-bottom: 1px solid rgba(37, 87, 167, 0.12);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .popover-title-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  h3 {
    margin: 0;
    font-size: 1.18rem;
    color: #142033;
    line-height: 1.3;
    word-break: break-word;
  }

  .close-button {
    flex-shrink: 0;
    width: 32px;
    height: 32px;
    border: 1px solid rgba(28, 46, 73, 0.12);
    background: rgba(255, 255, 255, 0.76);
    border-radius: 8px;
    color: #142033;
    font-size: 1.2rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition:
      background-color 140ms ease,
      border-color 140ms ease;
    padding: 0;
  }

  .close-button:hover {
    background: rgba(255, 255, 255, 0.9);
    border-color: rgba(37, 87, 167, 0.24);
  }

  .entity-type-badge {
    display: inline-block;
    padding: 6px 10px;
    border-radius: 6px;
    color: white;
    font-size: 0.78rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    width: fit-content;
  }

  .popover-body {
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .image-section {
    display: flex;
    justify-content: center;
    background: #f1f4f9;
    border-radius: 12px;
    overflow: hidden;
    max-height: 240px;
  }

  .entity-image {
    max-width: 100%;
    max-height: 240px;
    object-fit: contain;
  }

  .summary-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .summary-text {
    margin: 0;
    color: #34445c;
    font-size: 0.95rem;
    line-height: 1.5;
  }

  .links-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .wikipedia-link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 10px 12px;
    border-radius: 8px;
    background: linear-gradient(135deg, #dce8ff, rgba(207, 226, 255, 0.9));
    color: #0a3c96;
    font-weight: 600;
    font-size: 0.9rem;
    text-decoration: none;
    cursor: pointer;
    transition:
      background-color 140ms ease,
      box-shadow 140ms ease;
    border: 1px solid rgba(37, 87, 167, 0.24);
  }

  .wikipedia-link:hover {
    background: linear-gradient(135deg, #c7dffe, rgba(185, 219, 255, 0.9));
    box-shadow: 0 6px 14px rgba(20, 55, 111, 0.12);
  }

  .metadata-section {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding-top: 12px;
    border-top: 1px solid rgba(28, 46, 73, 0.08);
  }

  .metadata-item {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .metadata-label {
    color: #58708f;
    font-size: 0.78rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-weight: 600;
  }

  .metadata-value {
    color: #142033;
    font-size: 0.95rem;
    font-weight: 500;
  }

  .metadata-context {
    margin: 0;
    color: #34445c;
    font-size: 0.9rem;
    line-height: 1.45;
    font-style: italic;
  }

  .metadata-context :global(strong) {
    color: #142033;
    font-weight: 600;
    font-style: normal;
  }

  /* Mobile responsiveness */
  @media (max-width: 768px) {
    .popover-backdrop {
      align-items: stretch;
      padding: 0;
    }

    .popover {
      width: 100%;
      max-width: none;
      border-radius: 20px 20px 0 0;
      max-height: 60vh;
    }

    h3 {
      font-size: 1.1rem;
    }
  }
</style>
