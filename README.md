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

🔄 **Real-Time Sync** — Polls GitHub repositories every minute and syncs changes  
📊 **Status Tracking** — Cards automatically move between lists as issue status changes  
🏷️ **Label Sync** — GitHub labels automatically synced to Kanbn labels  
🚀 **Multi-Repository** — Sync multiple GitHub repositories simultaneously  
🎯 **One Board Per Repo** — Each repository gets its own dedicated Kanbn board  

---

## ⚙️ Requirements

- **Node.js 18+** (for native fetch support)
- **Docker** and **Docker Compose** (optional, for containerized deployment) ([Install Docker](https://docs.docker.com/engine/install/))
- A running **Kanbn instance** (e.g., `https://kan.example.com`)
- Your **Kanbn API key**

---

## 🚀 Quick Start

Get up and running in minutes:

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


### 🐳 Docker

**Production** (uses Docker Hub image):
```bash
cd docker
docker-compose up -d
```

**Development** (builds from local source):
```bash
cd docker
docker-compose -f docker-compose.dev.yml up -d
```

---

## 📋 Configuration

The service automatically creates boards and lists - you only need to configure:

**`.env`** (secrets):
```bash
# Required: Kanbn API key
KAN_API_KEY=kan_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Optional: GitHub token (for higher rate limits: 5000 requests/hour vs 60 requests/hour)
# Without this, minimum sync interval is 5 minutes to avoid rate limits
# Supports both Classic PAT (ghp_...) and Fine-grained PAT (github_pat_...)
# GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

**`config/config.json`** (configuration):
```json
{
  "kanbn": {
    "baseUrl": "https://kan.example.com",
    "workspaceUrlSlug": "MAT"
  },
  "github": {
    "repositories": {
      "owner/repo-one": "My Custom Board Name",
      "owner/repo-two": "Another Board"
    }
  },
  "sync": {
    "intervalMinutes": 5
  },
  "lists": {
    "backlog": "📝 Backlog",
    "selected": "✨ Selected",
    "inProgress": "⚙️ In Progress",
    "completed": "🎉 Completed/Closed"
  },
  "server": {
    "port": 3001
  }
}
```

See [`config/README.md`](./config/README.md) for detailed configuration options.

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

### Service won't start
- Check that `KAN_API_KEY` is set in `.env`
- Verify `kanbn.baseUrl` and `kanbn.workspaceUrlSlug` in `config/config.json`
- Ensure at least one repository is configured

### Issues not syncing
- Check service logs
- Verify GitHub repository names are correct (format: `owner/repo`)
- Check the `/health` endpoint: `curl http://localhost:3001/health`

### Rate limit errors
- The service respects GitHub API rate limits (60 requests/hour unauthenticated)
- Rate limit reset time is shown in error messages with your local timezone
- If rate limited, the service will stop syncing remaining repos to avoid unnecessary API calls

### Cards not updating
- The service syncs every minute by default
- Trigger manual sync: `POST http://localhost:3001/sync`

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
