#!/bin/bash

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Script directory (scripts/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Project root (parent of scripts/)
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# Get current version from package.json
CURRENT_VERSION=$(node -p "require('$PROJECT_ROOT/package.json').version")
echo -e "${GREEN}Current version: ${CURRENT_VERSION}${NC}"

# Determine version bump type
if [ -z "$1" ]; then
  echo -e "${YELLOW}Usage: ./release.sh [patch|minor|major]${NC}"
  echo "Examples:"
  echo "  ./release.sh patch  # 1.0.0 -> 1.0.1"
  echo "  ./release.sh minor  # 1.0.0 -> 1.1.0"
  echo "  ./release.sh major  # 1.0.0 -> 2.0.0"
  exit 1
fi

BUMP_TYPE=$1
if [[ ! "$BUMP_TYPE" =~ ^(patch|minor|major)$ ]]; then
  echo -e "${RED}Error: Bump type must be patch, minor, or major${NC}"
  exit 1
fi

# Calculate new version
IFS='.' read -ra VERSION_PARTS <<< "$CURRENT_VERSION"
MAJOR=${VERSION_PARTS[0]}
MINOR=${VERSION_PARTS[1]}
PATCH=${VERSION_PARTS[2]}

case "$BUMP_TYPE" in
  patch) PATCH=$((PATCH + 1)) ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
esac

NEW_VERSION="${MAJOR}.${MINOR}.${PATCH}"
echo -e "${GREEN}New version: ${NEW_VERSION}${NC}"

# Update package.json
node -e "const fs=require('fs');const pkg=require('$PROJECT_ROOT/package.json');pkg.version='$NEW_VERSION';fs.writeFileSync('$PROJECT_ROOT/package.json',JSON.stringify(pkg,null,2)+'\n')"

# Verify we're on main branch
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "main" ]; then
  echo -e "${YELLOW}Warning: Not on main branch (currently on ${CURRENT_BRANCH})${NC}"
  read -p "Continue anyway? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    # Restore package.json version
    node -e "const fs=require('fs');const pkg=require('$PROJECT_ROOT/package.json');pkg.version='$CURRENT_VERSION';fs.writeFileSync('$PROJECT_ROOT/package.json',JSON.stringify(pkg,null,2)+'\n')"
    exit 1
  fi
fi

# Check for uncommitted changes
if ! git diff-index --quiet HEAD --; then
  echo -e "${YELLOW}Warning: You have uncommitted changes${NC}"
  git status --short
  read -p "Continue anyway? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    # Restore package.json version
    node -e "const fs=require('fs');const pkg=require('$PROJECT_ROOT/package.json');pkg.version='$CURRENT_VERSION';fs.writeFileSync('$PROJECT_ROOT/package.json',JSON.stringify(pkg,null,2)+'\n')"
    exit 1
  fi
fi

# Docker Hub configuration (matches your convention: sivertio/kanbn-github-sync:latest)
DOCKER_HUB_USER="${DOCKER_HUB_USER:-sivertio}"
DOCKER_IMAGE_NAME="${DOCKER_IMAGE_NAME:-kanbn-github-sync}"
IMAGE_TAG="${DOCKER_HUB_USER}/${DOCKER_IMAGE_NAME}"
LATEST_TAG="${IMAGE_TAG}:latest"
VERSION_TAG="${IMAGE_TAG}:v${NEW_VERSION}"

# Setup buildx for multi-platform builds
echo -e "${GREEN}Setting up Docker buildx for multi-platform builds...${NC}"
if ! docker buildx ls | grep -q "multiarch"; then
  docker buildx create --name multiarch --use || docker buildx use multiarch
else
  docker buildx use multiarch
fi
docker buildx inspect --bootstrap

# Build and push multi-platform Docker image
echo -e "${GREEN}Building multi-platform Docker image (linux/amd64, linux/arm64)...${NC}"
cd docker
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -f Dockerfile \
  -t "$LATEST_TAG" \
  -t "$VERSION_TAG" \
  --push \
  ..

if [ $? -ne 0 ]; then
  echo -e "${RED}Docker buildx build failed${NC}"
  cd ..
  # Restore package.json version
  node -e "const fs=require('fs');const pkg=require('./package.json');pkg.version='$CURRENT_VERSION';fs.writeFileSync('package.json',JSON.stringify(pkg,null,2)+'\n')"
  exit 1
fi

cd ..

echo -e "${GREEN}✓ Docker image built and pushed: ${LATEST_TAG}, ${VERSION_TAG}${NC}"

# Commit version bump
echo -e "${GREEN}Committing version bump...${NC}"
git add package.json yarn.lock 2>/dev/null || true
git commit -m "chore: bump version to ${NEW_VERSION}" || true

# Create git tag
TAG="v${NEW_VERSION}"
echo -e "${GREEN}Creating git tag: ${TAG}${NC}"
git tag -a "$TAG" -m "Release ${TAG}"

# Ask if user wants to push
echo -e "${GREEN}Release prepared successfully!${NC}"
echo ""
echo "Version bumped: ${CURRENT_VERSION} → ${NEW_VERSION}"
echo "Docker images pushed to Docker Hub:"
echo "  - ${LATEST_TAG}"
echo "  - ${VERSION_TAG}"
echo ""
read -p "Push to remote and create GitHub release? (y/N) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  echo -e "${GREEN}Pushing to remote...${NC}"
  git push origin main
  git push origin "$TAG"
  
  # Create GitHub release
  if command -v gh &> /dev/null; then
    echo -e "${GREEN}Creating GitHub release...${NC}"
    gh release create "$TAG" \
      --title "Release ${TAG}" \
      --notes "Release ${TAG}" \
      --target main || echo -e "${YELLOW}Warning: Failed to create GitHub release (gh CLI not available or not authenticated)${NC}"
  else
    echo -e "${YELLOW}gh CLI not found. Skipping GitHub release creation.${NC}"
    echo -e "${YELLOW}Install GitHub CLI to automatically create releases: https://cli.github.com/${NC}"
  fi
  
  echo -e "${GREEN}Release ${TAG} pushed to remote!${NC}"
else
  echo -e "${YELLOW}Release prepared but not pushed. To push later:${NC}"
  echo "  git push origin main"
  echo "  git push origin $TAG"
  echo ""
  echo "To create GitHub release manually:"
  echo "  gh release create $TAG --title \"Release ${TAG}\" --notes \"Release ${TAG}\""
fi

echo ""
echo -e "${GREEN}✓ Release ${TAG} complete!${NC}"
