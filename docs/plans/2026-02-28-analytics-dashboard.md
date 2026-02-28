# Analytics Dashboard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a full analytics dashboard with log volume, error insights, and API performance charts as a new "Analytics" tab.

**Architecture:** New `GET /stats/timeseries` backend endpoint aggregates logs into time buckets using SQL `strftime`. Frontend uses Recharts to render 5 charts in a dedicated Analytics tab. Mobile stacks charts vertically.

**Tech Stack:** Recharts (React charting), D1 SQL aggregation, existing CSS variables design system.

---

### Task 1: Install Recharts dependency

**Files:**
- Modify: `frontend/package.json`

**Step 1: Install recharts**

```bash
cd frontend && bun add recharts
```

**Step 2: Verify installation**

```bash
cd frontend && bun run build
```

Expected: Build succeeds with recharts in node_modules.

**Step 3: Commit**

```bash
git add frontend/package.json frontend/bun.lockb
git commit -m "feat(frontend): add recharts dependency for analytics dashboard"
```

---

### Task 2: Add TypeScript types for timeseries data

**Files:**
- Modify: `frontend/src/types.ts` (append after `Filters` interface, ~line 75)

**Step 1: Add the types**

Append to end of `frontend/src/types.ts`:

```typescript
export type TimeRange = '1h' | '6h' | '24h' | '7d';

export interface TimeseriesBucket {
  timestamp: string;
  total: number;
  by_level: { debug: number; info: number; warn: number; error: number };
  error_rate: number;
  avg_duration_ms: number | null;
  p50_duration_ms: number | null;
  p95_duration_ms: number | null;
  p99_duration_ms: number | null;
}

export interface TimeseriesResponse {
  buckets: TimeseriesBucket[];
  top_error_categories: { category: string; count: number }[];
  status_code_distribution: { group: string; count: number }[];
  range: TimeRange;
}
```

**Step 2: Verify types compile**

```bash
cd frontend && npx tsc --noEmit
```

Expected: No errors.

**Step 3: Commit**

```bash
git add frontend/src/types.ts
git commit -m "feat(frontend): add timeseries types for analytics dashboard"
```

---

### Task 3: Add backend `/stats/timeseries` endpoint

**Files:**
- Modify: `backend/src/index.ts` (add new route after the `/stats` route, ~line 804)

**Step 1: Add the timeseries endpoint**

Insert after the existing `app.get('/stats', ...)` block (after line 804), before the `/storage` route:

