# Kanbn GitHub Sync (KGS)

Automatically syncs GitHub issues to Kanbn cards. Creates boards and lists automatically - no manual setup required!

## 📚 Documentation

- **[Quick Setup Guide](./docs/SETUP.md)** - Step-by-step installation and configuration
- **[Full Documentation](./docs/README.md)** - Complete feature reference and API documentation

## 🚀 Quick Start

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
   
   The service automatically creates boards and lists - no manual setup needed!
   See `config/README.md` for configuration details.

3. **Start:**
   ```bash
   yarn start
   ```

## 🐳 Docker

```bash
cd docker
docker-compose up -d
```

## 📝 Scripts

- `yarn start` - Start the service
- `yarn dev` - Start in development mode with hot reload
- `yarn build` - Build TypeScript to JavaScript
- `yarn lint` - Run ESLint
- `yarn lint:fix` - Fix ESLint errors automatically
- `yarn type-check` - Type check without building

## 📁 Project Structure

```
.
├── config/          # Configuration examples
├── docker/          # Docker files
├── docs/            # Documentation
└── src/             # Source code
```
