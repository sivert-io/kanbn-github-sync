#!/usr/bin/env node

/**
 * Kanbn GitHub Sync (KGS)
 * Automatically syncs GitHub issues to Kanbn cards via polling
 */

import dotenv from 'dotenv';
import express, { Request, Response } from 'express';
import fetch from 'node-fetch';
import { readFileSync, watchFile } from 'fs';
import { join } from 'path';

// Load environment variables (for secrets)
dotenv.config();

// Load configuration from config.json
interface Config {
  kanbn?: {
    baseUrl?: string;
    workspaceUrlSlug?: string; // Workspace URL slug/identifier from settings (e.g., "MAT")
  };
  github?: {
    // Support both formats:
    // - Array: ["owner/repo"] (uses default board name "owner - repo")
    // - Object: { "owner/repo": "Custom Board Name" } (uses custom board name)
    repositories?: string[] | Record<string, string>;
  };
  sync?: {
    intervalMinutes?: number;
  };
  lists?: {
    backlog?: string;
    selected?: string;
    inProgress?: string;
    completed?: string;
  };
  server?: {
    port?: number;
  };
}

let config: Config = {};
let configLoaded = false;
let configPath: string | null = null;

/**
 * Load configuration from config.json
 */
function loadConfig(): { success: boolean; error?: string } {
  try {
    // Try config/ directory first, then root for backward compatibility
    const configDirPath = join(process.cwd(), 'config/config.json');
    let configFile: string;
    let path: string;
    
    try {
      configFile = readFileSync(configDirPath, 'utf-8');
      path = configDirPath;
    } catch {
      // Fallback to root directory
      const rootConfigPath = join(process.cwd(), 'config.json');
      configFile = readFileSync(rootConfigPath, 'utf-8');
      path = rootConfigPath;
    }
    
    config = JSON.parse(configFile);
    configPath = path;
    configLoaded = true;
    return { success: true };
  } catch (error) {
    // config.json doesn't exist or is invalid
    configLoaded = false;
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    };
  }
}

// Initial config load
const initialLoad = loadConfig();
if (initialLoad.success) {
  console.log('[CONFIG] Loaded configuration from config.json');
}

const app = express();

// Configuration (secrets from .env, config from config.json)
const KAN_API_KEY = process.env.KAN_API_KEY || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || ''; // Optional: for higher GitHub API rate limits (5000 req/hr)

// Debug: Log if GitHub token is detected (masked for security)
if (GITHUB_TOKEN) {
  const maskedToken = GITHUB_TOKEN.substring(0, 10) + '...' + GITHUB_TOKEN.substring(GITHUB_TOKEN.length - 4);
  console.log(`[CONFIG] GitHub token detected: ${maskedToken} (5000 requests/hour)`);
} else {
  console.log('[CONFIG] No GitHub token found - using unauthenticated API (60 requests/hour)');
}

let KAN_BASE_URL = config.kanbn?.baseUrl || '';
let KAN_WORKSPACE_URL_SLUG = config.kanbn?.workspaceUrlSlug || '';
// Will be resolved from slug at startup
let KAN_WORKSPACE_ID = '';
// Minimum 5 minutes to avoid GitHub rate limits (60 requests/hour unauthenticated)
const MIN_SYNC_INTERVAL_MINUTES = 5;
const configuredInterval = config.sync?.intervalMinutes || 1;
let SYNC_INTERVAL_MINUTES = configuredInterval < MIN_SYNC_INTERVAL_MINUTES 
  ? MIN_SYNC_INTERVAL_MINUTES 
  : configuredInterval;
// HTTP server is optional - only start if port is configured
const PORT = config.server?.port;

// Middleware
app.use(express.json());

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: Array<{ name: string; color?: string }>;
  html_url: string;
  assignees?: Array<{ login: string }>; // People assigned to the issue
  pull_request?: { url: string } | null; // If issue has associated PR (branch)
  user?: { login: string; html_url: string }; // Issue creator/author
  created_at?: string; // Issue creation date
  updated_at?: string; // Issue last update date
}

interface GitHubComment {
  id: number;
  body: string;
  user: { login: string; html_url: string };
  created_at: string;
  updated_at: string;
}

interface KanbnCard {
  publicId?: string;
  title: string;
  description?: string;
  listPublicId: string;
  position?: 'start' | 'end' | number;
  labelPublicIds?: string[];
}

// Cache for repo -> board/list IDs
const repoBoardCache = new Map<string, string>(); // repo -> boardId
const repoListCache = new Map<string, Map<string, string>>(); // repo -> (listName -> listId)

// Sync interval timer (for reloading config)
let syncIntervalTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start or restart the sync interval timer
 */
function startSyncInterval(): void {
  // Clear existing interval if any
  if (syncIntervalTimer) {
    clearInterval(syncIntervalTimer);
  }
  
  const intervalMs = SYNC_INTERVAL_MINUTES * 60 * 1000;
  syncIntervalTimer = setInterval(() => {
    syncAllRepositories().catch((error) => {
      console.error('Scheduled sync failed:', error);
    });
  }, intervalMs);
}

// Default list names (can be overridden in config.json)
const DEFAULT_LIST_NAMES = {
  BACKLOG: '📝 Backlog',
  SELECTED: '✨ Selected',
  IN_PROGRESS: '⚙️ In Progress',
  COMPLETED: '🎉 Completed/Closed',
} as const;

/**
 * Get list names from config or use defaults
 */
function getListNames(): { BACKLOG: string; SELECTED: string; IN_PROGRESS: string; COMPLETED: string } {
  return {
    BACKLOG: config.lists?.backlog || DEFAULT_LIST_NAMES.BACKLOG,
    SELECTED: config.lists?.selected || DEFAULT_LIST_NAMES.SELECTED,
    IN_PROGRESS: config.lists?.inProgress || DEFAULT_LIST_NAMES.IN_PROGRESS,
    COMPLETED: config.lists?.completed || DEFAULT_LIST_NAMES.COMPLETED,
  };
}

// Cache for repo -> custom board names
const repoBoardNames = new Map<string, string>(); // repo -> custom board name

/**
 * Get list of configured repositories
 */
function getRepositories(): string[] {
  const repos = config.github?.repositories;
  if (!repos) return [];
  
  // If it's an array, return as-is
  if (Array.isArray(repos)) {
    // Store default board names for backward compatibility
    repos.forEach(repo => {
      if (!repoBoardNames.has(repo)) {
        repoBoardNames.set(repo, repo.replace('/', ' - '));
      }
    });
    return repos;
  }
  
  // If it's an object (key-value), extract keys and store custom names
  const repoKeys = Object.keys(repos);
  repoKeys.forEach(repo => {
    repoBoardNames.set(repo, repos[repo]);
  });
  return repoKeys;
}

/**
 * Get board name for a repository (custom name or default)
 */
function getBoardName(repoFullName: string): string {
  // Check if we have a custom name cached
  if (repoBoardNames.has(repoFullName)) {
    return repoBoardNames.get(repoFullName)!;
  }
  // Default: "owner - repo"
  return repoFullName.replace('/', ' - ');
}

/**
 * Check if a repository is configured
 */
function isRepoConfigured(repoFullName: string): boolean {
  return getRepositories().includes(repoFullName);
}

/**
 * Fetch workspace by slug (by searching in all workspaces)
 */
async function fetchWorkspaceBySlug(slug: string): Promise<{ publicId: string; name: string; slug?: string } | null> {
  try {
    // Fetch all workspaces and find the one with matching slug
    const workspaces = await fetchWorkspaces();
    const workspace = workspaces.find(w => w.slug === slug);
    return workspace || null;
  } catch (error) {
    return null;
  }
}

/**
 * Fetch available workspaces from Kanbn
 */
async function fetchWorkspaces(): Promise<Array<{ publicId: string; name: string; slug?: string }>> {
  try {
    // The /workspaces endpoint returns an array of { role, workspace } objects
    const workspaceItems = await kanbnRequest<Array<{ 
      role: string; 
      workspace: { publicId: string; name: string; slug?: string; description?: string; plan?: string } 
    }>>('/workspaces');
    
    // Extract the workspace objects from the response
    return workspaceItems.map(item => ({
      publicId: item.workspace.publicId,
      name: item.workspace.name,
      slug: item.workspace.slug,
    }));
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    // Check if it's a 500 error from the API
    if (errorMsg.includes('500 Internal Server Error')) {
      console.error('[CONFIG] ERROR: Kanbn API returned a 500 Internal Server Error when fetching workspaces.');
      console.error('   This is a server-side error from your Kanbn instance.');
      console.error('   Please check:');
      console.error('   • Is your Kanbn instance running and accessible?');
      console.error('   • Is your API key valid and has proper permissions?');
      console.error('   • Check your Kanbn server logs for more details');
    } else {
      console.error('Failed to fetch workspaces:', errorMsg);
    }
    return [];
  }
}

