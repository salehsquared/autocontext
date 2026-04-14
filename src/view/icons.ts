/** Inline SVG strings for freshness chips. Size budget: < 2 KB combined. */

export const ICONS = {
  fresh:
    '<svg class="icon" viewBox="0 0 16 16" role="img" aria-label="fresh"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M4 8 L7 11 L12 5" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  cosmetic_stale:
    '<svg class="icon" viewBox="0 0 16 16" role="img" aria-label="cosmetic stale"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg>',
  semantic_stale:
    '<svg class="icon" viewBox="0 0 16 16" role="img" aria-label="semantic stale"><path d="M8 1 L15 14 L1 14 Z" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="8" y1="6" x2="8" y2="10" stroke="currentColor" stroke-width="2"/><circle cx="8" cy="12" r="1" fill="currentColor"/></svg>',
  stale:
    '<svg class="icon" viewBox="0 0 16 16" role="img" aria-label="stale"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="5" y1="5" x2="11" y2="11" stroke="currentColor" stroke-width="2"/></svg>',
  missing:
    '<svg class="icon" viewBox="0 0 16 16" role="img" aria-label="missing"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2 2"/></svg>',
} as const;
