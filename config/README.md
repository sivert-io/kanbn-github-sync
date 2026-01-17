# Configuration

This directory contains configuration examples for Kanbn GitHub Sync (KGS).

## Automatic Setup

The service **automatically creates boards and lists** for each repository you configure. You don't need to manually set up anything in Kanbn!

### What Gets Created Automatically

For each repository in your configuration:
1. **One board** - Named after your repository (e.g., "owner - repo-name")
2. **Four lists** - Standard workflow lists:
   - 📝 Backlog
   - ✨ Selected
   - ⚙️ In Progress
   - 🎉 Completed/Closed

### Automatic List Assignment

Issues are automatically assigned to the correct list based on their status:
- **Closed issues** → 🎉 Completed/Closed
- **Issues with branches/PRs** → ⚙️ In Progress
- **Assigned issues** → ✨ Selected
- **All other issues** → 📝 Backlog

Cards automatically move between lists as issue status changes!

## Configuration Format

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

### Fields

**Required:**
- `kanbn.baseUrl` - Your Kanbn instance URL
- `github.repositories` - Array of repository names in "owner/repo" format

**Optional:**
- `sync.intervalMinutes` - How often to check for changes (default: 1 minute)
- `server.port` - Port for HTTP server (default: 3001)

## Quick Start

1. **Copy the example:**
   ```bash
   cp config/config.json.example config/config.json
   ```

2. **Edit `config/config.json`:**
   - Replace `kan.example.com` with your Kanbn instance URL
   - Replace repository names with your GitHub repos

3. **Start the service:**
   ```bash
   yarn start
   ```

The service will automatically create boards and lists for each repository on first sync!
