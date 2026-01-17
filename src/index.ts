#!/usr/bin/env node

/**
 * Kanbn GitHub Sync (KGS)
 * Automatically syncs GitHub issues to Kanbn cards via polling
 */

import dotenv from 'dotenv';
import express, { Request, Response } from 'express';
import fetch from 'node-fetch';
import { readFileSync } from 'fs';
import { join } from 'path';

// Load environment variables (for secrets)
dotenv.config();

// Load configuration from config.json
interface Config {
  kanbn?: {
    baseUrl?: string;
  };
  github?: {
    repositories?: string[]; // Array of "owner/repo" strings
  };
  sync?: {
    intervalMinutes?: number;
  };
  server?: {
    port?: number;
  };
}

let config: Config = {};
let configLoaded = false;
try {
  // Try config/ directory first, then root for backward compatibility
  const configPath = join(process.cwd(), 'config/config.json');
  let configFile: string;
  try {
    configFile = readFileSync(configPath, 'utf-8');
  } catch {
    // Fallback to root directory
    const rootConfigPath = join(process.cwd(), 'config.json');
    configFile = readFileSync(rootConfigPath, 'utf-8');
  }
  config = JSON.parse(configFile);
  configLoaded = true;
  console.log('✅ Loaded configuration from config.json');
} catch (error) {
  // config.json doesn't exist or is invalid
  configLoaded = false;
}

const app = express();

// Configuration (secrets from .env, config from config.json)
const KAN_API_KEY = process.env.KAN_API_KEY || '';
const KAN_BASE_URL = config.kanbn?.baseUrl || '';
const SYNC_INTERVAL_MINUTES = config.sync?.intervalMinutes || 1;
const PORT = config.server?.port || 3001;

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

// Standard list names
const LIST_NAMES = {
  BACKLOG: '📝 Backlog',
  SELECTED: '✨ Selected',
  IN_PROGRESS: '⚙️ In Progress',
  COMPLETED: '🎉 Completed/Closed',
} as const;

/**
 * Get list of configured repositories
 */
function getRepositories(): string[] {
  return config.github?.repositories || [];
}

/**
 * Check if a repository is configured
 */
function isRepoConfigured(repoFullName: string): boolean {
  return getRepositories().includes(repoFullName);
}

/**
 * Verify configuration
 */
function verifyConfig(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!KAN_API_KEY) errors.push('KAN_API_KEY is required');
  if (!KAN_BASE_URL) errors.push('kanbn.baseUrl is required in config.json');
  
  const repos = getRepositories();
  if (repos.length === 0) {
    errors.push('github.repositories is required in config.json (array of "owner/repo" strings)');
  }
  
  return { valid: errors.length === 0, errors };
}

/**
 * Make authenticated request to Kanbn API
 */
async function kanbnRequest<T>(
  endpoint: string,
  options: { method?: string; body?: unknown } = {}
): Promise<T> {
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

  const response = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Kanbn API error: ${response.status} ${response.statusText} - ${errorText}`);
  }

  return response.json() as Promise<T>;
}

// Cache for label lookups (boardId -> label name -> labelId)
const labelCache = new Map<string, Map<string, string>>();

// Track issue number -> card ID mapping (repo#issue -> cardId)
const issueCardMap = new Map<string, string>(); // "owner/repo#123" -> "card_abc"

/**
 * Get or ensure board exists for a repository (create if needed)
 */
async function getOrCreateBoard(repoFullName: string): Promise<string> {
  // Check cache first
  if (repoBoardCache.has(repoFullName)) {
    return repoBoardCache.get(repoFullName)!;
  }

  // Try to find existing board by name (sanitized repo name)
  const boardName = repoFullName.replace('/', ' - ');
  try {
    const boards = await kanbnRequest<Array<{ publicId: string; name: string }>>('/boards');
    const existingBoard = boards.find((b) => b.name === boardName);
    if (existingBoard) {
      repoBoardCache.set(repoFullName, existingBoard.publicId);
      return existingBoard.publicId;
    }
  } catch (error) {
    console.warn(`Failed to search for existing board for ${repoFullName}:`, error);
  }

  // Board doesn't exist, create it
  try {
    const newBoard = await kanbnRequest<{ publicId: string; name: string }>('/boards', {
      method: 'POST',
      body: {
        name: boardName,
      },
    });
    repoBoardCache.set(repoFullName, newBoard.publicId);
    console.log(`✅ Created board for ${repoFullName}: ${newBoard.publicId}`);
    return newBoard.publicId;
  } catch (error) {
    throw new Error(`Failed to create board for ${repoFullName}: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
  const listOrder = [LIST_NAMES.BACKLOG, LIST_NAMES.SELECTED, LIST_NAMES.IN_PROGRESS, LIST_NAMES.COMPLETED];
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
      console.log(`✅ Created list "${listName}" for board ${boardId}: ${newList.publicId}`);
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
  // Closed issues go to Completed
  if (issue.state === 'closed') {
    return LIST_NAMES.COMPLETED;
  }

  // Issues with associated PR (branch) go to In Progress
  if (issue.pull_request && issue.pull_request.url) {
    return LIST_NAMES.IN_PROGRESS;
  }

  // Assigned issues go to Selected
  if (issue.assignees && issue.assignees.length > 0) {
    return LIST_NAMES.SELECTED;
  }

  // Everything else goes to Backlog
  return LIST_NAMES.BACKLOG;
}

