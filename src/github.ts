/**
 * GitHub API client
 */

import fetch from 'node-fetch';
import { GITHUB_TOKEN } from './config';
import type { GitHubIssue, GitHubComment } from './types';
import type { GitHubPullRequest } from './types';

/**
 * Fetch comments from a GitHub issue
 */
export async function fetchGitHubIssueComments(
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
export async function fetchGitHubIssues(
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
    // We only want to sync issues, not PRs themselves
    // PRs will have html_url containing '/pull/', issues will have '/issues/'
    const actualIssues = pageIssues.filter((issue) => !issue.html_url.includes('/pull/'));
    issues.push(...actualIssues);

    if (pageIssues.length < perPage) break;
    page++;
  }

  // Issues fetched - count shown in phase 2 summary
  return issues;
}

/**
 * Fetch all pull requests from a GitHub repository
 */
export async function fetchAllPullRequests(
  owner: string,
  repo: string,
  state: 'open' | 'closed' | 'all' = 'all'
): Promise<GitHubPullRequest[]> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
  };
  
  // Add GitHub token if provided
  if (GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  }

  const pullRequests: GitHubPullRequest[] = [];
  let page = 1;
  const perPage = 100;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls?state=${state}&per_page=${perPage}&page=${page}`;
    const response = await fetch(url, { headers });

    if (!response.ok) {
      if (response.status === 404) {
        break; // No PRs
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

    const pagePRs = (await response.json()) as GitHubPullRequest[];
    if (pagePRs.length === 0) break;

    pullRequests.push(...pagePRs);

    if (pagePRs.length < perPage) break;
    page++;
  }

  return pullRequests;
}

/**
 * Find PRs that reference a specific issue number
 * Checks PR title and body for issue references like "#106" or "fixes #106"
 */
export function findPRsForIssue(
  pullRequests: GitHubPullRequest[],
  issueNumber: number
): GitHubPullRequest[] {
  // Pattern to match issue references: #106, fixes #106, closes #106, etc.
  const issuePattern = new RegExp(`#${issueNumber}\\b|(?:fixes?|closes?|resolves?|addresses?)\\s+#${issueNumber}\\b`, 'i');
  
  return pullRequests.filter(pr => {
    // Check title
    if (pr.title && issuePattern.test(pr.title)) {
      return true;
    }
    // Check body
    if (pr.body && issuePattern.test(pr.body)) {
      return true;
    }
    return false;
  });
}

/**
 * Fetch pull request data by PR number
 */
export async function fetchPullRequest(
  owner: string,
  repo: string,
  prNumber: number
): Promise<GitHubPullRequest | null> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
  };
  
  // Add GitHub token if provided
  if (GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  }

  try {
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;
    const response = await fetch(url, { headers });

    if (!response.ok) {
      if (response.status === 404) {
        return null; // PR doesn't exist
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

    return (await response.json()) as GitHubPullRequest;
  } catch (error) {
    // If it's a rate limit error, re-throw it
    if (error instanceof Error && error.message.includes('rate limit')) {
      throw error;
    }
    // For other errors, return null (PR might not exist or be accessible)
    return null;
  }
}

/**
 * Extract PR number from a pull request URL
 * Handles both API URLs and HTML URLs
 */
export function extractPrNumberFromUrl(prUrl: string): number | null {
  // Match patterns like:
  // - https://api.github.com/repos/owner/repo/pulls/123
  // - https://github.com/owner/repo/pull/123
  const match = prUrl.match(/\/pulls?\/(\d+)/);
  if (match && match[1]) {
    const prNumber = parseInt(match[1], 10);
    if (!isNaN(prNumber)) {
      return prNumber;
    }
  }
  return null;
}

/**
 * Get unique key for an issue
 */
export function getIssueKey(repoFullName: string, issueNumber: number): string {
  return `${repoFullName}#${issueNumber}`;
}