/**
 * Resolve workspace slug to workspace ID
 */
async function resolveWorkspaceId(): Promise<string | null> {
  if (!KAN_WORKSPACE_URL_SLUG) {
    return null; // No workspace URL slug provided
  }
  
  // Fetch workspace by slug and get its ID
  const workspace = await fetchWorkspaceBySlug(KAN_WORKSPACE_URL_SLUG);
  if (workspace) {
    return workspace.publicId;
  }
  
  return null; // Invalid slug
}

/**
 * Validate workspace slug and return available workspaces if invalid/missing
 */
async function validateWorkspaceId(): Promise<{ valid: boolean; workspaces: Array<{ publicId: string; name: string; slug?: string }>; resolvedId?: string }> {
  const workspaces = await fetchWorkspaces();
  
  // Resolve workspace slug to actual ID
  const resolvedId = await resolveWorkspaceId();
  
  if (!resolvedId) {
    return { valid: false, workspaces };
  }

  // Validate that the resolved ID exists in the workspace list
  const workspaceExists = workspaces.some(w => w.publicId === resolvedId);
  
  if (!workspaceExists && workspaces.length > 0) {
    return { valid: false, workspaces, resolvedId };
  }
  
  return { valid: true, workspaces, resolvedId };
}

/**
 * Verify configuration
 */
function verifyConfig(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!KAN_API_KEY) errors.push('KAN_API_KEY is required');
  if (!KAN_BASE_URL) errors.push('kanbn.baseUrl is required in config.json');
  if (!KAN_WORKSPACE_URL_SLUG) {
    errors.push('kanbn.workspaceUrlSlug is required in config.json');
  }
  
  const repos = getRepositories();
  if (repos.length === 0) {
    errors.push('github.repositories is required in config.json (array of "owner/repo" strings, or object with "owner/repo": "Custom Board Name")');
  }
  
  return { valid: errors.length === 0, errors };
}

/**
 * Make authenticated request to Kanbn API with rate limiting and retry logic
 */
