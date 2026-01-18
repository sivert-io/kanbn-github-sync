/**
 * Configuration management for Kanbn GitHub Sync
 */

import { readFileSync, watchFile } from 'fs';
import { join } from 'path';
import type { Config } from './types';

let config: Config = {};
let configLoaded = false;
let configPath: string | null = null;

// Environment variables (loaded once at startup)
export const KAN_API_KEY = process.env.KAN_API_KEY || '';
export const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';

// Derived config values (updated when config reloads)
let KAN_BASE_URL = '';
let KAN_WORKSPACE_URL_SLUG = '';
let KAN_WORKSPACE_ID = '';
let SYNC_INTERVAL_MINUTES = 5;

export const MIN_SYNC_INTERVAL_MINUTES = 5;

// Cache for repo -> custom board names
const repoBoardNames = new Map<string, string>();

// Default list names
const DEFAULT_LIST_NAMES = {
  BACKLOG: '📝 Backlog',
  SELECTED: '✨ Selected',
  IN_PROGRESS: '⚙️ In Progress',
  COMPLETED: '🎉 Completed/Closed',
};

/**
 * Load configuration from config.json
 */
export function loadConfig(): { success: boolean; error?: string } {
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
    
    // Update derived values
    KAN_BASE_URL = config.kanbn?.baseUrl || '';
    KAN_WORKSPACE_URL_SLUG = config.kanbn?.workspaceUrlSlug || '';
    const configuredInterval = config.sync?.intervalMinutes || 1;
    SYNC_INTERVAL_MINUTES = configuredInterval < MIN_SYNC_INTERVAL_MINUTES 
      ? MIN_SYNC_INTERVAL_MINUTES 
      : configuredInterval;
    
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

// Getters for config values
export function getConfig(): Config {
  return config;
}

export function isConfigLoaded(): boolean {
  return configLoaded;
}

export function getConfigPath(): string | null {
  return configPath;
}

export function getKanBaseUrl(): string {
  return KAN_BASE_URL;
}

export function getKanWorkspaceUrlSlug(): string {
  return KAN_WORKSPACE_URL_SLUG;
}

export function getKanWorkspaceId(): string {
  return KAN_WORKSPACE_ID;
}

export function setKanWorkspaceId(id: string): void {
  KAN_WORKSPACE_ID = id;
}

export function getSyncIntervalMinutes(): number {
  return SYNC_INTERVAL_MINUTES;
}

/**
 * Get list names from config or use defaults
 */
export function getListNames(): { BACKLOG: string; SELECTED: string; IN_PROGRESS: string; COMPLETED: string } {
  return {
    BACKLOG: config.lists?.backlog || DEFAULT_LIST_NAMES.BACKLOG,
    SELECTED: config.lists?.selected || DEFAULT_LIST_NAMES.SELECTED,
    IN_PROGRESS: config.lists?.inProgress || DEFAULT_LIST_NAMES.IN_PROGRESS,
    COMPLETED: config.lists?.completed || DEFAULT_LIST_NAMES.COMPLETED,
  };
}

/**
 * Get list of configured repositories
 */
export function getRepositories(): string[] {
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
export function getBoardName(repoFullName: string): string {
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
export function isRepoConfigured(repoFullName: string): boolean {
  return getRepositories().includes(repoFullName);
}

/**
 * Verify configuration and detect placeholder values
 */
export function verifyConfig(): { valid: boolean; errors: string[]; hasPlaceholders: boolean } {
  const errors: string[] = [];
  let hasPlaceholders = false;
  
  // Check for placeholder API key
  if (!KAN_API_KEY) {
    errors.push('KAN_API_KEY is required in .env');
  } else {
    // Check for exact example placeholder value
    const exampleApiKey = 'kan_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    if (KAN_API_KEY === exampleApiKey || KAN_API_KEY.includes('xxxxxxxx')) {
      errors.push('KAN_API_KEY in .env still contains placeholder value from env.example - please update with your actual API key');
      hasPlaceholders = true;
    } else if (!KAN_API_KEY.startsWith('kan_') || KAN_API_KEY.length < 40) {
      // Basic validation: Kanbn API keys start with "kan_" and are typically 40+ characters
      errors.push('KAN_API_KEY in .env does not appear to be a valid Kanbn API key format (should start with "kan_" and be 40+ characters)');
    }
  }
  
  // Check for placeholder base URL
  if (!KAN_BASE_URL) {
    errors.push('kanbn.baseUrl is required in config.json');
  } else {
    // Check for exact example value from config.json.example
    const exampleBaseUrl = 'https://kan.example.com';
    if (KAN_BASE_URL === exampleBaseUrl || KAN_BASE_URL.includes('example.com')) {
      errors.push('kanbn.baseUrl in config.json still contains placeholder value from config.json.example - please update with your actual Kanbn URL');
      hasPlaceholders = true;
    }
  }
  
  // Check for placeholder workspace slug
  if (!KAN_WORKSPACE_URL_SLUG) {
    errors.push('kanbn.workspaceUrlSlug is required in config.json');
  } else {
    // Check for common placeholder patterns (but "MAT" could be valid, so only check for obvious placeholders)
    const lowerSlug = KAN_WORKSPACE_URL_SLUG.toLowerCase();
    if (KAN_WORKSPACE_URL_SLUG === 'YOUR_WORKSPACE_SLUG' || 
        lowerSlug.includes('your') || 
        lowerSlug.includes('example') ||
        lowerSlug.includes('placeholder')) {
      errors.push('kanbn.workspaceUrlSlug in config.json still contains placeholder value - please update with your actual workspace slug');
      hasPlaceholders = true;
    }
  }
  
  // Check for placeholder repositories
  const repos = getRepositories();
  if (repos.length === 0) {
    errors.push('github.repositories is required in config.json (array of "owner/repo" strings, or object with "owner/repo": "Custom Board Name")');
  } else {
    // Check if repositories contain placeholder values from config.json.example
    const exampleRepos = ['your-username/repo-one', 'your-username/repo-two', 'your-username/repo-three'];
    const exampleBoardNames = ['My Custom Board Name', 'Another Board', 'Third Repository'];
    
    // Check repository names
    const placeholderRepos = repos.filter(repo => 
      exampleRepos.includes(repo) ||
      repo.includes('your-username') || 
      (repo.includes('owner/') && (repo.includes('repo-one') || repo.includes('repo-two') || repo.includes('repo-three')))
    );
    
    // Check board names (if repositories is an object)
    const repoConfig = config.github?.repositories;
    let hasPlaceholderBoardNames = false;
    if (repoConfig && typeof repoConfig === 'object' && !Array.isArray(repoConfig)) {
      const boardNames = Object.values(repoConfig) as string[];
      hasPlaceholderBoardNames = boardNames.some(name => exampleBoardNames.includes(name));
    }
    
    if (placeholderRepos.length > 0) {
      errors.push(`github.repositories in config.json still contains placeholder values from config.json.example (${placeholderRepos.join(', ')}) - please update with your actual GitHub repositories`);
      hasPlaceholders = true;
    }
    
    if (hasPlaceholderBoardNames) {
      errors.push('github.repositories in config.json still contains example board names from config.json.example - please update with your actual board names');
      hasPlaceholders = true;
    }
  }
  
  return { valid: errors.length === 0, errors, hasPlaceholders };
}

/**
 * Set up file watcher for config.json
 */
export function setupConfigWatcher(onChange: () => void): void {
  if (!configPath) return;
  
  watchFile(configPath, { interval: 5000 }, () => {
    console.log('[CONFIG] config.json changed, reloading...');
    const result = loadConfig();
    if (result.success) {
      console.log('[CONFIG] Configuration reloaded successfully');
      onChange();
    } else {
      console.error('[CONFIG] Failed to reload configuration:', result.error);
    }
  });
}
