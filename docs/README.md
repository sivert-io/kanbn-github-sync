# Kanbn GitHub Sync (KGS)

Automatically syncs GitHub issues to Kanbn cards. **Boards and lists are created automatically** - no manual setup required!

## Features

- **✨ Automatic Setup**: Creates boards and lists for each repository automatically
- **🔄 Automatic Polling**: Checks GitHub repositories every minute and syncs changes
- **📋 Smart List Assignment**: Issues are automatically organized into lists based on status:
  - Closed → 🎉 Completed/Closed
  - Has branch/PR → ⚙️ In Progress
  - Assigned → ✨ Selected
  - Otherwise → 📝 Backlog
- **🚀 Multi-Repository Support**: Sync issues from multiple GitHub repositories
- **🏷️ Automatic Labels**: GitHub labels are automatically synced to Kanbn labels
- **📈 Status Tracking**: Cards automatically move between lists as issue status changes
- **🔁 Duplicate Prevention**: Tracks existing cards to update instead of creating duplicates
- **🎯 One Board Per Repo**: Each repository gets its own dedicated board

## Prerequisites

1. Node.js 18+ (for native fetch support)
2. A running Kanbn instance (e.g., `https://kan.example.com`)
3. Your Kanbn API key

## Quick Start

1. **Install dependencies:**
   ```bash
   yarn install
   ```

2. **Configure:**
   ```bash
   cp config/env.example .env
   cp config/config.json.example config/config.json
   # Edit .env and config/config.json with your settings
   ```

3. **Start:**
   ```bash
   yarn start
   ```

See [SETUP.md](./SETUP.md) for detailed setup instructions.

## Configuration

### Environment Variables (`.env`)

**Required:**
- `KAN_API_KEY` - Your Kanbn API key

### Configuration File (`config/config.json`)

```json
{
  "kanbn": {
    "baseUrl": "https://kan.example.com"
  },
  "github": {
    "repositories": [
      "owner/repo-one",
      "owner/repo-two"
    ]
  },
  "sync": {
    "intervalMinutes": 1
  },
  "server": {
    "port": 3001
  }
}
```

**Required:**
- `kanbn.baseUrl` - Your Kanbn instance URL
- `github.repositories` - Array of repository names (`"owner/repo"` format)

**Optional:**
- `sync.intervalMinutes` - How often to check for changes (default: 1 minute)
- `server.port` - HTTP server port (default: 3001)

## How It Works

### Automatic Board & List Creation

When you first sync a repository:
1. **Board is created** - Named after the repository (e.g., "owner - repo-name")
2. **Four lists are created** - Standard workflow lists in order:
   - 📝 Backlog
   - ✨ Selected
   - ⚙️ In Progress
   - 🎉 Completed/Closed

These are created automatically - you don't need to set anything up in Kanbn!

### Automatic List Assignment

Issues are assigned to lists based on their status:

| Issue Status | List |
|-------------|------|
| Closed | 🎉 Completed/Closed |
| Has associated PR/branch | ⚙️ In Progress |
| Assigned to someone | ✨ Selected |
| Everything else | 📝 Backlog |

When an issue's status changes, the card automatically moves to the correct list on the next sync.

### Label Syncing

GitHub labels are automatically synced to Kanbn labels:
- Labels are matched by name (case-insensitive)
- Missing labels are created automatically
- Label colors are preserved from GitHub

## API Endpoints

### `GET /health`

Check service health and configuration status.

```bash
curl http://localhost:3001/health
```

Response:
```json
{
  "success": true,
  "config": {
    "hasApiKey": true,
    "hasBaseUrl": true,
    "configuredRepositories": ["owner/repo"],
    "repositoryCount": 1,
    "syncIntervalMinutes": 1,
    "syncedCardsCount": 42
  }
}
```

### `POST /sync`

Trigger manual sync (all repositories).

```bash
curl -X POST http://localhost:3001/sync
```

Sync specific repository:
```bash
curl -X POST "http://localhost:3001/sync?owner=owner&repo=repo-name"
```

### `GET /boards`

Get all Kanbn boards (helper endpoint).

```bash
curl http://localhost:3001/boards
```

### `GET /boards/:boardId/lists`

Get all lists for a board (helper endpoint).

```bash
curl http://localhost:3001/boards/board_abc123/lists
```

## Docker

### Using Docker Compose

```bash
cd docker
docker-compose up -d
```

The container will:
- Use `.env` from the project root
- Mount `config/config.json` for easy editing
- Automatically restart on failure

See [SETUP.md](./SETUP.md) for more details.

## Development

### Scripts

- `yarn start` - Start the service
- `yarn dev` - Start in development mode with hot reload
- `yarn build` - Build TypeScript to JavaScript
- `yarn lint` - Run ESLint
- `yarn lint:fix` - Fix ESLint errors automatically
- `yarn type-check` - Type check without building

### Project Structure

```
.
├── config/          # Configuration examples
│   ├── config.json.example
│   ├── env.example
│   └── README.md
├── docker/          # Docker files
│   ├── Dockerfile
│   └── docker-compose.yml
├── docs/            # Documentation
│   ├── README.md    # This file
│   └── SETUP.md     # Setup guide
├── src/             # Source code
│   └── index.ts     # Main application
└── package.json
```

## Troubleshooting

### Cards not appearing

1. Check service logs for errors
2. Verify repository names are correct (`owner/repo` format)
3. Ensure `KAN_API_KEY` is set correctly
4. Check that `kanbn.baseUrl` is accessible

### Cards not moving between lists

The service syncs every minute by default. If a card hasn't moved:
1. Wait for the next sync cycle
2. Check issue status in GitHub (is it really closed/assigned/has PR?)
3. Trigger manual sync: `POST /sync`

### Boards/lists not being created

1. Verify `KAN_API_KEY` has permission to create boards/lists
2. Check service logs for API errors
3. Ensure Kanbn API is accessible at `kanbn.baseUrl`

## License

MIT
