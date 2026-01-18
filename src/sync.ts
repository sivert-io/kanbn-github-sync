/**
 * Sync orchestration logic
 */

import {
  getRepositories,
  getSyncIntervalMinutes,
} from './config';
import {
  getOrCreateBoard,
  getOrCreateLists,
  getAllBoardCards,
  syncIssueCard,
} from './kanbn';
import {
  fetchGitHubIssues,
  getIssueKey,
} from './github';
import type { GitHubIssue } from './types';

// Track issue number -> card ID mapping (repo#issue -> cardId)
const issueCardMap = new Map<string, string>(); // "owner/repo#123" -> "card_abc"

/**
 * Sync all configured repositories
 */
export async function syncAllRepositories(): Promise<void> {
  const repos = getRepositories();
  const SYNC_INTERVAL_MINUTES = getSyncIntervalMinutes();
  
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