async function kanbnRequest<T>(
  endpoint: string,
  options: { method?: string; body?: unknown } = {},
  retryCount = 0
): Promise<T> {
  // Rate limiting: ensure minimum delay between requests
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  if (timeSinceLastRequest < MIN_REQUEST_DELAY_MS) {
    await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_DELAY_MS - timeSinceLastRequest));
  }
  lastRequestTime = Date.now();

  // Ensure endpoint starts with /api/v1 if it's a relative path
  let apiEndpoint = endpoint;
  if (!endpoint.startsWith('http') && !endpoint.startsWith('/api/v1')) {
    apiEndpoint = endpoint.startsWith('/') ? `/api/v1${endpoint}` : `/api/v1/${endpoint}`;
  }

  const url = endpoint.startsWith('http') ? endpoint : `${KAN_BASE_URL}${apiEndpoint}`;

  // Use x-api-key header for authentication
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': KAN_API_KEY,
  };

  const method = options.method || 'GET';
  
  // Debug logging for failed requests
  const debugMode = process.env.DEBUG === 'true';
  if (debugMode) {
    console.log(`[DEBUG] ${method} ${url}`);
  }

  const response = await fetch(url, {
    method,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    const errorText = await response.text();
    let errorMsg = errorText;
    try {
      const errorJson = JSON.parse(errorText);
      errorMsg = errorJson.message || errorText;
    } catch {
      // If not JSON, use raw text
    }

    // Handle rate limiting and 500 errors (500 often indicates rate limiting on Kanbn API)
    const isRateLimit = (response.status === 401 && errorMsg.includes('Rate limit')) || response.status === 429;
    const isServerError = response.status === 500;
    
    if (isRateLimit || isServerError) {
      const maxRetries = 3;
      if (retryCount < maxRetries) {
        // Wait 1-2 minutes (90 seconds average) when rate limited by Kanbn
        // Randomize between 60-120 seconds to avoid thundering herd
        const waitMinutes = 1 + Math.random(); // 1-2 minutes
        const waitSeconds = Math.floor(waitMinutes * 60); // 60-120 seconds
        const waitMs = waitSeconds * 1000;
        const errorType = isServerError ? 'Server error (likely rate limited)' : 'Rate limit';
        console.warn(`[KANBN API] Rate limit hit. Waiting ${waitSeconds}s (${Math.round(waitMinutes * 10) / 10} minute) before retry... (attempt ${retryCount + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
        return kanbnRequest<T>(endpoint, options, retryCount + 1);
      } else {
        const errorType = isServerError ? 'Server errors (likely rate limited)' : 'Rate limit';
        throw new Error(`Kanbn API ${errorType} exceeded after ${maxRetries} retries. Please wait before trying again.`);
      }
    }

    const fullErrorMsg = `Kanbn API error: ${method} ${url} → ${response.status} ${response.statusText} - ${errorText}`;
    if (debugMode || response.status !== 404) {
      console.error(`[ERROR] ${fullErrorMsg}`);
    }
    throw new Error(fullErrorMsg);
  }

  return response.json() as Promise<T>;
}

// Cache for label lookups (boardId -> label name -> labelId)
const labelCache = new Map<string, Map<string, string>>();

// Track issue number -> card ID mapping (repo#issue -> cardId)
const issueCardMap = new Map<string, string>(); // "owner/repo#123" -> "card_abc"

// Rate limiting: track last request time and enforce minimum delay between requests
// Kanbn API rate limit: 100 requests per minute = 600ms between requests
// Using 650ms to stay safely under the limit with some buffer
let lastRequestTime = 0;
const MIN_REQUEST_DELAY_MS = 650; // ~92 requests/minute (safely under Kanbn's 100 req/min limit)

/**
 * Get or ensure board exists for a repository (create if needed)
 * Prevents duplicates by always checking for existing boards first
 */
async function getOrCreateBoard(repoFullName: string): Promise<string> {
  // Check cache first
  if (repoBoardCache.has(repoFullName)) {
    const cachedBoardId = repoBoardCache.get(repoFullName);
    // Don't return 'failed' markers
    if (cachedBoardId && cachedBoardId !== 'failed') {
      return cachedBoardId;
    }
  }

  // Get board name (custom or default)
  const boardName = getBoardName(repoFullName);
  
  // Always try to fetch boards first to check for existing board (with retries for 500 errors)
  // This prevents duplicates even if previous fetch failed
  let existingBoard: { publicId: string; name: string } | undefined;
  const maxRetries = 5;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Use workspace-scoped endpoint if workspace ID is configured
      const boardsEndpoint = KAN_WORKSPACE_ID 
        ? `/workspaces/${KAN_WORKSPACE_ID}/boards`
        : '/boards';
      const boards = await kanbnRequest<Array<{ publicId: string; name: string }>>(boardsEndpoint);
      existingBoard = boards.find((b) => b.name === boardName);
      if (existingBoard) {
        repoBoardCache.set(repoFullName, existingBoard.publicId);
        // Board found - silent (avoid log spam on every sync)
        return existingBoard.publicId;
      }
      break; // Board doesn't exist, proceed to creation
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      // Retry on 500 errors (likely rate limiting)
      if (errorMsg.includes('500 Internal Server Error') && attempt < maxRetries - 1) {
        const backoffMs = Math.pow(2, attempt) * 1000;
        console.warn(`[PHASE 1] Server error when fetching boards for ${repoFullName}, retrying in ${backoffMs / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        continue;
      }
      // For other errors, log but continue (might create duplicate if board exists, but better than failing completely)
      if (!errorMsg.includes('404') && attempt === 0) {
        console.warn(`[PHASE 1] WARNING: Could not fetch boards to check for duplicates: ${errorMsg}`);
      }
      break; // Exit retry loop
    }
  }

  // Board doesn't exist, create it
  // The API requires both lists and labels arrays when creating a board
  try {
    // Use workspace-scoped endpoint if workspace ID is configured
    const boardsEndpoint = KAN_WORKSPACE_ID 
      ? `/workspaces/${KAN_WORKSPACE_ID}/boards`
      : '/boards';
    
    // Define the default lists that should be created with the board
    // The API expects an array of list names (strings), not objects
    const listNames = getListNames();
    const defaultLists = [
      listNames.BACKLOG,
      listNames.SELECTED,
      listNames.IN_PROGRESS,
      listNames.COMPLETED,
    ];
    
    const newBoard = await kanbnRequest<{ publicId: string; name: string }>(boardsEndpoint, {
      method: 'POST',
      body: {
        name: boardName,
        lists: defaultLists,
        labels: [], // Start with empty labels array
      },
    });
    repoBoardCache.set(repoFullName, newBoard.publicId);
    console.log(`[BOARD] Created board for ${repoFullName}: ${newBoard.publicId}`);
    return newBoard.publicId;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    
    // If creation failed because board already exists, try to fetch it again
    if (errorMsg.includes('already exists') || errorMsg.includes('duplicate') || errorMsg.includes('unique constraint')) {
      console.warn(`[BOARD] WARNING: Board "${boardName}" may already exist, searching for it...`);
      
      // Retry fetching boards once more to find the existing board
      try {
        const boardsEndpoint = KAN_WORKSPACE_ID 
          ? `/workspaces/${KAN_WORKSPACE_ID}/boards`
          : '/boards';
        const boards = await kanbnRequest<Array<{ publicId: string; name: string }>>(boardsEndpoint);
        const foundBoard = boards.find((b) => b.name === boardName);
        if (foundBoard) {
          repoBoardCache.set(repoFullName, foundBoard.publicId);
          // Board found - silent
          return foundBoard.publicId;
        }
      } catch (fetchError) {
        // If fetch fails again, continue to throw original error
      }
    }
    
    console.error(`[BOARD] ERROR: Failed to create board for ${repoFullName}. Check API permissions and endpoint.`);
    const boardsEndpoint = KAN_WORKSPACE_ID 
      ? `/workspaces/${KAN_WORKSPACE_ID}/boards`
      : '/boards';
    console.error(`   URL being called: ${KAN_BASE_URL}/api/v1${boardsEndpoint}`);
    console.error(`   Error: ${errorMsg}`);
    throw new Error(`Failed to create board for ${repoFullName}: ${errorMsg}`);
  }
}

/**
 * Get or ensure all required lists exist for a board (create if needed)
 */
async function getOrCreateLists(boardId: string, repoFullName: string): Promise<Map<string, string>> {
  // Check cache first
  if (repoListCache.has(repoFullName)) {
    return repoListCache.get(repoFullName)!;
  }

  const listMap = new Map<string, string>();

  // Fetch existing lists for the board
  let existingLists: Array<{ publicId: string; name: string }> = [];
  try {
    const board = await kanbnRequest<{ lists: Array<{ publicId: string; name: string }> }>(`/boards/${boardId}`);
    existingLists = board.lists || [];
  } catch (error) {
    console.warn(`Failed to fetch lists for board ${boardId}:`, error);
  }

  // Create all required lists (if they don't exist)
  const listNames = getListNames();
  const listOrder = [listNames.BACKLOG, listNames.SELECTED, listNames.IN_PROGRESS, listNames.COMPLETED];
  for (let i = 0; i < listOrder.length; i++) {
    const listName = listOrder[i];
    
    // Check if list already exists
    const existing = existingLists.find((l) => l.name === listName);
    if (existing) {
      listMap.set(listName, existing.publicId);
      continue;
    }

    // Create the list
    try {
      const newList = await kanbnRequest<{ publicId: string; name: string }>('/lists', {
        method: 'POST',
        body: {
          boardPublicId: boardId,
          name: listName,
          position: i,
        },
      });
      listMap.set(listName, newList.publicId);
      console.log(`[LIST] Created list "${listName}" for board ${boardId}`);
    } catch (error) {
      console.error(`Failed to create list "${listName}":`, error);
      throw error;
    }
  }

  repoListCache.set(repoFullName, listMap);
  return listMap;
}

/**
 * Determine which list an issue should be in based on its status
 */
function determineListForIssue(issue: GitHubIssue): string {
  const listNames = getListNames();
  
  // Closed issues go to Completed
  if (issue.state === 'closed') {
    return listNames.COMPLETED;
  }

  // Issues with associated PR (branch) go to In Progress
  if (issue.pull_request && issue.pull_request.url) {
    return listNames.IN_PROGRESS;
  }

  // Assigned issues go to Selected
  if (issue.assignees && issue.assignees.length > 0) {
    return listNames.SELECTED;
  }

  // Everything else goes to Backlog
  return listNames.BACKLOG;
}

/**
 * Fetch and cache all existing labels for a board
 */
async function fetchBoardLabels(boardId: string): Promise<void> {
  // Skip if already cached
  if (labelCache.has(boardId)) {
    return;
  }

  try {
    // Try to get board with labels - check if cards have labels we can extract
    // First, try to get labels from cards in the board
    const board = await kanbnRequest<{ 
      lists?: Array<{ 
        cards?: Array<{ 
          labels?: Array<{ 
            publicId: string; 
            name: string; 
            colourCode: string;
          }>;
        }>;
      }>;
    }>(`/boards/${boardId}`);
    
    const labelsMap = new Map<string, string>();
    
    // Extract labels from cards
    if (board.lists) {
      for (const list of board.lists) {
        if (list.cards) {
          for (const card of list.cards) {
            if (card.labels) {
              for (const label of card.labels) {
                if (!labelsMap.has(label.name)) {
                  labelsMap.set(label.name, label.publicId);
                }
              }
            }
          }
        }
      }
    }
    
    // Cache the labels we found
    if (labelsMap.size > 0) {
      labelCache.set(boardId, labelsMap);
    } else {
      // Initialize empty cache to avoid refetching
      labelCache.set(boardId, new Map());
    }
  } catch (error) {
    // If we can't fetch labels, initialize empty cache and continue
    labelCache.set(boardId, new Map());
  }
}

/**
 * Get or create a Kanbn label by name
 */
async function getOrCreateLabel(boardId: string, labelName: string, labelColor?: string): Promise<string | null> {
  // Ensure we've fetched existing labels for this board
  await fetchBoardLabels(boardId);
  
  // Check cache first
  const boardCache = labelCache.get(boardId);
  if (boardCache?.has(labelName)) {
    return boardCache.get(labelName) || null;
  }

  // Label doesn't exist, create it
  try {
    // Convert color format if provided (GitHub uses #RRGGBB or RRGGBB, Kanbn expects exactly 7 chars with #)
    let colourCode = labelColor || '#808080'; // Default gray if no color provided
    
    // Ensure it's exactly 7 characters: if it's 6 chars (no #), add #; if it's already 7, use as-is
    if (colourCode.length === 6 && !colourCode.startsWith('#')) {
      colourCode = `#${colourCode}`;
    } else if (colourCode.length !== 7 || !colourCode.startsWith('#')) {
      // If it's not 7 chars or doesn't start with #, use default
      colourCode = '#808080';
    }
    
    // Use /labels endpoint (not /boards/{boardId}/labels)
    // See: https://docs.kan.bn/api-reference/labels/create-a-label
    const newLabel = await kanbnRequest<{ publicId: string; name: string; colourCode: string }>('/labels', {
      method: 'POST',
      body: {
        name: labelName,
        boardPublicId: boardId,
        colourCode: colourCode, // Must be exactly 7 characters (e.g., "#808080")
      },
    });

    const cache = labelCache.get(boardId) || new Map<string, string>();
    cache.set(labelName, newLabel.publicId);
    labelCache.set(boardId, cache);
    console.log(`[LABEL] Created new label: ${labelName}`);
    return newLabel.publicId;
  } catch (error) {
    // If label already exists, try to find it in the board
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (errorMsg.includes('already exists') || errorMsg.includes('duplicate')) {
      // Label exists but wasn't in our cache - refetch board labels
      await fetchBoardLabels(boardId);
      const cache = labelCache.get(boardId);
      if (cache?.has(labelName)) {
        return cache.get(labelName) || null;
      }
    } else {
      console.warn(`Failed to create label "${labelName}":`, errorMsg);
    }
    return null;
  }
}

/**
 * Map GitHub labels to Kanbn label IDs (auto-sync by name)
 */
async function mapLabels(githubLabels: GitHubIssue['labels'], boardId: string): Promise<string[]> {
  // Map each GitHub label to Kanbn label (create if needed)
  const labelIds: string[] = [];
  for (const label of githubLabels || []) {
    const kanbnLabelId = await getOrCreateLabel(boardId, label.name, label.color);
    if (kanbnLabelId) {
      labelIds.push(kanbnLabelId);
    }
  }
  return labelIds;
}

/**
 * Get all cards from a board
 * Returns a map of issue number -> card ID by matching GitHub URLs in descriptions or issue numbers in titles
 * Also fetches and caches existing labels from the board
 */
async function getAllBoardCards(
  boardId: string,
  repositoryUrl: string
): Promise<Map<number, { publicId: string; title: string; description?: string; listPublicId: string }>> {
  const cardMap = new Map<number, { publicId: string; title: string; description?: string; listPublicId: string }>();
  
  try {
    // Get board with all cards and labels
    const board = await kanbnRequest<{ 
      lists: Array<{ 
        publicId: string; 
        name: string;
        cards?: Array<{ 
          publicId: string; 
          title: string; 
          description?: string;
          listPublicId: string;
          labels?: Array<{ 
            publicId: string; 
            name: string; 
            colourCode: string;
          }>;
        }>;
      }>;
    }>(`/boards/${boardId}`);
    
    // Also extract and cache labels from cards while we're at it
    const labelsMap = new Map<string, string>();
    
    if (board.lists) {
      for (const list of board.lists) {
        if (list.cards) {
          for (const card of list.cards) {
            // Extract labels from card
            if (card.labels) {
              for (const label of card.labels) {
                if (!labelsMap.has(label.name)) {
                  labelsMap.set(label.name, label.publicId);
                }
              }
            }
            
            let issueNumber: number | null = null;
            
            // Method 1: Try to extract issue number from title prefix (e.g., "#42: " or "[#42] ")
            // This is our primary matching method since we always prefix titles with issue number
            if (card.title) {
              // Match patterns like: "#42: Title", "[#42] Title", "#42 - Title"
              const titlePrefixMatch = card.title.match(/^[\[#]?(\d+)[\]:\s\-]/);
              if (titlePrefixMatch && titlePrefixMatch[1]) {
                const parsed = parseInt(titlePrefixMatch[1], 10);
                if (!isNaN(parsed)) {
                  issueNumber = parsed;
                }
              }
            }
            
            // Method 2: Fallback - try to extract issue number from GitHub URL in description
            if (issueNumber === null && card.description) {
              // Match pattern: https://github.com/owner/repo/issues/123
              const issueMatch = card.description.match(new RegExp(`${repositoryUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/issues/(\\d+)`));
              if (issueMatch && issueMatch[1]) {
                const parsed = parseInt(issueMatch[1], 10);
                if (!isNaN(parsed)) {
                  issueNumber = parsed;
                }
              }
            }
            
            // Method 3: Last resort - try to extract issue number from anywhere in title
            if (issueNumber === null && card.title) {
              const titleMatch = card.title.match(/#(\d+)/);
              if (titleMatch && titleMatch[1]) {
                const parsed = parseInt(titleMatch[1], 10);
                if (!isNaN(parsed)) {
                  issueNumber = parsed;
                }
              }
            }
            
            // If we found an issue number, add to map
            if (issueNumber !== null) {
              // Only add if not already in map (prefer first match found)
              if (!cardMap.has(issueNumber)) {
                cardMap.set(issueNumber, {
                  publicId: card.publicId,
                  title: card.title,
                  description: card.description,
                  listPublicId: card.listPublicId || list.publicId,
                });
              }
            }
          }
        }
      }
    }
    
    // Cache the labels we found
    if (labelsMap.size > 0) {
      labelCache.set(boardId, labelsMap);
    } else {
      // Initialize empty cache to avoid refetching
      labelCache.set(boardId, new Map());
    }
  } catch (error) {
    // If we can't get board cards, return empty map (will create new cards)
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (!errorMsg.includes('500')) {
      console.warn(`[PHASE 2] WARNING: Could not fetch cards from board ${boardId}: ${errorMsg}`);
    }
  }
  
  return cardMap;
}

/**
 * Create or update a card in Kanbn from a GitHub issue
 * @param existingCard - Existing card from board (if found)
 * @returns true if card was created or updated, false if no changes were needed
 */
async function syncIssueCard(
  issue: GitHubIssue,
  repositoryUrl: string,
  repoFullName: string,
  existingCard?: { publicId: string; title: string; description?: string; listPublicId: string }
): Promise<boolean> {
  // Get or create board for this repo
  const boardId = await getOrCreateBoard(repoFullName);
  
  // Get or create all required lists for this board
  const listMap = await getOrCreateLists(boardId, repoFullName);
  
  // Determine which list this issue should be in
  const targetListName = determineListForIssue(issue);
  const targetListId = listMap.get(targetListName);
  if (!targetListId) {
    throw new Error(`List "${targetListName}" not found for board ${boardId}`);
  }

  const issueKey = getIssueKey(repoFullName, issue.number);
  const githubUrl = `${repositoryUrl}/issues/${issue.number}`;
  
  // Use existing card if provided, otherwise check in-memory cache
  let existingCardId = existingCard?.publicId || issueCardMap.get(issueKey);
  
  // Update cache if we found an existing card
  if (existingCard && !issueCardMap.has(issueKey)) {
    issueCardMap.set(issueKey, existingCard.publicId);
  }
  let description = issue.body || 'No description provided.';
  
  // Add issue metadata
  const metadata: string[] = [];
  if (issue.user) {
    metadata.push(`👤 **Author:** [@${issue.user.login}](${issue.user.html_url})`);
  }
  if (issue.created_at) {
    const createdDate = new Date(issue.created_at).toLocaleDateString();
    metadata.push(`📅 **Created:** ${createdDate}`);
  }
  if (issue.updated_at && issue.updated_at !== issue.created_at) {
    const updatedDate = new Date(issue.updated_at).toLocaleDateString();
    metadata.push(`🔄 **Updated:** ${updatedDate}`);
  }
  if (issue.assignees && issue.assignees.length > 0) {
    const assigneeList = issue.assignees.map(a => `@${a.login}`).join(', ');
    metadata.push(`👥 **Assigned:** ${assigneeList}`);
  }
  
  if (metadata.length > 0) {
    description += `\n\n---\n${metadata.join(' | ')}`;
  }
  
  description += `\n\n---\n🔗 [View on GitHub](${githubUrl}) | Issue #${issue.number}`;
  
  // Truncate description if it exceeds 10000 characters (Kanbn API limit)
  const MAX_DESCRIPTION_LENGTH = 10000;

  // Map labels
  const labelIds = await mapLabels(issue.labels, boardId);
  
  // Fetch comments to include count in description
  let commentCount = 0;
  try {
    const [owner, repo] = repoFullName.split('/');
    if (owner && repo) {
      const comments = await fetchGitHubIssueComments(owner, repo, issue.number);
      commentCount = comments.length;
    }
  } catch (error) {
    // Silently fail - comments are optional
  }
  
  // Add comment count to description if there are comments
  if (commentCount > 0) {
    description += `\n\n💬 **Comments:** ${commentCount} comment(s) on GitHub`;
  }
  
  // Truncate description if it exceeds 10000 characters (Kanbn API limit)
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    const truncated = description.substring(0, MAX_DESCRIPTION_LENGTH - 100);
    description = truncated + `\n\n... (truncated, original length: ${description.length} characters)`;
  }

  // Format card title with issue number prefix for reliable matching
  // Format: "#42: Title" - this ensures we can always match cards by title prefix
  const cardTitle = `#${issue.number}: ${issue.title}`;
  
  // Card creation requires labelPublicIds and memberPublicIds as arrays (even if empty)
  // See: https://docs.kan.bn/api-reference/cards/create-a-card
  const cardData: Partial<KanbnCard> & { 
    labelPublicIds: string[];
    memberPublicIds: string[];
  } = {
    title: cardTitle,
    description,
    listPublicId: targetListId,
    position: 'end',
    labelPublicIds: labelIds, // Required field - always include array
    memberPublicIds: [], // Required field - always include empty array
  };

  if (existingCardId) {
    // Check if update is needed by comparing existing card with new data
    const currentListId = existingCard?.listPublicId;
    const needsListUpdate = currentListId && currentListId !== targetListId;
    // Compare with formatted title (includes issue number prefix)
    const needsTitleUpdate = existingCard?.title !== cardTitle;
    const needsDescriptionUpdate = existingCard?.description !== description;
    
    // Only update if something actually changed
    if (needsListUpdate || needsTitleUpdate || needsDescriptionUpdate) {
      let currentListName: string | undefined;
      
      if (currentListId) {
        // Find the name of the current list
        for (const [listName, listId] of listMap.entries()) {
          if (listId === currentListId) {
            currentListName = listName;
            break;
          }
        }
      }
      
      // Note: Update endpoint doesn't require labelPublicIds/memberPublicIds
      // See: https://docs.kan.bn/api-reference/cards/update-a-card
      try {
        const updateData: Partial<KanbnCard> = {
          title: cardTitle, // Use formatted title with issue number prefix
          description,
          listPublicId: targetListId,
        };
        await kanbnRequest<KanbnCard>(`/cards/${existingCardId}`, {
          method: 'PUT',
          body: updateData,
        });
        
        // Log appropriate message based on whether card moved
        if (needsListUpdate && currentListName) {
          console.log(`[CARD] Moved #${issue.number}: ${issue.title} (${currentListName} → ${targetListName})`);
        } else {
          console.log(`[CARD] Updated #${issue.number}: ${issue.title} → ${targetListName}`);
        }
        return true; // Indicate update was performed
      } catch (error) {
        console.error(`Failed to update card for issue #${issue.number}:`, error);
        throw error;
      }
    } else {
      // No changes needed - card is already up to date
      return false; // Indicate no update was needed
    }
  } else {
    // Create new card
    // Note: Create endpoint REQUIRES labelPublicIds and memberPublicIds as arrays
    // See: https://docs.kan.bn/api-reference/cards/create-a-card
    try {
      const card = await kanbnRequest<KanbnCard & { publicId: string }>('/cards', {
        method: 'POST',
        body: cardData,
      });
      issueCardMap.set(issueKey, card.publicId);
      console.log(`[CARD] Created #${issue.number}: ${issue.title} → ${targetListName}`);
      // Log comment count if we fetched it
      if (commentCount > 0) {
        // Comment count logged if needed - silent for now to reduce noise
      }
      return true; // Indicate card was created
    } catch (error) {
      console.error(`Failed to create card for issue #${issue.number}:`, error);
      throw error;
    }
  }
}


/**
 * Fetch comments from a GitHub issue
 */
async function fetchGitHubIssueComments(
  owner: string,
  repo: string,
  issueNumber: number
): Promise<GitHubComment[]> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
  };
  
  // Add GitHub token if provided (for higher rate limits: 5000 req/hr vs 60 req/hr)
  if (GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  }

  const comments: GitHubComment[] = [];
  let page = 1;
  const perPage = 100;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=${perPage}&page=${page}`;
    const response = await fetch(url, { headers });

    if (!response.ok) {
      // 404 means no comments, which is fine
      if (response.status === 404) {
        break;
      }
      
      // Handle rate limiting
      if (response.status === 403) {
        const errorText = await response.text();
        if (errorText.includes('rate limit')) {
          const retryAfter = response.headers.get('Retry-After');
          const xRateLimitReset = response.headers.get('X-RateLimit-Reset');
          
          let waitTime: number | null = null;
          let resetTimestamp: number | null = null;
          
          if (retryAfter) {
            waitTime = parseInt(retryAfter, 10);
            resetTimestamp = Date.now() + (waitTime * 1000);
          } else if (xRateLimitReset) {
            resetTimestamp = parseInt(xRateLimitReset, 10) * 1000;
            waitTime = Math.max(0, Math.ceil((resetTimestamp - Date.now()) / 1000));
          }
          
          if (resetTimestamp && waitTime !== null && waitTime > 0) {
            // Show the actual reset time in local timezone for easier understanding
            const resetDate = new Date(resetTimestamp);
            const resetTimeLocal = resetDate.toLocaleString('en-US', { 
              hour: 'numeric',
              minute: '2-digit',
              second: '2-digit',
              hour12: true,
              timeZoneName: 'short'
            });
            const waitMinutes = Math.ceil(waitTime / 60);
            throw new Error(`GitHub API rate limit exceeded. Rate limit resets at ${resetTimeLocal} (in ${waitMinutes} minute(s)).`);
          } else {
            const waitMinutes = 60;
            throw new Error(`GitHub API rate limit exceeded. Waiting ${waitMinutes} minute(s) before trying again.`);
          }
        }
      }
      
      const errorText = await response.text();
      throw new Error(`GitHub API error: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const pageComments = (await response.json()) as GitHubComment[];
    if (pageComments.length === 0) break;

    comments.push(...pageComments);

    if (pageComments.length < perPage) break;
    page++;
  }

  return comments;
}


/**
 * Fetch all issues from a GitHub repository (including closed for status tracking)
 */
async function fetchGitHubIssues(
  owner: string,
  repo: string,
  state: 'open' | 'closed' | 'all' = 'all'
): Promise<GitHubIssue[]> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
  };
  
  // Add GitHub token if provided (for higher rate limits: 5000 req/hr vs 60 req/hr)
  if (GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  }

  const issues: GitHubIssue[] = [];
  let page = 1;
  const perPage = 100;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const url = `https://api.github.com/repos/${owner}/${repo}/issues?state=${state}&per_page=${perPage}&page=${page}`;
    const response = await fetch(url, { headers });
    
    // Check rate limit headers before processing response
    const rateLimitRemaining = response.headers.get('X-RateLimit-Remaining');
    if (rateLimitRemaining && parseInt(rateLimitRemaining, 10) === 0) {
      // We're at the rate limit, get reset time and throw error
      const xRateLimitReset = response.headers.get('X-RateLimit-Reset');
      if (xRateLimitReset) {
        const resetTimestamp = parseInt(xRateLimitReset, 10) * 1000;
        const resetDate = new Date(resetTimestamp);
        const resetTimeLocal = resetDate.toLocaleString('en-US', { 
          hour: 'numeric',
          minute: '2-digit',
          second: '2-digit',
          hour12: true,
          timeZoneName: 'short'
        });
        const waitTime = Math.max(0, Math.ceil((resetTimestamp - Date.now()) / 1000));
        const waitMinutes = Math.ceil(waitTime / 60);
        throw new Error(`GitHub API rate limit exceeded. Rate limit resets at ${resetTimeLocal} (in ${waitMinutes} minute(s)).`);
      }
    }

    if (!response.ok) {
      const errorText = await response.text();
      
      // Handle rate limiting with helpful message
      if (response.status === 403 && errorText.includes('rate limit')) {
        // Try to get Retry-After header (seconds until reset)
        const retryAfter = response.headers.get('Retry-After');
        const xRateLimitReset = response.headers.get('X-RateLimit-Reset');
        
        let waitTime: number | null = null;
        let resetTimestamp: number | null = null;
        let waitMessage = '';
        
        if (retryAfter) {
          waitTime = parseInt(retryAfter, 10);
          resetTimestamp = Date.now() + (waitTime * 1000);
        } else if (xRateLimitReset) {
          resetTimestamp = parseInt(xRateLimitReset, 10) * 1000; // Convert to milliseconds
          waitTime = Math.max(0, Math.ceil((resetTimestamp - Date.now()) / 1000)); // Seconds until reset
        }
        
        if (resetTimestamp && waitTime !== null && waitTime > 0) {
          // Show the actual reset time in local timezone for easier understanding
          const resetDate = new Date(resetTimestamp);
          const resetTimeLocal = resetDate.toLocaleString('en-US', { 
            hour: 'numeric',
            minute: '2-digit',
            second: '2-digit',
            hour12: true,
            timeZoneName: 'short'
          });
          const waitMinutes = Math.ceil(waitTime / 60);
          waitMessage = ` Rate limit resets at ${resetTimeLocal} (in ${waitMinutes} minute(s)).`;
        } else {
          // Default to 60 minutes if we can't determine wait time
          waitMessage = ` Rate limit resets hourly. Waiting 60 minutes before trying again.`;
        }
        
        throw new Error(`GitHub API rate limit exceeded.${waitMessage}`);
      }
      
      throw new Error(`GitHub API error: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const pageIssues = (await response.json()) as GitHubIssue[];
    if (pageIssues.length === 0) break;

    // Filter out pull requests (they appear in issues endpoint)
    const actualIssues = pageIssues.filter((issue) => !issue.html_url.includes('/pull/'));
    issues.push(...actualIssues);

    if (pageIssues.length < perPage) break;
    page++;
  }

  // Issues fetched - count shown in phase 2 summary
  return issues;
}

/**
 * Get unique key for an issue
 */
function getIssueKey(repoFullName: string, issueNumber: number): string {
  return `${repoFullName}#${issueNumber}`;
}

/**
 * Sync all configured repositories
 */
async function syncAllRepositories(): Promise<void> {
  const repos = getRepositories();
  
  if (repos.length === 0) {
    console.warn('No repositories configured. Add repositories to github.repositories in config.json');
    return;
  }

  const now = new Date();
  const timeStr = now.toLocaleString('en-US', { 
    year: 'numeric', 
    month: 'short', 
    day: 'numeric', 
    hour: '2-digit', 
    minute: '2-digit', 
    second: '2-digit',
    hour12: false 
  });
  console.log(`\n[${timeStr}] Starting sync for ${repos.length} repositories...`);

  // ========================================
  // PHASE 1: SETUP - Create all boards and lists first
  // ========================================
  console.log('\n[PHASE 1] Setting up boards and lists...');
  const repoBoardMap = new Map<string, string>(); // repo -> boardId
  
  for (const repoFullName of repos) {
    try {
      const boardId = await getOrCreateBoard(repoFullName);
      await getOrCreateLists(boardId, repoFullName);
      repoBoardMap.set(repoFullName, boardId);
      console.log(`[PHASE 1] ${repoFullName}: Board and lists ready`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[PHASE 1] ERROR: Failed to setup board/lists for ${repoFullName}: ${errorMsg}`);
      // Continue with other repos even if one fails
    }
  }

  // ========================================
  // PHASE 2: SYNC - Fetch issues and sync cards
  // ========================================
  console.log('\n[PHASE 2] Syncing issues to cards...');

  for (const repoFullName of repos) {
    // Skip if board setup failed
    if (!repoBoardMap.has(repoFullName)) {
      console.warn(`[PHASE 2] WARNING: Skipping ${repoFullName} - board setup failed`);
      continue;
    }

    try {
      const [owner, repo] = repoFullName.split('/');
      if (!owner || !repo) {
        console.warn(`[PHASE 2] WARNING: Invalid repo format: ${repoFullName}`);
        continue;
      }

      console.log(`[PHASE 2] Syncing ${repoFullName}...`);
      const repositoryUrl = `https://github.com/${repoFullName}`;
      const boardId = repoBoardMap.get(repoFullName)!;
      
      // Get all existing cards from board once (much more efficient than searching per issue)
      const existingCardsMap = await getAllBoardCards(boardId, repositoryUrl);
      if (existingCardsMap.size > 0) {
        console.log(`[PHASE 2] Found ${existingCardsMap.size} existing card(s) in board`);
      }
      
      // Fetch all issues (open and closed) to track status changes
      let issues: GitHubIssue[] = [];
      try {
        issues = await fetchGitHubIssues(owner, repo, 'all');
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        if (errorMsg.includes('rate limit')) {
          // Extract wait time from error message if available
          const waitMatch = errorMsg.match(/resets at (.+?) \(/);
          if (waitMatch) {
            console.error(`[PHASE 2] GitHub API rate limit exceeded. ${errorMsg.split('rate limit exceeded.')[1]}`);
          } else {
            console.error(`[PHASE 2] ${errorMsg}`);
          }
          // Stop syncing other repos if we hit rate limit
          console.log(`[PHASE 2] Stopping sync - rate limit reached. Remaining repositories will be skipped.`);
          break; // Exit the loop, don't try other repos
        } else {
          throw error; // Re-throw non-rate-limit errors
        }
      }

      let created = 0;
      let updated = 0;
      let errors = 0;

      for (const issue of issues) {
        try {
          const issueKey = getIssueKey(repoFullName, issue.number);
          const existingCard = existingCardsMap.get(issue.number);
          const hadCard = existingCard !== undefined || issueCardMap.has(issueKey);
          
          const wasUpdated = await syncIssueCard(issue, repositoryUrl, repoFullName, existingCard);
          
          if (!hadCard) {
            created++;
          } else if (wasUpdated) {
            updated++;
          }
          // If hadCard && !wasUpdated, no change needed - don't increment either counter
          
          // Small delay between issues to avoid overwhelming the API (additional 100ms between issues on top of 650ms kanbnRequest delay)
          await new Promise(resolve => setTimeout(resolve, 100));
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          // Don't spam logs for rate limit errors if we're handling retries
          if (!errorMsg.includes('rate limit') || errorMsg.includes('after')) {
            console.error(`[PHASE 2] ERROR: Failed to sync issue #${issue.number} from ${repoFullName}: ${errorMsg}`);
          }
          errors++;
          
          // If rate limited, add extra delay before continuing
          if (errorMsg.includes('rate limit')) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
      }

      const totalChanged = created + updated;
      if (totalChanged === 0 && errors === 0) {
        console.log(`[PHASE 2] ${repoFullName}: Done syncing, updated 0 item(s)`);
      } else {
        console.log(`[PHASE 2] ${repoFullName}: ${created} created, ${updated} updated, ${errors} errors`);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      // For rate limit errors, we already logged a helpful message above
      if (!errorMsg.includes('rate limit')) {
        console.error(`[PHASE 2] ERROR: Failed to sync repository ${repoFullName}: ${errorMsg}`);
      }
    }
  }

  const completedTime = new Date();
  const completedTimeStr = completedTime.toLocaleString('en-US', { 
    year: 'numeric', 
    month: 'short', 
    day: 'numeric', 
    hour: '2-digit', 
    minute: '2-digit', 
    second: '2-digit',
    hour12: false 
  });
  
  // Calculate next sync time
  const nextSyncDate = new Date(completedTime.getTime() + SYNC_INTERVAL_MINUTES * 60 * 1000);
  const nextSyncTime = nextSyncDate.toLocaleString('en-US', { 
    year: 'numeric', 
    month: 'short', 
    day: 'numeric', 
    hour: '2-digit', 
    minute: '2-digit', 
    second: '2-digit',
    hour12: false 
  });
  
  console.log(`[SYNC] Completed at ${completedTimeStr}`);
  console.log(`[SYNC] Next sync will happen at: ${nextSyncTime}\n`);
}

// Routes

/**
 * GET /health
 */
app.get('/health', (_req: Request, res: Response) => {
  const configCheck = verifyConfig();
  const repos = getRepositories();
  
  return res.status(configCheck.valid ? 200 : 503).json({
    success: configCheck.valid,
    config: {
      hasApiKey: !!KAN_API_KEY,
      hasBaseUrl: !!KAN_BASE_URL,
      configuredRepositories: repos.length > 0 ? repos : 'none',
      repositoryCount: repos.length,
      syncIntervalMinutes: SYNC_INTERVAL_MINUTES,
      syncedCardsCount: issueCardMap.size,
    },
    errors: configCheck.errors,
    message: configCheck.valid
      ? 'KGS is properly configured'
      : 'KGS is missing required configuration',
  });
});


/**
 * POST /sync
 * Sync a single repository (if owner/repo provided) or all configured repositories
 */
app.post('/sync', async (req: Request, res: Response) => {
  try {
    const { owner, repo } = req.query;

    // If specific repo provided, sync just that one
    if (owner && repo) {
      const repoFullName = `${owner}/${repo}`;
      
      if (!isRepoConfigured(repoFullName)) {
        return res.status(400).json({
          success: false,
          error: `Repository ${repoFullName} is not configured for syncing`,
        });
      }

      console.log(`Starting sync: ${repoFullName}`);
      const repositoryUrl = `https://github.com/${repoFullName}`;
      const issues = await fetchGitHubIssues(owner as string, repo as string, 'all');

      let created = 0;
      let updated = 0;
      let errors = 0;

      // Get all existing cards from board first (for comparison)
      const boardId = await getOrCreateBoard(repoFullName);
      const existingCardsMap = await getAllBoardCards(boardId, repositoryUrl);

      for (const issue of issues) {
        try {
          const issueKey = getIssueKey(repoFullName, issue.number);
          const existingCard = existingCardsMap.get(issue.number);
          const hadCard = existingCard !== undefined || issueCardMap.has(issueKey);
          
          const wasUpdated = await syncIssueCard(issue, repositoryUrl, repoFullName, existingCard);
          
          if (!hadCard) {
            created++;
          } else if (wasUpdated) {
            updated++;
          }
          // If hadCard && !wasUpdated, no change needed - don't increment either counter
          
          // Small delay between issues to avoid overwhelming the API
          await new Promise(resolve => setTimeout(resolve, 100));
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          // Don't spam logs for rate limit errors if we're handling retries
          if (!errorMsg.includes('rate limit') || errorMsg.includes('after')) {
            console.error(`Failed to sync issue #${issue.number}`, errorMsg);
          }
          errors++;
          
          // If rate limited, add extra delay before continuing
          if (errorMsg.includes('rate limit')) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
      }

      const totalChanged = created + updated;
      if (totalChanged === 0 && errors === 0) {
        console.log(`Sync completed for ${repoFullName}: Done syncing, updated 0 item(s)`);
      } else {
        console.log(`Sync completed for ${repoFullName}: ${created} created, ${updated} updated, ${errors} errors`);
      }

      return res.status(200).json({
        success: true,
        message: 'Sync completed',
        repository: repoFullName,
        created,
        updated,
        errors,
      });
    }

    // Otherwise, trigger sync for all configured repositories
    syncAllRepositories().catch((error) => {
      console.error('Sync failed:', error);
    });

    return res.status(202).json({
      success: true,
      message: 'Sync started for all repositories',
    });
  } catch (error) {
    console.error('Failed to sync GitHub issues', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /boards
 * Get all boards (helper endpoint to discover board IDs)
 */
app.get('/boards', async (_req: Request, res: Response) => {
  try {
    // Use workspace-scoped endpoint if workspace ID is configured
    const boardsEndpoint = KAN_WORKSPACE_ID 
      ? `/workspaces/${KAN_WORKSPACE_ID}/boards`
      : '/boards';
    const boards = await kanbnRequest<Array<{ publicId: string; name: string; slug?: string }>>(
      boardsEndpoint
    );

    return res.status(200).json({
      success: true,
      boards,
    });
  } catch (error) {
    console.error('Failed to fetch Kanbn boards', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /boards/:boardPublicId/lists
 * Get all lists for a board (helper endpoint to discover list IDs)
 */
app.get('/boards/:boardPublicId/lists', async (req: Request, res: Response) => {
  try {
    const { boardPublicId } = req.params;
    const board = await kanbnRequest<{ lists: Array<{ publicId: string; name: string; position: number }> }>(
      `/boards/${boardPublicId}`
    );

    return res.status(200).json({
      success: true,
      boardId: boardPublicId,
      lists: board.lists || [],
    });
  } catch (error) {
    console.error('Failed to fetch Kanbn lists', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /labels/:boardPublicId
 * Get all labels for a board (helper endpoint)
 */
app.get('/labels/:boardPublicId', async (req: Request, res: Response) => {
  try {
    const { boardPublicId } = req.params;
    const labels = await kanbnRequest<Array<{ publicId: string; name: string; color?: string }>>(
      `/boards/${boardPublicId}/labels`
    );

    return res.status(200).json({
      success: true,
      labels,
    });
  } catch (error) {
    console.error('Failed to fetch Kanbn labels', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Initialize and start the service
async function initializeService(): Promise<void> {
  const repos = getRepositories();
  
  console.log('='.repeat(60));
  console.log('[KGS] Kanbn GitHub Sync');
  console.log('='.repeat(60));
  
  if (PORT) {
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } else {
    console.log('Running without HTTP server (polling only)');
  }
  
  console.log(`[CONFIG] Kanbn URL: ${KAN_BASE_URL || 'Not configured'}`);
  
  // Check if config.json exists
  if (!configLoaded) {
    console.log('\n[CONFIG] WARNING: Configuration file not found!');
    console.log('\n[CONFIG] Please copy the example configuration file and update it:');
    console.log('[CONFIG]   cp config/config.json.example config/config.json');
    console.log('[CONFIG]   # Then edit config/config.json with your repositories');
    console.log('\n' + '='.repeat(60));
    console.log('[KGS] Service started but not syncing. Copy and configure config/config.json to enable syncing.');
    console.log('='.repeat(60));
    return;
  }
  
  const configCheck = verifyConfig();
  
  // If configuration is invalid
  if (!configCheck.valid) {
    console.log('\n[CONFIG] WARNING: Configuration incomplete:');
    configCheck.errors.forEach((error) => {
      console.log(`   - ${error}`);
    });
    
    // If workspace ID/slug is missing, try to fetch and list available workspaces
    if (configCheck.errors.some(e => e.includes('workspace'))) {
      console.log('\n[CONFIG] Fetching available workspaces...');
      try {
        const workspaces = await fetchWorkspaces();
        if (workspaces.length > 0) {
          console.log('\n[CONFIG] Available workspaces:');
          workspaces.forEach((workspace) => {
            if (workspace.slug) {
              console.log(`   - ${workspace.name} (slug: ${workspace.slug})`);
            } else {
              console.log(`   - ${workspace.name}`);
            }
          });
          console.log('\n[CONFIG] Update config/config.json:');
          console.log('   "kanbn": {');
          console.log('     "baseUrl": "...",');
          if (workspaces[0].slug) {
            console.log(`     "workspaceUrlSlug": "${workspaces[0].slug}"`);
          } else {
            console.log(`     "workspaceUrlSlug": "${workspaces[0].publicId}"`);
          }
          console.log('   }');
        } else {
          console.log('[CONFIG]   WARNING: No workspaces found or unable to fetch workspaces.');
          console.log('   Make sure your API key has permission to list workspaces.');
        }
      } catch (error) {
        console.log(`[CONFIG]   WARNING: Failed to fetch workspaces: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }
    
    console.log('\n' + '='.repeat(60));
    console.log('[KGS] Service started but not syncing. Fix configuration errors above.');
    console.log('='.repeat(60));
    return;
  }
  
  // Resolve workspace ID from URL slug (with retries for 500 errors)
  console.log(`\n[CONFIG] Resolving workspace URL slug "${KAN_WORKSPACE_URL_SLUG}" to ID...`);
  let resolvedId: string | null = null;
  let workspaceResolved = false;
  const maxWorkspaceRetries = 5;
  
  for (let attempt = 0; attempt < maxWorkspaceRetries; attempt++) {
    try {
      resolvedId = await resolveWorkspaceId();
      if (resolvedId) {
        workspaceResolved = true;
        break;
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      // Retry on 500 errors (likely rate limiting)
      if (errorMsg.includes('500 Internal Server Error') && attempt < maxWorkspaceRetries - 1) {
        const backoffMs = Math.pow(2, attempt) * 1000;
        console.warn(`[CONFIG] Server error (likely rate limited), retrying in ${backoffMs / 1000}s... (attempt ${attempt + 1}/${maxWorkspaceRetries})`);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        continue;
      }
      // For other errors or final attempt, break and show error
      break;
    }
  }
  
  if (workspaceResolved && resolvedId) {
    KAN_WORKSPACE_ID = resolvedId;
    console.log(`[CONFIG] Resolved workspace: ${KAN_WORKSPACE_URL_SLUG} → ${KAN_WORKSPACE_ID}`);
  } else {
    console.log(`[CONFIG] ERROR: Failed to resolve workspace URL slug "${KAN_WORKSPACE_URL_SLUG}"`);
    // Try to fetch workspaces list (with retries)
    let workspaces: Array<{ publicId: string; name: string; slug?: string }> = [];
    for (let attempt = 0; attempt < maxWorkspaceRetries; attempt++) {
      try {
        workspaces = await fetchWorkspaces();
        if (workspaces.length > 0) break;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        if (errorMsg.includes('500 Internal Server Error') && attempt < maxWorkspaceRetries - 1) {
          const backoffMs = Math.pow(2, attempt) * 1000;
          await new Promise(resolve => setTimeout(resolve, backoffMs));
          continue;
        }
        break;
      }
    }
    
    if (workspaces.length > 0) {
      console.log('\n[CONFIG] Available workspaces:');
      workspaces.forEach((workspace) => {
        const currentMarker = workspace.slug === KAN_WORKSPACE_URL_SLUG 
          ? ' ← (currently configured)' : '';
        if (workspace.slug) {
          console.log(`[CONFIG]   - ${workspace.name} (slug: ${workspace.slug})${currentMarker}`);
        } else {
          console.log(`[CONFIG]   - ${workspace.name}${currentMarker}`);
        }
      });
      console.log('[CONFIG] Update config/config.json with a valid workspaceUrlSlug from the list above.');
    }
    console.log('\n' + '='.repeat(60));
    console.log('[KGS] Service started but not syncing. Fix workspace configuration above.');
    console.log('='.repeat(60));
    return;
  }
  
  // Validate workspace slug (double-check after resolution, with retries)
  let workspaceValidation: { valid: boolean; workspaces: Array<{ publicId: string; name: string; slug?: string }>; resolvedId?: string } = { valid: false, workspaces: [] };
  let validationRetries = 0;
  const maxValidationRetries = 5;
  
  while (validationRetries < maxValidationRetries) {
    try {
      workspaceValidation = await validateWorkspaceId();
      if (workspaceValidation.valid && workspaceValidation.resolvedId) {
        break; // Validation successful
      }
      // If invalid but no 500 error, don't retry
      if (!workspaceValidation.valid) {
        break;
      }
      // If we got here and valid is false, increment and retry (unlikely but safe)
      validationRetries++;
      if (validationRetries >= maxValidationRetries) break;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      // Retry on 500 errors only
      if (errorMsg.includes('500 Internal Server Error') && validationRetries < maxValidationRetries - 1) {
        const backoffMs = Math.pow(2, validationRetries) * 1000;
        console.warn(`[CONFIG] Server error during validation (likely rate limited), retrying in ${backoffMs / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        validationRetries++;
        continue;
      }
      // For other errors, use empty validation result
      workspaceValidation = { valid: false, workspaces: [] };
      break;
    }
  }
  
  if (!workspaceValidation.valid || !workspaceValidation.resolvedId) {
    console.log('\n[CONFIG] WARNING: Invalid workspace slug configured!');
    console.log(`   Current workspace URL slug: ${KAN_WORKSPACE_URL_SLUG}`);
    if (workspaceValidation.workspaces.length > 0) {
      console.log('\n[CONFIG] Available workspaces:');
      workspaceValidation.workspaces.forEach((workspace) => {
        const currentMarker = workspace.slug === KAN_WORKSPACE_URL_SLUG 
          ? ' ← (currently configured)' : '';
        if (workspace.slug) {
          console.log(`   - ${workspace.name} (slug: ${workspace.slug})${currentMarker}`);
        } else {
          console.log(`   - ${workspace.name}${currentMarker}`);
        }
      });
      console.log('[CONFIG] Update config/config.json with a valid workspaceUrlSlug from the list above.');
    } else {
      console.log('[CONFIG]   WARNING: Unable to fetch available workspaces. Please check your API key permissions.');
    }
    console.log('\n' + '='.repeat(60));
    console.log('[KGS] Service started but not syncing. Fix workspace configuration above.');
    console.log('='.repeat(60));
    return;
  }
  
  // Ensure workspace ID is set from resolved ID
  if (workspaceValidation.resolvedId) {
    KAN_WORKSPACE_ID = workspaceValidation.resolvedId;
  }
  
  // Configuration is valid, proceed with normal startup
  if (configuredInterval < MIN_SYNC_INTERVAL_MINUTES && !GITHUB_TOKEN) {
    console.warn(`\n[CONFIG] WARNING: Sync interval is ${configuredInterval} minute(s), but minimum is ${MIN_SYNC_INTERVAL_MINUTES} minutes to avoid GitHub API rate limits (60 requests/hour unauthenticated).`);
    console.warn(`[CONFIG] Using ${MIN_SYNC_INTERVAL_MINUTES} minutes instead.`);
    console.warn(`[CONFIG] Tip: Set GITHUB_TOKEN in .env for higher rate limits (5000 requests/hour) to use shorter intervals.\n`);
  } else if (configuredInterval < MIN_SYNC_INTERVAL_MINUTES && GITHUB_TOKEN) {
    console.log(`\n[CONFIG] Sync interval is ${configuredInterval} minute(s). Using GitHub token for higher rate limits (5000 requests/hour).\n`);
  }
  
  console.log(`[CONFIG] Sync interval: ${SYNC_INTERVAL_MINUTES} minutes${GITHUB_TOKEN ? ' (with GitHub token - 5000 req/hr)' : ' (unauthenticated - 60 req/hr)'}`);
  if (repos.length > 0) {
    console.log(`[CONFIG] Configured repositories (${repos.length}):`);
    repos.forEach((repo) => {
      const boardName = getBoardName(repo);
      const customNameNote = boardName !== repo.replace('/', ' - ') ? ` → "${boardName}"` : '';
      console.log(`[CONFIG]   - ${repo}${customNameNote} (boards and lists will be created automatically)`);
    });
  } else {
    console.log('[CONFIG] WARNING: No repositories configured. Add repositories to github.repositories in config.json');
  }
  console.log('='.repeat(60));

  // Start initial sync (with rate limit handling)
  syncAllRepositories().catch((error) => {
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (errorMsg.includes('rate limit')) {
      // Extract reset time from error message
      const resetMatch = errorMsg.match(/resets at (.+?) \(/);
      if (resetMatch) {
        console.warn(`\n[SYNC] WARNING: Initial sync skipped due to GitHub API rate limit.`);
        console.warn(`   ${errorMsg.split('rate limit exceeded.')[1]}`);
        console.warn(`   The service will automatically retry on the next scheduled sync (in ${SYNC_INTERVAL_MINUTES} minutes).\n`);
      } else {
        console.warn(`\n[SYNC] WARNING: Initial sync skipped due to GitHub API rate limit.`);
        console.warn(`   The service will automatically retry on the next scheduled sync (in ${SYNC_INTERVAL_MINUTES} minutes).\n`);
      }
    } else {
      console.error('Initial sync failed:', error);
    }
  });

  // Set up polling interval
  startSyncInterval();
  
  // Calculate and display next sync time
  const nextSyncDate = new Date(Date.now() + SYNC_INTERVAL_MINUTES * 60 * 1000);
  const nextSyncTime = nextSyncDate.toLocaleString('en-US', { 
    year: 'numeric', 
    month: 'short', 
    day: 'numeric', 
    hour: '2-digit', 
    minute: '2-digit', 
    second: '2-digit',
    hour12: false 
  });

  console.log(`[SYNC] Polling started - will sync every ${SYNC_INTERVAL_MINUTES} minutes`);
  console.log(`[SYNC] Next sync will happen at: ${nextSyncTime}`);
  const listNames = getListNames();
  console.log('[SYNC] Issues are automatically assigned to lists based on status:');
  console.log(`[SYNC]   • Closed → ${listNames.COMPLETED}`);
  console.log(`[SYNC]   • Has branch/PR → ${listNames.IN_PROGRESS}`);
  console.log(`[SYNC]   • Assigned → ${listNames.SELECTED}`);
  console.log(`[SYNC]   • Otherwise → ${listNames.BACKLOG}`);
  
  // Set up config file watching for hot reload
  if (configPath) {
    setupConfigWatcher();
  }
}

// Start the service
initializeService().catch((error) => {
  console.error('Failed to initialize service:', error);
  process.exit(1);
});

/**
 * Reload configuration from config.json
 */
async function reloadConfig(): Promise<void> {
  console.log('\n[CONFIG] Reloading configuration...');
  
  const oldWorkspaceUrlSlug = KAN_WORKSPACE_URL_SLUG;
  const oldSyncInterval = SYNC_INTERVAL_MINUTES;
  
  // Reload config file
  const reloadResult = loadConfig();
  if (!reloadResult.success) {
    console.error(`[CONFIG] ERROR: Failed to reload config: ${reloadResult.error}`);
    return;
  }
  
  // Update configuration variables
  KAN_BASE_URL = config.kanbn?.baseUrl || '';
  KAN_WORKSPACE_URL_SLUG = config.kanbn?.workspaceUrlSlug || '';
  const newConfiguredInterval = config.sync?.intervalMinutes || 1;
  const newSyncInterval = newConfiguredInterval < MIN_SYNC_INTERVAL_MINUTES && !GITHUB_TOKEN
    ? MIN_SYNC_INTERVAL_MINUTES
    : newConfiguredInterval;
  
  // Check if workspace URL slug changed
  if (KAN_WORKSPACE_URL_SLUG !== oldWorkspaceUrlSlug) {
    console.log(`   Workspace URL slug changed: ${oldWorkspaceUrlSlug || 'none'} → ${KAN_WORKSPACE_URL_SLUG}`);
    
    // Clear workspace-related caches
    repoBoardCache.clear();
    repoListCache.clear();
    labelCache.clear();
    
    // Re-resolve workspace ID
    const resolvedId = await resolveWorkspaceId();
    if (resolvedId) {
      KAN_WORKSPACE_ID = resolvedId;
      console.log(`[CONFIG] Resolved workspace: ${KAN_WORKSPACE_URL_SLUG} → ${KAN_WORKSPACE_ID}`);
    } else {
      console.error(`[CONFIG] ERROR: Failed to resolve workspace URL slug "${KAN_WORKSPACE_URL_SLUG}"`);
      return;
    }
  }
  
  // Check if sync interval changed
  if (newSyncInterval !== oldSyncInterval) {
    console.log(`   Sync interval changed: ${oldSyncInterval} → ${newSyncInterval} minutes`);
    SYNC_INTERVAL_MINUTES = newSyncInterval;
    startSyncInterval();
    
    // Calculate and display next sync time
    const nextSyncDate = new Date(Date.now() + SYNC_INTERVAL_MINUTES * 60 * 1000);
    const nextSyncTime = nextSyncDate.toLocaleString('en-US', { 
      year: 'numeric', 
      month: 'short', 
      day: 'numeric', 
      hour: '2-digit', 
      minute: '2-digit', 
      second: '2-digit',
      hour12: false 
    });
    
    console.log(`[CONFIG] Sync interval updated to ${SYNC_INTERVAL_MINUTES} minutes`);
    console.log(`[CONFIG] Next sync will happen at: ${nextSyncTime}`);
  }
  
  // Clear board name cache if repositories changed
  repoBoardNames.clear();
  getRepositories(); // Re-populate board names cache
  
  console.log('[CONFIG] Configuration reloaded successfully');
}

/**
 * Set up file watcher for config.json
 */
function setupConfigWatcher(): void {
  if (!configPath) return;
  
  let reloadTimeout: ReturnType<typeof setTimeout> | null = null;
  let lastModified: number = 0;
  
  // Use watchFile for more reliable file watching (polls file stats)
  // This works better than watch() on some file systems and with certain editors
  watchFile(configPath, { interval: 1000 }, (curr, prev) => {
    // Check if file was actually modified (mtime changed)
    if (curr.mtimeMs !== prev.mtimeMs && curr.mtimeMs !== lastModified) {
      lastModified = curr.mtimeMs;
      
      // Debounce rapid file changes (wait 500ms after last change)
      if (reloadTimeout) {
        clearTimeout(reloadTimeout);
      }
      
      reloadTimeout = setTimeout(async () => {
        try {
          await reloadConfig();
        } catch (error) {
          console.error('Error reloading config:', error);
        }
      }, 500);
    }
  });
  
  console.log(`\n[CONFIG] Watching config file for changes: ${configPath}`);
  console.log('[CONFIG] Configuration will reload automatically when you save config.json');
}
