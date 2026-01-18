<div align="center">
  <img src="assets/kgs-icon.svg" alt="Kanbn GitHub Sync" width="140" height="140">
  
  # Kanbn GitHub Sync (KGS)
  
  ⚡ **Automated GitHub issue synchronization to Kanbn — zero manual board setup**
  
  <p>Automatically syncs GitHub issues to Kanbn cards with intelligent list assignment. Creates boards and lists automatically - no manual configuration required.</p>

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](docker/docker-compose.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

**📚 [Features](#-features)** • [Configuration](#-configuration) • [Troubleshooting](#-troubleshooting)

</div>

---

## ✨ Features

🔧 **Automatic Setup** — Creates boards and lists automatically for each repository  
📋 **Smart List Assignment** — Issues automatically organized by status:
- Closed issues → 🎉 Completed/Closed
- Issues with branches/PRs → ⚙️ In Progress
- Assigned issues → ✨ Selected
- New issues → 📝 Backlog

🔄 **Real-Time Sync** — Polls GitHub repositories every 5 minutes (or 1 minute with GitHub token) and syncs changes  
📊 **Status Tracking** — Cards automatically move between lists as issue status changes  
🏷️ **Label Sync** — GitHub labels automatically synced to Kanbn labels  
🚀 **Multi-Repository** — Sync multiple GitHub repositories simultaneously  
🎯 **One Board Per Repo** — Each repository gets its own dedicated Kanbn board  

<div align="center">
  <img src="assets/preview.png" alt="Kanbn GitHub Sync Preview" width="800">
  <p><em>Automated GitHub issue synchronization with intelligent list assignment</em></p>
</div>

---

## ⚙️ Requirements

- **Docker** and **Docker Compose** ([Install Docker](https://docs.docker.com/engine/install/))
- A running **Kanbn instance** (e.g., `https://kan.example.com`)
- Your **Kanbn API key**

---

## 🚀 Quick Start

**Get up and running with Docker in minutes:**

1. **Create a directory for your deployment:**
   ```bash
   mkdir kanbn-github-sync
   cd kanbn-github-sync
   ```

2. **Create `docker-compose.yml`:**
   ```yaml
   version: '3.8'

   services:
     kgs:
       image: sivertio/kanbn-github-sync:latest
       container_name: kanbn-github-sync
       restart: unless-stopped
       env_file:
         - .env
       volumes:
         - ./config.json:/app/config/config.json
       environment:
         - NODE_ENV=production
   ```

3. **Create `.env` file** (required - contains API keys and secrets):
   ```bash
   cat > .env << 'EOF'
   # Required: Kanbn API key
   KAN_API_KEY=kan_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   
   # Optional: GitHub token (for higher rate limits: 5000 requests/hour vs 60 requests/hour)
   # Without this, minimum sync interval is 5 minutes to avoid rate limits
   # With this, you can use shorter intervals (e.g., 1 minute)
   # Supports both token types:
   #   - Classic PAT: ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   #   - Fine-grained PAT: github_pat_11ABT...
   # Get your token from: https://github.com/settings/tokens
   # GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   EOF
   ```

4. **Create `config.json` file** (required - contains service configuration):
   ```bash
   cat > config.json << 'EOF'
   {
     "kanbn": {
       "baseUrl": "https://kan.example.com",
       "workspaceUrlSlug": "YOUR_WORKSPACE_SLUG"
     },
     "github": {
       "repositories": {
         "owner/repo-one": "My Board Name",
         "owner/repo-two": "Another Board"
       }
     },
     "boards": {
       "defaultVisibility": "private"
     },
     "sync": {
       "intervalMinutes": 5
     },
     "lists": {
       "backlog": "📝 Backlog",
       "selected": "✨ Selected",
       "inProgress": "⚙️ In Progress",
       "completed": "🎉 Completed/Closed"
     }
   }
   EOF
   ```

5. **Edit `.env` and `config.json`** with your actual values:
   - In `.env`: Replace `kan_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` with your Kanbn API key
   - Optionally add `GITHUB_TOKEN` for higher rate limits
   - In `config.json`:
     - Replace `https://kan.example.com` with your Kanbn instance URL
     - Replace `YOUR_WORKSPACE_SLUG` with your workspace slug (found in Kanbn Settings → Workspace URL)
     - Replace `owner/repo-one`, `owner/repo-two` with your GitHub repositories
     - Customize board names, visibility, list names, and sync interval as needed

6. **Start the service:**
   ```bash
   docker compose up -d
   ```
   
   **Note:** Both `.env` and `config.json` must exist in the same directory as `docker-compose.yml` before starting docker compose.
   
   **To force pull the latest version:**
   ```bash
   docker compose pull
   docker compose up -d
   ```
   This pulls the latest image from Docker Hub before starting. Useful when updating to a new release.

👉 **For local development or building from source, see [CONTRIBUTING.md](.github/CONTRIBUTING.md)**

---

## 📋 Configuration

The service automatically creates boards and lists - you only need to configure:

### Environment Variables (`.env`)

**Required in same directory as `docker-compose.yml`**

| Variable | Required | Description |
|----------|----------|-------------|
| `KAN_API_KEY` | ✅ Yes | Your Kanbn API key |
| `GITHUB_TOKEN` | ❌ Optional | GitHub token for higher rate limits (5000 vs 60 requests/hour). Supports both Classic PAT (`ghp_...`) and Fine-grained PAT (`github_pat_...`) |

### Service Configuration (`config.json`)

**Required in same directory as `docker-compose.yml`**

| Field | Required | Description |
|-------|----------|-------------|
| `kanbn.baseUrl` | ✅ Yes | Your Kanbn instance URL (e.g., `https://kan.example.com`) |
| `kanbn.workspaceUrlSlug` | ✅ Yes | Your workspace slug (found in Kanbn Settings → Workspace URL) |
| `github.repositories` | ✅ Yes | Object mapping `"owner/repo"` to board names, or array for default naming |
| `boards.defaultVisibility` | ❌ Optional | Default board visibility: `"private"` or `"public"` (default: `"private"`) |
| `sync.intervalMinutes` | ❌ Optional | Sync interval in minutes (default: 5, minimum: 5 without GitHub token, minimum: 1 with token) |
| `lists` | ❌ Optional | Custom list names with emoji. Defaults: `backlog`, `selected`, `inProgress`, `completed` |

**Example repository configurations:**
```json
{
  "github": {
    "repositories": {
      "owner/repo-one": "Custom Board Name",
      "owner/repo-two": {
        "name": "Another Board",
        "slug": "custom-slug",
        "visibility": "public"
      }
    }
  }
}
```

👉 **See `config/env.example` and `config/config.json.example` for detailed examples and all available options.**


---

## 🔄 How It Works

### Automatic Board & List Creation

For each repository, the service automatically:
1. Creates a **board** named after your repository (e.g., "owner - repo-name")
2. Creates **four lists** in order:
   - 📝 Backlog
   - ✨ Selected
   - ⚙️ In Progress
   - 🎉 Completed/Closed

### Automatic List Assignment

Issues are automatically assigned to the correct list based on their GitHub status. Cards automatically move between lists when issue status changes.

## 🔧 Troubleshooting

**Service won't start?**
- Check that `.env` and `config.json` exist next to `docker-compose.yml`
- Verify `KAN_API_KEY` in `.env` and `kanbn.baseUrl` + `kanbn.workspaceUrlSlug` in `config.json`
- Ensure at least one repository is configured
- Check logs: `docker compose logs kgs` - service will stop if it detects placeholder values

**Issues not syncing?**
- Check service logs: `docker compose logs -f kgs`
- Verify repository names are correct (format: `owner/repo`)
- Service syncs every 5 minutes by default (1 minute with `GITHUB_TOKEN`)

**Rate limit errors?**
- Without `GITHUB_TOKEN`: 60 requests/hour (minimum 5-minute interval enforced)
- With `GITHUB_TOKEN`: 5000 requests/hour (can use shorter intervals)
- Service stops syncing remaining repos if rate limit is hit

---

## 🤝 Contributing

Contributions are welcome! Whether you're fixing bugs, adding features, improving docs, or sharing ideas.

👉 **[Read the Contributing Guide](.github/CONTRIBUTING.md)**

---

## 📜 License

MIT License - see [LICENSE](LICENSE) for details

---

<div align="center">
  <strong>Made with ❤️ for productive issue management</strong>
</div>
