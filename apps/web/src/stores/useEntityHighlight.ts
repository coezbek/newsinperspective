import { writable, derived, get } from "svelte/store";
import type { LinkedEntity } from "@news/shared";

interface EntityHighlightState {
  selectedEntity: LinkedEntity | null;
  entities: LinkedEntity[];
  loading: boolean;
  error: string | null;
  cache: Map<string, LinkedEntity[]>;
}

/**
 * Create a custom store for managing entity highlighting and popover state
 * Includes caching and API integration
 */
function createEntityHighlightStore() {
  const initialState: EntityHighlightState = {
    selectedEntity: null,
    entities: [],
    loading: false,
    error: null,
    cache: new Map(),
  };

  const state = writable<EntityHighlightState>(initialState);

  /**
   * Fetch entities for an article from the API
   * Uses cache to avoid duplicate requests
   */
  async function fetchArticleEntities(
    articleId: string,
    options?: {
      minConfidence?: number;
      type?: string;
      limit?: number;
    }
  ): Promise<LinkedEntity[]> {
    const cacheKey = `${articleId}:${JSON.stringify(options || {})}`;

    // Check cache first
    const currentState = get(state);
    if (currentState.cache.has(cacheKey)) {
      const cached = currentState.cache.get(cacheKey)!;
      state.update((s) => ({ ...s, entities: cached, error: null }));
      return cached;
    }

    state.update((s) => ({ ...s, loading: true, error: null }));

    try {
      const params = new URLSearchParams();
      if (options?.minConfidence !== undefined) {
        params.append("minConfidence", String(options.minConfidence));
      }
      if (options?.type) {
        params.append("type", options.type);
      }
      if (options?.limit !== undefined) {
        params.append("limit", String(options.limit));
      }

      const response = await fetch(
        `/api/articles/${encodeURIComponent(articleId)}/entities?${params.toString()}`
      );

      if (!response.ok) {
        throw new Error(
          `Failed to fetch entities: ${response.status} ${response.statusText}`
        );
      }

      const data = await response.json();
      const entities: LinkedEntity[] = data.entities || [];

      // Cache the result
      state.update((s) => {
        const newCache = new Map(s.cache);
        newCache.set(cacheKey, entities);
        return {
          ...s,
          entities,
          cache: newCache,
          loading: false,
          error: null,
        };
      });

      return entities;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error occurred";
      state.update((s) => ({
        ...s,
        loading: false,
        error: message,
      }));
      throw error;
    }
  }

  /**
   * Fetch detailed information about a specific entity
   */
  async function fetchEntityDetail(entityId: string): Promise<any> {
    try {
      const response = await fetch(`/api/entities/${encodeURIComponent(entityId)}`);

      if (!response.ok) {
        throw new Error(
          `Failed to fetch entity detail: ${response.status} ${response.statusText}`
        );
      }

      return await response.json();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error occurred";
      state.update((s) => ({
        ...s,
        error: message,
      }));
      throw error;
    }
  }

  /**
   * Select an entity to display in the popover
   */
  function selectEntity(entity: LinkedEntity): void {
    state.update((s) => ({
      ...s,
      selectedEntity: entity,
    }));
  }

  /**
   * Clear the selected entity and close the popover
   */
  function clearSelection(): void {
    state.update((s) => ({
      ...s,
      selectedEntity: null,
    }));
  }

  /**
   * Clear all entities and reset the store
   */
  function clear(): void {
    state.set({ ...initialState, cache: new Map() });
  }

  /**
   * Derived store for getting the selected entity
   */
  const selectedEntity = derived(state, ($state) => $state.selectedEntity);

  /**
   * Derived store for getting all entities
   */
  const entities = derived(state, ($state) => $state.entities);

  /**
   * Derived store for loading state
   */
  const loading = derived(state, ($state) => $state.loading);

  /**
   * Derived store for error state
   */
  const error = derived(state, ($state) => $state.error);

  /**
   * Derived store for entity count by type
   */
  const entityCountByType = derived(entities, ($entities) => {
    const counts = {
      PERSON: 0,
      GPE: 0,
      ORG: 0,
      EVENT: 0,
    };

    for (const entity of $entities) {
      if (entity.entityType in counts) {
        counts[entity.entityType as keyof typeof counts]++;
      }
    }

    return counts;
  });

  return {
    // Writable state
    state,

    // Methods
    fetchArticleEntities,
    fetchEntityDetail,
    selectEntity,
    clearSelection,
    clear,

    // Derived stores
    selectedEntity,
    entities,
    loading,
    error,
    entityCountByType,
  };
}

// Export a singleton instance
export const entityHighlight = createEntityHighlightStore();

// Also export the factory function for testing
export { createEntityHighlightStore };
