# Mobile Responsive Design - Private Logger

**Date**: 2026-02-27
**Breakpoint**: <= 768px
**Approach**: CSS media queries + `useIsMobile()` hook for conditional rendering

## Decisions

- **Table -> Cards**: Log table replaced with card-based list view
- **Filters -> Bottom sheet**: 8 filter fields in a slide-up panel from bottom
- **Stats -> Collapsible**: Compact row with 3 key metrics, expandable to full grid
- **Pagination -> Simplified**: Prev/Next with page indicator
- **Archives -> Cards**: Archive table also converted to cards

## Layout (top to bottom)

1. **Header**: Compact title + refresh/auto-refresh controls
2. **Tab bar**: Logs | Archives
3. **Stats row**: Collapsed (Recent, Errors, 24h) + storage bar, expandable
4. **Search bar**: Always visible, full-width
5. **Filter button**: Badge with active filter count, opens bottom sheet
6. **Log cards**: Vertical list, tap to expand
7. **Pagination**: Prev/Page/Next bar

## Log Card Structure

```
+--[level-color-border]-----+
| [ERROR] [iOS] [prod]      |
| POST /api/users [201]     |
| "Failed to fetch user..." |
| 2m ago       user: chris  |
+----------------------------+
```

Expanded adds: full message, metadata JSON, request/response data.

## Bottom Sheet Filters

- Overlay with dark backdrop
- Slide up from bottom with CSS transform
- All 8 filters in vertical layout
- Clear All + Apply buttons at bottom

## Implementation Scope

- `frontend/src/App.tsx`: Add useIsMobile hook, MobileLogCard component, MobileFilterSheet, collapsible stats
- `frontend/src/index.css`: Mobile-specific styles at 768px breakpoint