```typescript
// Get timeseries data for analytics charts
app.get('/stats/timeseries', async (c) => {
  try {
    const range = (c.req.query('range') || '24h') as '1h' | '6h' | '24h' | '7d';

    // Determine time bucket format and cutoff
    let bucketFormat: string;
    let cutoff: string;
    switch (range) {
      case '1h':
        bucketFormat = '%Y-%m-%dT%H:%M:00Z'; // per-minute
        cutoff = "-1 hours";
        break;
      case '6h':
        bucketFormat = '%Y-%m-%dT%H:00:00Z'; // per-hour
        cutoff = "-6 hours";
        break;
      case '24h':
        bucketFormat = '%Y-%m-%dT%H:00:00Z'; // per-hour
        cutoff = "-24 hours";
        break;
      case '7d':
        bucketFormat = '%Y-%m-%dT00:00:00Z'; // per-day
        cutoff = "-7 days";
        break;
      default:
        bucketFormat = '%Y-%m-%dT%H:00:00Z';
        cutoff = "-24 hours";
    }

    // 1. Log volume bucketed by level
    const { results: bucketRows } = await c.env.DB.prepare(`
      SELECT
        strftime('${bucketFormat}', created_at) as bucket,
        COUNT(*) as total,
        SUM(CASE WHEN level = 'debug' THEN 1 ELSE 0 END) as debug_count,
        SUM(CASE WHEN level = 'info' THEN 1 ELSE 0 END) as info_count,
        SUM(CASE WHEN level = 'warn' THEN 1 ELSE 0 END) as warn_count,
        SUM(CASE WHEN level = 'error' THEN 1 ELSE 0 END) as error_count,
        AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms END) as avg_duration
      FROM logs
      WHERE created_at >= datetime('now', '${cutoff}')
      GROUP BY bucket
      ORDER BY bucket ASC
    `).all<{
      bucket: string;
      total: number;
      debug_count: number;
      info_count: number;
      warn_count: number;
      error_count: number;
      avg_duration: number | null;
    }>();

    // 2. Build buckets with percentile approximations
    const buckets = [];
    for (const row of bucketRows || []) {
      // For percentiles, query per-bucket (simple approach for D1)
      const { results: durationRows } = await c.env.DB.prepare(`
        SELECT duration_ms FROM logs
        WHERE strftime('${bucketFormat}', created_at) = ? AND duration_ms IS NOT NULL
        ORDER BY duration_ms ASC
      `).bind(row.bucket).all<{ duration_ms: number }>();

      const durations = durationRows?.map(d => d.duration_ms) || [];
      const p50 = durations.length > 0 ? durations[Math.floor(durations.length * 0.5)] : null;
      const p95 = durations.length > 0 ? durations[Math.floor(durations.length * 0.95)] : null;
      const p99 = durations.length > 0 ? durations[Math.floor(durations.length * 0.99)] : null;

      buckets.push({
        timestamp: row.bucket,
        total: row.total,
        by_level: {
          debug: row.debug_count,
          info: row.info_count,
          warn: row.warn_count,
          error: row.error_count,
        },
        error_rate: row.total > 0 ? Math.round((row.error_count / row.total) * 10000) / 100 : 0,
        avg_duration_ms: row.avg_duration ? Math.round(row.avg_duration) : null,
        p50_duration_ms: p50 ?? null,
        p95_duration_ms: p95 ?? null,
        p99_duration_ms: p99 ?? null,
      });
    }

    // 3. Top error categories
    const { results: errorCats } = await c.env.DB.prepare(`
      SELECT category, COUNT(*) as count
      FROM logs
      WHERE level = 'error' AND created_at >= datetime('now', '${cutoff}')
      GROUP BY category
      ORDER BY count DESC
      LIMIT 10
    `).all<{ category: string; count: number }>();

    // 4. Status code distribution
    const { results: statusCodes } = await c.env.DB.prepare(`
      SELECT
        CASE
          WHEN status_code >= 200 AND status_code < 300 THEN '2xx'
          WHEN status_code >= 300 AND status_code < 400 THEN '3xx'
          WHEN status_code >= 400 AND status_code < 500 THEN '4xx'
          WHEN status_code >= 500 AND status_code < 600 THEN '5xx'
          ELSE 'other'
        END as status_group,
        COUNT(*) as count
      FROM logs
      WHERE status_code IS NOT NULL AND created_at >= datetime('now', '${cutoff}')
      GROUP BY status_group
      ORDER BY status_group ASC
    `).all<{ status_group: string; count: number }>();

    return c.json({
      buckets,
      top_error_categories: errorCats || [],
      status_code_distribution: (statusCodes || []).map(r => ({ group: r.status_group, count: r.count })),
      range,
    });
  } catch (error) {
    console.error('Error fetching timeseries:', error);
    return c.json({ error: 'Failed to fetch timeseries data' }, 500);
  }
});
```

**Step 2: Verify backend builds**

```bash
cd backend && npx tsc --noEmit
```

Expected: No errors.

**Step 3: Commit**

```bash
git add backend/src/index.ts
git commit -m "feat(backend): add /stats/timeseries endpoint for analytics charts"
```

---

### Task 4: Add `fetchTimeseries` API function

**Files:**
- Modify: `frontend/src/api.ts` (append after `getExportAllUrl`, ~line 151)

**Step 1: Add the API function**

Add import at top of `frontend/src/api.ts` — update the existing import line:

```typescript
import type { LogsResponse, Stats, Filters, Storage, Archive, TimeRange, TimeseriesResponse } from './types';
```

Append to end of file:

```typescript
export async function fetchTimeseries(range: TimeRange = '24h'): Promise<TimeseriesResponse> {
  const response = await fetch(`${API_BASE}/stats/timeseries?range=${range}`, getFetchOptions());
  if (!response.ok) throw new Error('Failed to fetch timeseries');
  return response.json();
}
```

**Step 2: Verify types compile**

```bash
cd frontend && npx tsc --noEmit
```

Expected: No errors.

**Step 3: Commit**

```bash
git add frontend/src/api.ts
git commit -m "feat(frontend): add fetchTimeseries API function"
```

---

### Task 5: Add Analytics tab and chart components to App.tsx

**Files:**
- Modify: `frontend/src/App.tsx`

