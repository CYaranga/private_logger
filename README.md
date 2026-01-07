# Private Logger

A logging system for mobile applications built with Cloudflare Workers (Hono) and React.

## Live URLs

- **Frontend:** https://chrisyaranga.dev/logger/
- **API:** https://private-logger-api.christian-yaranga-05.workers.dev

## Project Structure

```
private_logger/
├── backend/          # Cloudflare Worker API (Hono + D1)
│   ├── src/
│   │   └── index.ts  # Main API code
│   ├── wrangler.toml # Cloudflare configuration
│   └── package.json
├── frontend/         # React log viewer
│   ├── src/
│   │   ├── App.tsx   # Main component
│   │   ├── api.ts    # API client
│   │   └── types.ts  # TypeScript types
│   └── package.json
└── README.md
```

## Setup

### Backend Deployment

1. **Login to Cloudflare:**
   ```bash
   cd backend
   bunx wrangler login
   ```

2. **Deploy the worker:**
   ```bash
   bun run deploy
   ```

   The API will be available at: `https://private-logger-api.christian-yaranga-05.workers.dev`

### Frontend Deployment

1. **Deploy to Cloudflare:**
   ```bash
   cd frontend
   bun run deploy
   ```

2. **For local development:**
   ```bash
   bun run dev
   ```
   Note: Local dev will connect to the production API.

## API Endpoints

### Create a log entry
```bash
POST /logs
Content-Type: application/json

{
  "user_id": "user-123",
  "message": "User logged in",
  "metadata": { "device": "iPhone 15", "os_version": "17.2" },
  "environment": "dev"  # "dev", "test", or "prod"
}
```

### Get logs (with filtering)
```bash
GET /logs?user_id=user-123&environment=dev&search=login&limit=50&offset=0
```

### Get log statistics
```bash
GET /stats
```

### Get unique users
```bash
GET /users
```

### Delete a log
```bash
DELETE /logs/:id
```

## Mobile SDK Example (React Native)

```typescript
const API_URL = 'https://private-logger-api.christian-yaranga-05.workers.dev';

interface LogOptions {
  userId: string;
  message: string;
  metadata?: Record<string, unknown>;
  environment?: 'dev' | 'test' | 'prod';
}

async function sendLog(options: LogOptions): Promise<void> {
  try {
    await fetch(`${API_URL}/logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: options.userId,
        message: options.message,
        metadata: options.metadata,
        environment: options.environment || 'dev',
      }),
    });
  } catch (error) {
    console.error('Failed to send log:', error);
  }
}

// Usage
sendLog({
  userId: 'user-123',
  message: 'App launched',
  metadata: {
    screen: 'HomeScreen',
    timestamp: new Date().toISOString(),
  },
  environment: __DEV__ ? 'dev' : 'prod',
});
```

## D1 Database

- **Database Name:** `private_logs_db`
- **Database ID:** `567469d3-8e51-47aa-88a3-4999c21c16cf`

### Schema

```sql
CREATE TABLE logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata TEXT,
  environment TEXT CHECK(environment IN ('dev', 'test', 'prod')) DEFAULT 'dev',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

## Local Development

1. **Start backend locally:**
   ```bash
   cd backend
   bun run dev
   ```
   This runs at `http://localhost:8787`

2. **Start frontend locally:**
   ```bash
   cd frontend
   bun run dev
   ```
   This runs at `http://localhost:3000` and proxies API requests to the backend.