/**
 * Get or create a Kanbn label by name
 */
async function getOrCreateLabel(boardId: string, labelName: string, labelColor?: string): Promise<string | null> {
  // Check cache first
  const boardCache = labelCache.get(boardId);
  if (boardCache?.has(labelName)) {
    return boardCache.get(labelName) || null;
  }

  try {
    // Fetch all labels for the board
    const labels = await kanbnRequest<Array<{ publicId: string; name: string; color?: string }>>(
      `/boards/${boardId}/labels`
    );

    // Initialize cache for this board if needed
    if (!boardCache) {
      labelCache.set(boardId, new Map());
    }
    const cache = labelCache.get(boardId)!;

    // Look for existing label by name
    const existingLabel = labels.find((l) => l.name.toLowerCase() === labelName.toLowerCase());
    if (existingLabel) {
      cache.set(labelName, existingLabel.publicId);
      return existingLabel.publicId;
    }

    // Label doesn't exist, create it
    try {
      const newLabel = await kanbnRequest<{ publicId: string; name: string }>(`/boards/${boardId}/labels`, {
        method: 'POST',
        body: {
          name: labelName,
          color: labelColor || '#808080', // Default gray if no color provided
        },
      });

      cache.set(labelName, newLabel.publicId);
      console.log(`✅ Created new label: ${labelName} (${newLabel.publicId})`);
      return newLabel.publicId;
    } catch (error) {
      console.warn(`Failed to create label "${labelName}":`, error);
      return null;
    }
  } catch (error) {
    console.error(`Failed to fetch labels for board ${boardId}:`, error);
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
 * Create or update a card in Kanbn from a GitHub issue
 */
async function syncIssueCard(
  issue: GitHubIssue,
  repositoryUrl: string,
  repoFullName: string
): Promise<void> {
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

  // Check if card already exists
  const issueKey = getIssueKey(repoFullName, issue.number);
  const existingCardId = issueCardMap.get(issueKey);

  const githubUrl = `${repositoryUrl}/issues/${issue.number}`;
  let description = issue.body || 'No description provided.';
  description += `\n\n---\n🔗 [View on GitHub](${githubUrl}) | Issue #${issue.number}`;

  // Map labels
  const labelIds = await mapLabels(issue.labels, boardId);

  const cardData: Partial<KanbnCard> = {
    title: issue.title,
    description,
    listPublicId: targetListId,
    position: 'end',
    ...(labelIds.length > 0 && { labelPublicIds: labelIds }),
  };

  if (existingCardId) {
    // Update existing card (including moving to correct list)
    try {
      await kanbnRequest<KanbnCard>(`/cards/${existingCardId}`, {
        method: 'PUT',
        body: cardData,
      });
      console.log(`✅ Updated card for issue #${issue.number}: ${issue.title} → ${targetListName}`);
    } catch (error) {
      console.error(`Failed to update card for issue #${issue.number}:`, error);
      throw error;
    }
  } else {
    // Create new card
    try {
      const card = await kanbnRequest<KanbnCard & { publicId: string }>('/cards', {
        method: 'POST',
        body: cardData as KanbnCard,
      });
      issueCardMap.set(issueKey, card.publicId);
      console.log(`✅ Created card for issue #${issue.number}: ${issue.title} → ${targetListName}`);
    } catch (error) {
      console.error(`Failed to create card for issue #${issue.number}:`, error);
      throw error;
    }
  }
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

  const issues: GitHubIssue[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const url = `https://api.github.com/repos/${owner}/${repo}/issues?state=${state}&per_page=${perPage}&page=${page}`;
    const response = await fetch(url, { headers });

    if (!response.ok) {
      const errorText = await response.text();
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

  console.log(`Fetched ${issues.length} issues from ${owner}/${repo}`);
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

  console.log(`\n[${new Date().toISOString()}] Starting sync for ${repos.length} repositories...`);

  for (const repoFullName of repos) {
    try {
      const [owner, repo] = repoFullName.split('/');
      if (!owner || !repo) {
        console.warn(`Invalid repo format: ${repoFullName}`);
        continue;
      }

      console.log(`Syncing ${repoFullName}...`);
      const repositoryUrl = `https://github.com/${repoFullName}`;
      // Fetch all issues (open and closed) to track status changes
      const issues = await fetchGitHubIssues(owner, repo, 'all');

      let created = 0;
      let updated = 0;
      let errors = 0;

      for (const issue of issues) {
        try {
          const issueKey = getIssueKey(repoFullName, issue.number);
          const hadCard = issueCardMap.has(issueKey);
          
          await syncIssueCard(issue, repositoryUrl, repoFullName);
          
          if (hadCard) {
            updated++;
          } else {
            created++;
          }
        } catch (error) {
          console.error(`Failed to sync issue #${issue.number} from ${repoFullName}`, error);
          errors++;
        }
      }

      console.log(`✅ ${repoFullName}: ${created} created, ${updated} updated, ${errors} errors`);
    } catch (error) {
      console.error(`Failed to sync repository ${repoFullName}`, error);
    }
  }

  console.log(`Sync completed at ${new Date().toISOString()}\n`);
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

      for (const issue of issues) {
        try {
          const issueKey = getIssueKey(repoFullName, issue.number);
          const hadCard = issueCardMap.has(issueKey);
          
          await syncIssueCard(issue, repositoryUrl, repoFullName);
          
          if (hadCard) {
            updated++;
          } else {
            created++;
          }
        } catch (error) {
          console.error(`Failed to sync issue #${issue.number}`, error);
          errors++;
        }
      }

      console.log(`Sync completed for ${repoFullName}: ${created} created, ${updated} updated, ${errors} errors`);

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
    const boards = await kanbnRequest<Array<{ publicId: string; name: string; slug?: string }>>(
      '/boards'
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

// Start server
app.listen(PORT, async () => {
  const repos = getRepositories();
  
  console.log('='.repeat(60));
  console.log('Kanbn GitHub Sync (KGS)');
  console.log('='.repeat(60));
  console.log(`Server running on port ${PORT}`);
  console.log(`Kanbn URL: ${KAN_BASE_URL || 'Not configured'}`);
  
  // Check if config.json exists
  if (!configLoaded) {
    console.log('\n⚠️  Configuration file not found!');
    console.log('\n📋 Please copy the example configuration file and update it:');
    console.log('   cp config/config.json.example config/config.json');
    console.log('   # Then edit config/config.json with your repositories');
    console.log('\n' + '='.repeat(60));
    console.log('⏸️  Service started but not syncing. Copy and configure config/config.json to enable syncing.');
    console.log('='.repeat(60));
    return;
  }
  
  const configCheck = verifyConfig();
  
  // If configuration is invalid
  if (!configCheck.valid) {
    console.log('\n⚠️  Configuration incomplete:');
    configCheck.errors.forEach((error) => {
      console.log(`   - ${error}`);
    });
    console.log('\n' + '='.repeat(60));
    console.log('⏸️  Service started but not syncing. Fix configuration errors above.');
    console.log('='.repeat(60));
    return;
  }
  
  // Configuration is valid, proceed with normal startup
  console.log(`Sync interval: ${SYNC_INTERVAL_MINUTES} minutes`);
  if (repos.length > 0) {
    console.log(`Configured repositories (${repos.length}):`);
    repos.forEach((repo) => {
      console.log(`  - ${repo} (boards and lists will be created automatically)`);
    });
  } else {
    console.log('⚠️  No repositories configured. Add repositories to github.repositories in config.json');
  }
  console.log('='.repeat(60));

  // Start initial sync
  syncAllRepositories().catch((error) => {
    console.error('Initial sync failed:', error);
  });

  // Set up polling interval
  const intervalMs = SYNC_INTERVAL_MINUTES * 60 * 1000;
  setInterval(() => {
    syncAllRepositories().catch((error) => {
      console.error('Scheduled sync failed:', error);
    });
  }, intervalMs);

  console.log(`✅ Polling started - will sync every ${SYNC_INTERVAL_MINUTES} minutes`);
  console.log('   Issues are automatically assigned to lists based on status:');
  console.log('   • Closed → 🎉 Completed/Closed');
  console.log('   • Has branch/PR → ⚙️ In Progress');
  console.log('   • Assigned → ✨ Selected');
  console.log('   • Otherwise → 📝 Backlog');
});
