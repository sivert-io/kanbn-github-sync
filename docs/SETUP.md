# Quick Setup Guide

Follow these steps to get your Kanbn GitHub sync service running. The service automatically creates boards and lists for each repository - no manual setup needed!

## Step-by-Step Setup

### 1. Install Dependencies

```bash
cd /home/sivert/kanbn-github-sync
yarn install
```

### 2. Configure the Service

**Step 1: Create `.env` file for secrets** (never commit this):
```bash
cp config/env.example .env
```

Edit `.env` and add your Kanbn API key:
```bash
# Required - Your Kanbn API key
KAN_API_KEY=kan_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

**Step 2: Create `config/config.json` file for configuration** (can be committed):
```bash
cp config/config.json.example config/config.json
```

Edit `config/config.json` with your settings:

```json
{
  "kanbn": {
    "baseUrl": "https://kan.example.com"
  },
  "github": {
    "repositories": [
      "your-username/repo-one",
      "your-username/repo-two",
      "your-username/repo-three"
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

Replace:
- `kan.example.com` → Your Kanbn instance URL
- `your-username/repo-one` → Your actual GitHub repository names

**That's it!** The service will automatically:
- Create a board for each repository
- Create 4 lists per board (Backlog, Selected, In Progress, Completed)
- Organize issues into the correct lists based on status

### 3. Start the Service

```bash
yarn start
```

The service will:
1. Create boards and lists for each repository (first sync only)
2. Sync all issues from your repositories
3. Automatically assign issues to lists based on status:
   - **Closed issues** → 🎉 Completed/Closed
   - **Issues with branches/PRs** → ⚙️ In Progress
   - **Assigned issues** → ✨ Selected
   - **All other issues** → 📝 Backlog

### 4. Verify It's Working

Check the service health:
```bash
curl http://localhost:3001/health
```

You should see:
```json
{
  "success": true,
  "config": {
    "hasApiKey": true,
    "hasBaseUrl": true,
    "configuredRepositories": ["your-username/repo-one", ...],
    "repositoryCount": 3
  }
}
```

## How It Works

### Automatic Board & List Creation

For each repository in your config, the service creates:
- **One board** - Named after your repository (e.g., "owner - repo-name")
- **Four lists** - Standard workflow:
  - 📝 Backlog
  - ✨ Selected
  - ⚙️ In Progress
  - 🎉 Completed/Closed

### Automatic List Assignment

Issues are automatically assigned to the correct list:
- When an issue is **closed**, it moves to Completed/Closed
- When a **branch/PR is created** for an issue, it moves to In Progress
- When an issue is **assigned to someone**, it moves to Selected
- **New issues** start in Backlog

Cards automatically move between lists as issue status changes!

## Docker Setup

### Using Docker Compose

```bash
cd docker
docker-compose up -d
```

Make sure you have:
- `.env` file with `KAN_API_KEY` in the project root
- `config/config.json` with your configuration

The Docker container will:
- Copy example configs into the container
- Mount your `config/config.json` for easy editing
- Automatically restart if it crashes

## Troubleshooting

### Service won't start

1. Check that `KAN_API_KEY` is set in `.env`
2. Verify `kanbn.baseUrl` in `config/config.json`
3. Ensure at least one repository is configured

### Issues not syncing

1. Check service logs: `docker logs kanbn-github-sync` (if using Docker)
2. Verify GitHub repository names are correct (format: `owner/repo`)
3. Check the `/health` endpoint to see configuration status

### Cards not moving between lists

The service checks every minute (default). If status changed but card hasn't moved:
1. Wait for the next sync cycle
2. Trigger manual sync: `POST http://localhost:3001/sync`

## Next Steps

- **Customize sync interval**: Change `sync.intervalMinutes` in `config.json`
- **Add more repositories**: Add to the `github.repositories` array
- **Monitor activity**: Check logs to see sync activity

See `docs/README.md` for full documentation.
