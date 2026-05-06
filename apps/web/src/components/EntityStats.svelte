<script lang="ts">
  import type { LinkedEntity } from "@news/shared";
  import EntityHoverCard from "./EntityHoverCard.svelte";
  import { portal } from "../lib/portal";

  interface Props {
    entities: LinkedEntity[];
    selectedEntityId: string | null;
    onEntitySelect: (entity: LinkedEntity) => void;
  }

  let { entities = [], selectedEntityId = null, onEntitySelect }: Props = $props();

  let hoveredEntity: LinkedEntity | null = $state(null);
  let hoverX = $state(0);
  let hoverY = $state(0);

  function getEntityTypeLabel(type: string): string {
    const labels: Record<string, string> = {
      PERSON: "Person",
      GPE: "Location",
      ORG: "Organization",
      EVENT: "Event",
    };
    return labels[type] || type;
  }

  function groupEntitiesByType(ents: LinkedEntity[]): Record<string, LinkedEntity[]> {
    const grouped: Record<string, LinkedEntity[]> = {
      PERSON: [],
      GPE: [],
      ORG: [],
      EVENT: [],
    };
    const seen = new Set<string>();
    for (const entity of ents) {
      if (seen.has(entity.id)) continue;
      seen.add(entity.id);
      if (entity.entityType in grouped) {
        grouped[entity.entityType].push(entity);
      }
    }
    for (const type in grouped) {
      grouped[type].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
    }
    return grouped;
  }

  const groupedEntities = $derived(groupEntitiesByType(entities));
  const entityTypes = $derived.by(() =>
    Object.keys(groupedEntities).filter((type) => groupedEntities[type].length > 0),
  );
  const totalEntities = $derived(entities.length);

  function handleEnter(entity: LinkedEntity, ev: MouseEvent): void {
    hoveredEntity = entity;
    const target = ev.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    hoverX = rect.left + rect.width / 2;
    hoverY = rect.bottom + 8;
  }

  function handleLeave(): void {
    hoveredEntity = null;
  }
</script>

<div class="entity-stats-panel">
  <div class="stats-header">
    <h4>Entities</h4>
    <span class="total-badge">{totalEntities}</span>
  </div>

  {#if entityTypes.length === 0}
    <div class="empty-state">
      <p>No entities detected.</p>
    </div>
  {:else}
    <div class="entity-groups">
      {#each entityTypes as entityType}
        <div class="entity-group">
          <span class="group-label entity--{entityType.toLowerCase()}">
            {getEntityTypeLabel(entityType)}
          </span>
          <div class="entity-tag-row">
            {#each groupedEntities[entityType] as entity (entity.id)}
              <button
                class="entity-tag entity--{entityType.toLowerCase()}"
                class:selected={selectedEntityId === entity.id}
                type="button"
                on:click={() => onEntitySelect(entity)}
                on:mouseenter={(ev) => handleEnter(entity, ev)}
                on:mouseleave={handleLeave}
                on:focus={(ev) => handleEnter(entity, ev as unknown as MouseEvent)}
                on:blur={handleLeave}
              >
                {entity.entityText}
              </button>
            {/each}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

{#if hoveredEntity}
  <div
    use:portal
    class="hover-card-anchor"
    style="left: {hoverX}px; top: {hoverY}px;"
  >
    <EntityHoverCard entity={hoveredEntity} />
  </div>
{/if}

<style>
  .entity-stats-panel {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .stats-header {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  h4 {
    margin: 0;
    font-size: 0.95rem;
    color: #142033;
    font-weight: 600;
  }

  .total-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 22px;
    height: 22px;
    padding: 0 7px;
    border-radius: 999px;
    background: rgba(220, 232, 255, 0.7);
    color: #0a3c96;
    font-weight: 600;
    font-size: 0.78rem;
  }

  .empty-state {
    color: #58708f;
    font-size: 0.88rem;
  }

  .empty-state p {
    margin: 0;
  }

  .entity-groups {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .entity-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .group-label {
    font-size: 0.7rem;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: #58708f;
  }

  .entity-tag-row {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
  }

  .entity-tag {
    border: 1px solid transparent;
    padding: 3px 8px;
    border-radius: 999px;
    font-size: 0.82rem;
    font-family: inherit;
    cursor: pointer;
    transition:
      box-shadow 120ms ease,
      transform 120ms ease,
      background-color 120ms ease;
    background: rgba(255, 255, 255, 0.7);
    color: #142033;
    line-height: 1.2;
  }

  .entity-tag:hover {
    box-shadow: 0 2px 8px rgba(20, 43, 77, 0.14);
    transform: translateY(-1px);
  }

  .entity-tag.selected {
    box-shadow: 0 0 0 2px currentColor;
  }

  .entity-tag.entity--person {
    background: #dbeafe;
    color: #0c4a6e;
  }
  .entity-tag.entity--gpe {
    background: #dcfce7;
    color: #14532d;
  }
  .entity-tag.entity--org {
    background: #fce7f3;
    color: #500724;
  }
  .entity-tag.entity--event {
    background: #fed7aa;
    color: #5a2e0f;
  }

  .hover-card-anchor {
    position: fixed;
    transform: translateX(-50%);
    z-index: 950;
    pointer-events: none;
  }

  @media (max-width: 768px) {
    .entity-tag {
      font-size: 0.78rem;
    }
  }
</style>
