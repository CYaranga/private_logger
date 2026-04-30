import type { Filters } from './types';

const STORAGE_KEY = 'savedViews:v1';

export interface SavedView {
  id: string;
  name: string;
  filters: Filters;
  createdAt: string;
}

export function loadViews(): SavedView[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveViews(views: SavedView[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(views));
  } catch {
    // ignore quota/private-mode errors — UI can prompt user instead
  }
}

export function createView(name: string, filters: Filters): SavedView {
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: name.trim(),
    filters: { ...filters },
    createdAt: new Date().toISOString(),
  };
}

/** Counts the active (non-empty) keys on a Filters object. */
export function countActive(filters: Filters): number {
  return Object.values(filters).filter((v) => v !== '' && v !== undefined && v !== null).length;
}
