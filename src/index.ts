#!/usr/bin/env node

/**
 * Kanbn GitHub Sync (KGS)
 * Automatically syncs GitHub issues to Kanbn cards via polling
 */

import {
  loadConfig,
  isConfigLoaded,
  verifyConfig,
  getRepositories,
  getBoardName,
  getSyncIntervalMinutes,
  getKanBaseUrl,
  getKanWorkspaceUrlSlug,
  setKanWorkspaceId,
  getListNames,
  setupConfigWatcher,
  MIN_SYNC_INTERVAL_MINUTES,
  GITHUB_TOKEN,
} from './config';
import {
  fetchWorkspaces,
  fetchWorkspaceBySlug,
} from './kanbn';
import { syncAllRepositories } from './sync';

// Initial config load
const initialLoad = loadConfig();
if (initialLoad.success) {
  console.log('[CONFIG] Loaded configuration from config.json');
}

// Debug: Log if GitHub token is detected (masked for security)
if (GITHUB_TOKEN) {
  const maskedToken = GITHUB_TOKEN.substring(0, 10) + '...' + GITHUB_TOKEN.substring(GITHUB_TOKEN.length - 4);
  console.log(`[CONFIG] GitHub token detected: ${maskedToken} (5000 requests/hour)`);
} else {
  console.log('[CONFIG] No GitHub token found - using unauthenticated API (60 requests/hour)');
}

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
  
  const SYNC_INTERVAL_MINUTES = getSyncIntervalMinutes();
  const intervalMs = SYNC_INTERVAL_MINUTES * 60 * 1000;
  syncIntervalTimer = setInterval(() => {
    syncAllRepositories().catch((error) => {
      console.error('Scheduled sync failed:', error);
    });
  }, intervalMs);
}

/**
 * Resolve workspace slug to workspace ID
 */
async function resolveWorkspaceId(): Promise<string | null> {
  const KAN_WORKSPACE_URL_SLUG = getKanWorkspaceUrlSlug();
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
 * Reload configuration from config.json
 */
async function reloadConfig(): Promise<void> {
  console.log('\n[CONFIG] Reloading configuration...');
  
  const oldWorkspaceUrlSlug = getKanWorkspaceUrlSlug();
  const oldSyncInterval = getSyncIntervalMinutes();
  
  // Reload config file
  const reloadResult = loadConfig();
  if (!reloadResult.success) {
    console.error(`[CONFIG] ERROR: Failed to reload config: ${reloadResult.error}`);
    return;
  }
  
  const newConfiguredInterval = getSyncIntervalMinutes();
  const newSyncInterval = newConfiguredInterval < MIN_SYNC_INTERVAL_MINUTES && !GITHUB_TOKEN
    ? MIN_SYNC_INTERVAL_MINUTES
    : newConfiguredInterval;
  
  // Check if workspace URL slug changed
  const KAN_WORKSPACE_URL_SLUG = getKanWorkspaceUrlSlug();
  if (KAN_WORKSPACE_URL_SLUG !== oldWorkspaceUrlSlug) {
    console.log(`   Workspace URL slug changed: ${oldWorkspaceUrlSlug || 'none'} → ${KAN_WORKSPACE_URL_SLUG}`);
    
    // Re-resolve workspace ID
    const resolvedId = await resolveWorkspaceId();
    if (resolvedId) {
      setKanWorkspaceId(resolvedId);
      console.log(`[CONFIG] Resolved workspace: ${KAN_WORKSPACE_URL_SLUG} → ${resolvedId}`);
    } else {
      console.error(`[CONFIG] ERROR: Failed to resolve workspace URL slug "${KAN_WORKSPACE_URL_SLUG}"`);
      return;
    }
  }
  
  // Check if sync interval changed
  if (newSyncInterval !== oldSyncInterval) {
    console.log(`   Sync interval changed: ${oldSyncInterval} → ${newSyncInterval} minutes`);
    startSyncInterval();
    
    // Calculate and display next sync time
    const nextSyncDate = new Date(Date.now() + newSyncInterval * 60 * 1000);
    const nextSyncTime = nextSyncDate.toLocaleString('en-US', { 
      year: 'numeric', 
      month: 'short', 
      day: 'numeric', 
      hour: '2-digit', 
      minute: '2-digit', 
      second: '2-digit',
      hour12: false 
    });
    
    console.log(`[CONFIG] Sync interval updated to ${newSyncInterval} minutes`);
    console.log(`[CONFIG] Next sync will happen at: ${nextSyncTime}`);
  }
  
  console.log('[CONFIG] Configuration reloaded successfully');
}

// Initialize and start the service
async function initializeService(): Promise<void> {
  const repos = getRepositories();
  const KAN_BASE_URL = getKanBaseUrl();
  const KAN_WORKSPACE_URL_SLUG = getKanWorkspaceUrlSlug();
  const configuredInterval = getSyncIntervalMinutes();
  const SYNC_INTERVAL_MINUTES = getSyncIntervalMinutes();
  
  console.log('='.repeat(60));
  console.log('[KGS] Kanbn GitHub Sync');
  console.log('='.repeat(60));
  
  console.log(`[CONFIG] Kanbn URL: ${KAN_BASE_URL || 'Not configured'}`);
  
  // Check if config.json exists
  if (!isConfigLoaded()) {
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
  
  // If configuration contains placeholders, stop immediately with clear message
  if (configCheck.hasPlaceholders) {
    console.log('\n' + '='.repeat(60));
    console.log('[CONFIG] ERROR: Configuration contains placeholder values!');
    console.log('='.repeat(60));
    console.log('\n[CONFIG] Please update the following with your actual values:\n');
    configCheck.errors.forEach((error) => {
      if (error.includes('placeholder')) {
        console.log(`   ❌ ${error}`);
      }
    });
    console.log('\n' + '='.repeat(60));
    console.log('[KGS] Service stopped. Please fix configuration and restart.');
    console.log('='.repeat(60) + '\n');
    process.exit(1);
  }
  
  // If configuration is invalid (missing required fields)
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
    setKanWorkspaceId(resolvedId);
    console.log(`[CONFIG] Resolved workspace: ${KAN_WORKSPACE_URL_SLUG} → ${resolvedId}`);
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
    setKanWorkspaceId(workspaceValidation.resolvedId);
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
  console.log(`[SYNC]   • Has PR + PR has assignees/reviewers → ${listNames.QUALITY_ASSURANCE}`);
  console.log(`[SYNC]   • Has PR (not draft) → ${listNames.READY_FOR_QA}`);
  console.log(`[SYNC]   • Has PR (draft) → ${listNames.IN_PROGRESS}`);
  console.log(`[SYNC]   • Assigned (no PR) → ${listNames.SELECTED}`);
  console.log(`[SYNC]   • Otherwise → ${listNames.BACKLOG}`);
  
  // Set up config file watching for hot reload
  setupConfigWatcher(() => {
    reloadConfig().catch((error) => {
      console.error('Error reloading config:', error);
    });
  });
}

// Start the service
initializeService().catch((error) => {
  console.error('Failed to initialize service:', error);
  process.exit(1);
});