This is the largest task. It involves:
1. Adding Recharts imports
2. Adding the `AnalyticsDashboard` component (before `App()`)
3. Adding `'analytics'` to tab state type
4. Adding an Analytics tab button to both mobile and desktop layouts
5. Rendering `AnalyticsDashboard` when analytics tab is active

**Step 1: Add imports at top of App.tsx**

After the existing imports (~line 20), add:

```typescript
import { fetchTimeseries } from './api';
import type { TimeRange, TimeseriesResponse } from './types';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell, Legend,
} from 'recharts';
```

**Step 2: Add AnalyticsDashboard component**

Insert before `export default function App()` (~line 1021). This component handles its own data fetching and state:

```typescript
const CHART_COLORS = {
  debug: '#6b7280',
  info: '#3b82f6',
  warn: '#f59e0b',
  error: '#ef4444',
};

const STATUS_COLORS: Record<string, string> = {
  '2xx': '#22c55e',
  '3xx': '#3b82f6',
  '4xx': '#f59e0b',
  '5xx': '#ef4444',
  'other': '#6b7280',
};

function AnalyticsDashboard({ isMobile }: { isMobile: boolean }) {
  const [range, setRange] = useState<TimeRange>('24h');
  const [data, setData] = useState<TimeseriesResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchTimeseries(range).then(res => {
      if (!cancelled) {
        setData(res);
        setLoading(false);
      }
    }).catch(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [range]);

  const formatXAxis = (ts: string) => {
    const d = new Date(ts);
    if (range === '7d') return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    if (range === '1h') return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  };

  const chartHeight = isMobile ? 250 : 300;

  if (loading) {
    return (
      <div className="analytics-dashboard">
        <div className="analytics-range-selector">
          {(['1h', '6h', '24h', '7d'] as TimeRange[]).map(r => (
            <button key={r} className={`range-btn ${range === r ? 'active' : ''}`} onClick={() => setRange(r)}>{r}</button>
          ))}
        </div>
        <div className="analytics-loading">Loading analytics...</div>
      </div>
    );
  }

  if (!data || data.buckets.length === 0) {
    return (
      <div className="analytics-dashboard">
        <div className="analytics-range-selector">
          {(['1h', '6h', '24h', '7d'] as TimeRange[]).map(r => (
            <button key={r} className={`range-btn ${range === r ? 'active' : ''}`} onClick={() => setRange(r)}>{r}</button>
          ))}
        </div>
        <div className="analytics-empty">No data available for this time range.</div>
      </div>
    );
  }

  // Prepare area chart data
  const volumeData = data.buckets.map(b => ({
    time: b.timestamp,
    debug: b.by_level.debug,
    info: b.by_level.info,
    warn: b.by_level.warn,
    error: b.by_level.error,
  }));

  // Error rate data
  const errorRateData = data.buckets.map(b => ({
    time: b.timestamp,
    rate: b.error_rate,
  }));

  // Performance data (only buckets that have duration data)
  const perfData = data.buckets
    .filter(b => b.p50_duration_ms !== null)
    .map(b => ({
      time: b.timestamp,
      p50: b.p50_duration_ms,
      p95: b.p95_duration_ms,
      p99: b.p99_duration_ms,
    }));

  // Status code donut data
  const statusData = data.status_code_distribution.map(s => ({
    name: s.group,
    value: s.count,
  }));

  return (
    <div className="analytics-dashboard">
      <div className="analytics-range-selector">
        {(['1h', '6h', '24h', '7d'] as TimeRange[]).map(r => (
          <button key={r} className={`range-btn ${range === r ? 'active' : ''}`} onClick={() => setRange(r)}>{r}</button>
        ))}
      </div>

      {/* Log Volume Over Time */}
      <div className="analytics-card">
        <h3>Log Volume</h3>
        <ResponsiveContainer width="100%" height={chartHeight}>
          <AreaChart data={volumeData}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis dataKey="time" tickFormatter={formatXAxis} stroke="#6b7280" fontSize={11} />
            <YAxis stroke="#6b7280" fontSize={11} />
            <Tooltip
              contentStyle={{ background: '#161616', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px', fontSize: '12px' }}
              labelFormatter={formatXAxis}
            />
            <Area type="monotone" dataKey="error" stackId="1" fill={CHART_COLORS.error} stroke={CHART_COLORS.error} fillOpacity={0.7} />
            <Area type="monotone" dataKey="warn" stackId="1" fill={CHART_COLORS.warn} stroke={CHART_COLORS.warn} fillOpacity={0.7} />
            <Area type="monotone" dataKey="info" stackId="1" fill={CHART_COLORS.info} stroke={CHART_COLORS.info} fillOpacity={0.7} />
            <Area type="monotone" dataKey="debug" stackId="1" fill={CHART_COLORS.debug} stroke={CHART_COLORS.debug} fillOpacity={0.7} />
            <Legend />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Error Insights Row */}
      <div className={`analytics-row ${isMobile ? 'analytics-row-mobile' : ''}`}>
        <div className="analytics-card">
          <h3>Error Rate %</h3>
          <ResponsiveContainer width="100%" height={chartHeight}>
            <LineChart data={errorRateData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="time" tickFormatter={formatXAxis} stroke="#6b7280" fontSize={11} />
              <YAxis stroke="#6b7280" fontSize={11} unit="%" />
              <Tooltip
                contentStyle={{ background: '#161616', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px', fontSize: '12px' }}
                labelFormatter={formatXAxis}
                formatter={(value: number) => [`${value}%`, 'Error Rate']}
              />
              <Line type="monotone" dataKey="rate" stroke={CHART_COLORS.error} strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="analytics-card">
          <h3>Top Error Categories</h3>
          {data.top_error_categories.length > 0 ? (
            <ResponsiveContainer width="100%" height={chartHeight}>
              <BarChart data={data.top_error_categories} layout="vertical" margin={{ left: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis type="number" stroke="#6b7280" fontSize={11} />
                <YAxis dataKey="category" type="category" stroke="#6b7280" fontSize={11} width={80} />
                <Tooltip
                  contentStyle={{ background: '#161616', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px', fontSize: '12px' }}
                />
                <Bar dataKey="count" fill={CHART_COLORS.error} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="analytics-empty-chart">No errors in this period</div>
          )}
        </div>
      </div>

      {/* API Performance Row */}
      <div className={`analytics-row ${isMobile ? 'analytics-row-mobile' : ''}`}>
        <div className="analytics-card">
          <h3>Response Times (ms)</h3>
          {perfData.length > 0 ? (
            <ResponsiveContainer width="100%" height={chartHeight}>
              <LineChart data={perfData}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis dataKey="time" tickFormatter={formatXAxis} stroke="#6b7280" fontSize={11} />
                <YAxis stroke="#6b7280" fontSize={11} />
                <Tooltip
                  contentStyle={{ background: '#161616', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px', fontSize: '12px' }}
                  labelFormatter={formatXAxis}
                  formatter={(value: number) => [`${value}ms`]}
                />
                <Line type="monotone" dataKey="p50" stroke="#22c55e" strokeWidth={2} dot={false} name="p50" />
                <Line type="monotone" dataKey="p95" stroke="#f59e0b" strokeWidth={2} dot={false} name="p95" />
                <Line type="monotone" dataKey="p99" stroke="#ef4444" strokeWidth={2} dot={false} name="p99" />
                <Legend />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="analytics-empty-chart">No duration data available</div>
          )}
        </div>

        <div className="analytics-card">
          <h3>Status Codes</h3>
          {statusData.length > 0 ? (
            <ResponsiveContainer width="100%" height={chartHeight}>
              <PieChart>
                <Pie
                  data={statusData}
                  cx="50%"
                  cy="50%"
                  innerRadius={isMobile ? 50 : 60}
                  outerRadius={isMobile ? 80 : 100}
                  dataKey="value"
                  label={({ name, value }) => `${name}: ${value}`}
                  labelLine={false}
                  fontSize={11}
                >
                  {statusData.map((entry) => (
                    <Cell key={entry.name} fill={STATUS_COLORS[entry.name] || '#6b7280'} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ background: '#161616', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px', fontSize: '12px' }}
                />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="analytics-empty-chart">No API data available</div>
          )}
        </div>
      </div>
    </div>
  );
}
```

