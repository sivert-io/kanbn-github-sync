/**
 * GitHub API client
 */

import fetch from 'node-fetch';
import { GITHUB_TOKEN } from './config';
import type { GitHubIssue, GitHubComment } from './types';

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
export function getIssueKey(repoFullName: string, issueNumber: number): string {
  return `${repoFullName}#${issueNumber}`;
}
