/**
 * Kanbn API client
 */

import fetch from 'node-fetch';
import {
  getKanBaseUrl,
  getKanWorkspaceId,
  getListNames,
  getBoardName,
  KAN_API_KEY,
} from './config';
import type { GitHubIssue, KanbnCard } from './types';

// Rate limiting: track last request time and enforce minimum delay between requests
// Kanbn API rate limit: 100 requests per minute = 600ms between requests
// Using 650ms to stay safely under the limit with some buffer
let lastRequestTime = 0;
const MIN_REQUEST_DELAY_MS = 650; // ~92 requests/minute (safely under Kanbn's 100 req/min limit)

// Cache for repo -> board/list IDs
const repoBoardCache = new Map<string, string>(); // repo -> boardId
const repoListCache = new Map<string, Map<string, string>>(); // repo -> (listName -> listId)

// Cache for label lookups (boardId -> label name -> labelId)
const labelCache = new Map<string, Map<string, string>>();

/**
 * Make authenticated request to Kanbn API with rate limiting and retry logic
 */
export async function kanbnRequest<T>(
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

  const KAN_BASE_URL = getKanBaseUrl();

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
        console.warn(`[KANBN API] ${errorType} hit. Waiting ${waitSeconds}s (${Math.round(waitMinutes * 10) / 10} minute) before retry... (attempt ${retryCount + 1}/${maxRetries})`);
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

/**
 * Fetch available workspaces from Kanbn
 */
export async function fetchWorkspaces(): Promise<Array<{ publicId: string; name: string; slug?: string }>> {
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
 * Fetch workspace by slug (by searching in all workspaces)
 */
export async function fetchWorkspaceBySlug(slug: string): Promise<{ publicId: string; name: string; slug?: string } | null> {
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
 * Get or ensure board exists for a repository (create if needed)
 * Prevents duplicates by always checking for existing boards first
 */
export async function getOrCreateBoard(repoFullName: string): Promise<string> {
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
  const KAN_WORKSPACE_ID = getKanWorkspaceId();
  
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
    const KAN_BASE_URL = getKanBaseUrl();
    
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
export async function getOrCreateLists(boardId: string, repoFullName: string): Promise<Map<string, string>> {
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
export function determineListForIssue(issue: GitHubIssue): string {
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
export async function fetchBoardLabels(boardId: string): Promise<void> {
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
export async function getOrCreateLabel(boardId: string, labelName: string, labelColor?: string): Promise<string | null> {
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
export async function mapLabels(githubLabels: GitHubIssue['labels'], boardId: string): Promise<string[]> {
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
export async function getAllBoardCards(
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
              const titlePrefixMatch = card.title.match(/^[[#]?(\d+)[\]:\s-]/);
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
              // Match pattern: "#123" anywhere in title
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
              cardMap.set(issueNumber, {
                publicId: card.publicId,
                title: card.title,
                description: card.description,
                listPublicId: card.listPublicId,
              });
            }
          }
        }
      }
    }
    
    // Cache labels we found
    if (labelsMap.size > 0) {
      labelCache.set(boardId, labelsMap);
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.warn(`Failed to fetch cards for board ${boardId}: ${errorMsg}`);
  }
  
  return cardMap;
}

/**
 * Create or update a card in Kanbn from a GitHub issue
 */
export async function syncIssueCard(
  issue: GitHubIssue,
  repositoryUrl: string,
  repoFullName: string,
  existingCard?: { publicId: string; title: string; description?: string; listPublicId: string }
): Promise<boolean> {
  const boardId = await getOrCreateBoard(repoFullName);
  const listMap = await getOrCreateLists(boardId, repoFullName);
  
  // Determine which list this issue should be in
  const targetListName = determineListForIssue(issue);
  const targetListId = listMap.get(targetListName);
  
  if (!targetListId) {
    throw new Error(`List "${targetListName}" not found for board ${boardId}`);
  }
  
  // Map GitHub labels to Kanbn labels
  const labelIds = await mapLabels(issue.labels, boardId);
  
  // Build card description with GitHub link and metadata
  const descriptionParts: string[] = [];
  descriptionParts.push(`GitHub Issue: ${issue.html_url}`);
  if (issue.user) {
    descriptionParts.push(`\nCreated by: [${issue.user.login}](${issue.user.html_url})`);
  }
  if (issue.assignees && issue.assignees.length > 0) {
    const assigneeLinks = issue.assignees.map(a => `[${a.login}](https://github.com/${a.login})`).join(', ');
    descriptionParts.push(`\nAssigned to: ${assigneeLinks}`);
  }
  if (issue.body) {
    descriptionParts.push(`\n\n---\n\n${issue.body}`);
  }
  const description = descriptionParts.join('');
  
  // Prefix title with issue number for reliable matching
  const cardTitle = `#${issue.number}: ${issue.title}`;
  
  // Check if card needs updating
  const existingCardId = existingCard?.publicId;
  const needsUpdate = !existingCard || 
    existingCard.title !== cardTitle ||
    existingCard.description !== description ||
    existingCard.listPublicId !== targetListId;
  
  if (!needsUpdate && existingCard) {
    // Card exists and is up to date - no changes needed
    return false;
  }
  
  if (existingCardId) {
    // Update existing card
    try {
      await kanbnRequest<KanbnCard>(`/cards/${existingCardId}`, {
        method: 'PATCH',
        body: {
          title: cardTitle,
          description: description,
          listPublicId: targetListId,
          labelPublicIds: labelIds,
        },
      });
      
      // Log what changed
      if (existingCard.title !== cardTitle) {
        console.log(`[CARD] Updated title for issue #${issue.number} in ${repoFullName}`);
      }
      if (existingCard.description !== description) {
        console.log(`[CARD] Updated description for issue #${issue.number} in ${repoFullName}`);
      }
      if (existingCard.listPublicId !== targetListId) {
        const oldListName = Array.from(listMap.entries()).find(([_, id]) => id === existingCard.listPublicId)?.[0] || 'unknown';
        console.log(`[CARD] Moved issue #${issue.number} in ${repoFullName} from "${oldListName}" to "${targetListName}"`);
      }
      
      return true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`Failed to update card for issue #${issue.number}: ${errorMsg}`);
      throw error;
    }
  } else {
    // Create new card
    try {
      const card = await kanbnRequest<KanbnCard & { publicId: string }>('/cards', {
        method: 'POST',
        body: {
          title: cardTitle,
          description: description,
          listPublicId: targetListId,
          position: 'end',
          labelPublicIds: labelIds,
        },
      });
      
      console.log(`[CARD] Created card for issue #${issue.number} in ${repoFullName}: ${card.publicId}`);
      return true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`Failed to create card for issue #${issue.number}: ${errorMsg}`);
      throw error;
    }
  }
}