**Step 3: Update tab state type and add tab button**

In `App()` function (~line 1023), change:

```typescript
const [activeTab, setActiveTab] = useState<'logs' | 'archives'>('logs');
```

to:

```typescript
const [activeTab, setActiveTab] = useState<'logs' | 'archives' | 'analytics'>('logs');
```

**Step 4: Add Analytics tab button (mobile layout)**

In the mobile tabs section (~line 1266), after the archives button, add a third tab button:

```html
<button className={`tab ${activeTab === 'analytics' ? 'active' : ''}`} onClick={() => setActiveTab('analytics')}>
  analytics
</button>
```

And add the analytics content rendering. After the archives section in the mobile `activeTab` conditional (~line 1275), change:

```
{activeTab === 'logs' ? (
  ...logs content...
) : (
  ...archives content...
)}
```

to:

```
{activeTab === 'logs' ? (
  ...logs content...
) : activeTab === 'archives' ? (
  ...archives content...
) : (
  <AnalyticsDashboard isMobile={true} />
)}
```

**Step 5: Add Analytics tab button (desktop layout)**

In the desktop tabs section (~line 1470), after the archives button, add:

```html
<button className={`tab ${activeTab === 'analytics' ? 'active' : ''}`} onClick={() => setActiveTab('analytics')}>
  analytics
</button>
```

