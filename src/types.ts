/**
 * Type definitions for Kanbn GitHub Sync
 */

export interface Config {
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
}

export interface GitHubIssue {
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

export interface GitHubComment {
  id: number;
  body: string;
  user: { login: string; html_url: string };
  created_at: string;
  updated_at: string;
}

export interface KanbnCard {
  publicId?: string;
  title: string;
  description?: string;
  listPublicId: string;
  position?: 'start' | 'end' | number;
  labelPublicIds?: string[];
}
