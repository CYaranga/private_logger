# Analytics Dashboard - Private Logger

**Date**: 2026-02-28
**Library**: Recharts (~40KB gzipped)
**Location**: New "Analytics" tab (3rd tab alongside Logs and Archives)

## Decisions

- **Recharts** over Chart.js: React-native, declarative API, lighter bundle
- **Separate tab** over replacing stats cards: dedicated space, clean separation
- **Backend timeseries endpoint**: aggregate in SQL for performance, not client-side
- **Time range selector**: 1h, 6h, 24h, 7d buckets

## Dashboard Layout (top to bottom)

### 1. Time Range Selector
- Segmented control: 1h | 6h | 24h | 7d
- Applied to all charts on the tab

### 2. Log Volume Over Time (full-width)
- Stacked area chart by log level
- Colors: debug=#6b7280, info=#3b82f6, warn=#f59e0b, error=#ef4444
- X-axis: time buckets (minutes for 1h, hours for 6h/24h, days for 7d)
- Y-axis: log count
- Hover tooltips with exact counts per level

### 3. Error Insights (2-column row)
- **Left**: Line chart - error rate % over time (errors / total * 100)
- **Right**: Horizontal bar chart - top 10 error categories by count

### 4. API Performance (2-column row)
- **Left**: Multi-line chart - p50/p95/p99 response times (ms) over time
- **Right**: Donut chart - status code distribution (2xx/3xx/4xx/5xx)

## Backend Changes

### New Endpoint: `GET /stats/timeseries`

Query parameters:
- `range`: '1h' | '6h' | '24h' | '7d' (default: '24h')

Response shape:
```json
{
  "buckets": [
    {
      "timestamp": "2026-02-28T14:00:00Z",
      "total": 150,
      "by_level": { "debug": 20, "info": 100, "warn": 20, "error": 10 },
      "error_rate": 6.67,
      "avg_duration_ms": 245,
      "p50_duration_ms": 180,
      "p95_duration_ms": 890,
      "p99_duration_ms": 1200
    }
  ],
  "top_error_categories": [
    { "category": "AUTH", "count": 45 },
    { "category": "API", "count": 32 }
  ],
  "status_code_distribution": {
    "2xx": 1200,
    "3xx": 50,
    "4xx": 180,
    "5xx": 30
  }
}
```

SQL strategy:
- Use `strftime` to bucket timestamps by minute/hour/day based on range
- Aggregate counts with `GROUP BY` on the bucket
- Calculate percentiles using `ORDER BY duration_ms` with `LIMIT/OFFSET` approach (D1 lacks window functions)
- Single query with subqueries for efficiency

## Mobile Layout

- Charts stack vertically, full-width
- Time range selector stays at top
- 2-column rows become single-column
- Touch-friendly tooltips

## Implementation Scope

- `backend/src/index.ts`: Add `/stats/timeseries` endpoint with SQL aggregation
- `frontend/src/api.ts`: Add `fetchTimeseries()` API function
- `frontend/src/types.ts`: Add `TimeseriesBucket`, `TimeseriesResponse` types
- `frontend/src/App.tsx`: Add Analytics tab, chart components
- `frontend/src/index.css`: Analytics dashboard styles
- `package.json`: Add `recharts` dependency