And update the desktop `activeTab` conditional (~line 1479) the same way:

```
{activeTab === 'logs' ? (
  ...logs content...
) : activeTab === 'archives' ? (
  ...archives content...
) : (
  <AnalyticsDashboard isMobile={false} />
)}
```

**Step 6: Verify TypeScript compiles**

```bash
cd frontend && npx tsc --noEmit
```

Expected: No errors.

**Step 7: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "feat(frontend): add Analytics tab with Recharts dashboard"
```

---

### Task 6: Add CSS styles for the analytics dashboard

**Files:**
- Modify: `frontend/src/index.css` (append before the mobile media query section)

**Step 1: Add analytics CSS**

Append these styles before the `/* ─── Mobile ───` section:

```css
/* ─── Analytics Dashboard ───────────────────── */

.analytics-dashboard {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 8px 0;
}

.analytics-range-selector {
  display: flex;
  gap: 4px;
  background: var(--bg-1);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 4px;
  width: fit-content;
}

.range-btn {
  padding: 6px 16px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.range-btn:hover {
  color: var(--text-primary);
  background: var(--bg-2);
}

.range-btn.active {
  background: var(--accent-muted);
  color: var(--accent);
}

.analytics-card {
  background: var(--bg-1);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
}

.analytics-card h3 {
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  margin-bottom: 12px;
}

.analytics-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

.analytics-row-mobile {
  grid-template-columns: 1fr;
}

.analytics-loading,
.analytics-empty {
  text-align: center;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 13px;
  padding: 60px 20px;
}

.analytics-empty-chart {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 200px;
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 12px;
}

/* Recharts overrides to match our theme */
.analytics-card .recharts-cartesian-grid-horizontal line,
.analytics-card .recharts-cartesian-grid-vertical line {
  stroke: rgba(255, 255, 255, 0.04);
}

.analytics-card .recharts-legend-item-text {
  color: var(--text-secondary) !important;
  font-family: var(--font-mono) !important;
  font-size: 11px !important;
}

.analytics-card .recharts-default-tooltip {
  font-family: var(--font-mono) !important;
}
```

**Step 2: Verify build**

```bash
cd frontend && bun run build
```

Expected: Build succeeds.

**Step 3: Commit**

```bash
git add frontend/src/index.css
git commit -m "style(frontend): add analytics dashboard CSS styles"
```

---

### Task 7: Test in browser and verify all charts render

**Step 1: Start dev server**

```bash
cd frontend && bun run dev
```

**Step 2: Open browser and test**

1. Navigate to `http://localhost:3000`
2. Log in with credentials
3. Click the "analytics" tab
4. Verify time range selector works (1h, 6h, 24h, 7d)
5. Verify all 5 charts render: Log Volume (area), Error Rate (line), Error Categories (bar), Response Times (line), Status Codes (donut)
6. Resize to mobile (375px wide) and verify charts stack vertically

**Step 3: Test edge cases**

- Test with time range that has no data (should show "No data available" message)
- Verify charts with no duration data show "No duration data available"
- Verify charts with no errors show "No errors in this period"

**Step 4: Verify desktop layout unaffected**

- Switch to Logs tab — everything works as before
- Switch to Archives tab — everything works as before

---

### Task 8: Deploy backend and frontend

**Step 1: Deploy backend**

```bash
cd backend && bun run deploy
```

**Step 2: Deploy frontend**

```bash
cd frontend && bun run deploy
```

**Step 3: Final commit and push**

```bash
git add -A
git commit -m "feat: analytics dashboard with log volume, error insights, and API performance charts"
git push
```
