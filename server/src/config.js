import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listMissing } from './utils.js';

function parseEnvFile(content) {
  const parsed = {};

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    parsed[key] = rawValue.replace(/^['"]|['"]$/g, '');
  }

  return parsed;
}

function loadEnvFile(cwd) {
  const candidatePaths = [
    path.join(cwd, 'server', '.env'),
    path.join(cwd, '.env')
  ];

  for (const envPath of candidatePaths) {
    if (!fs.existsSync(envPath)) {
      continue;
    }

    return parseEnvFile(fs.readFileSync(envPath, 'utf8'));
  }

  return {};
}

function readValue(env, key, fallback = '') {
  const value = env[key];
  return value === undefined ? fallback : value;
}

function readNumber(env, key, fallback) {
  const value = Number(readValue(env, key, fallback));
  return Number.isFinite(value) ? value : fallback;
}

function readPositiveNumber(env, key, fallback) {
  const value = Number(readValue(env, key, fallback));
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

function readTimeoutSeconds(env, key, fallback) {
  const raw = String(readValue(env, key, '')).trim();
  if (!raw) {
    if (fallback <= 0) {
      return 0;
    }
    return Math.max(10, Number(fallback) || 90);
  }

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    if (fallback <= 0) {
      return 0;
    }
    return Math.max(10, Number(fallback) || 90);
  }

  if (value <= 0) {
    return 0;
  }

  return Math.max(10, value);
}

function readOptionalTimeoutSeconds(env, key) {
  const raw = String(readValue(env, key, '')).trim();
  if (!raw) {
    return undefined;
  }

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return undefined;
  }

  if (value <= 0) {
    return 0;
  }

  return Math.max(10, value);
}

function readList(env, key) {
  return readValue(env, key, '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function normalizeStringMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const output = {};
  for (const [key, raw] of Object.entries(value)) {
    const normalizedKey = String(key || '').trim();
    const normalizedValue = String(raw || '').trim();
    if (!normalizedKey || !normalizedValue) {
      continue;
    }
    output[normalizedKey] = normalizedValue;
  }
  return output;
}

function normalizeSlackCodeKeywordRule(rule, index) {
  if (!rule || typeof rule !== 'object') {
    return null;
  }

  const keywords = Array.isArray(rule.keywords)
    ? rule.keywords.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const repositories = Array.isArray(rule.repositories)
    ? rule.repositories.map((item) => String(item || '').trim()).filter(Boolean)
    : [];

  if (keywords.length === 0 || repositories.length === 0) {
    return null;
  }

  const searchTerms = Array.isArray(rule.searchTerms)
    ? rule.searchTerms.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const pathHints = Array.isArray(rule.pathHints)
    ? rule.pathHints.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const baseRepositoryFolders = normalizeStringMap(
    rule.repositoryFolders || rule.repoFolders || rule.workdirByRepository || {}
  );
  const sharedFolder = String(rule.folder || rule.workdir || '').trim();
  const repositoryFolders = {
    ...baseRepositoryFolders
  };
  if (sharedFolder) {
    for (const repo of repositories) {
      if (!repositoryFolders[repo]) {
        repositoryFolders[repo] = sharedFolder;
      }
    }
  }
  const rawWeight = Number(rule.weight);
  const weight = Number.isFinite(rawWeight) && rawWeight > 0 ? rawWeight : 1;

  return {
    id: String(rule.id || `rule-${index + 1}`),
    keywords,
    repositories,
    searchTerms,
    pathHints,
    repositoryFolders,
    weight
  };
}

function loadSlackCodeKeywordRules(cwd, env) {
  const configuredPath = String(readValue(env, 'SLACK_CODE_KEYWORDS_PATH', 'config/slack-code-keywords.json') || '').trim();
  const relativePath = configuredPath || 'config/slack-code-keywords.json';
  const absolutePath = path.resolve(cwd, relativePath);

  if (!fs.existsSync(absolutePath)) {
    return {
      path: absolutePath,
      rules: []
    };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
    if (!Array.isArray(parsed)) {
      return {
        path: absolutePath,
        rules: []
      };
    }

    const rules = parsed
      .map((rule, index) => normalizeSlackCodeKeywordRule(rule, index))
      .filter(Boolean);
    return {
      path: absolutePath,
      rules
    };
  } catch {
    return {
      path: absolutePath,
      rules: []
    };
  }
}

function normalizeAgentProvider(value, fallback = 'codex') {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'codex' || normalized === 'claude') {
    return normalized;
  }
  return fallback;
}

function normalizeAgentProviderOptional(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    return '';
  }
  return normalizeAgentProvider(normalized, '');
}

function normalizeGenerationProvider(value, fallback = 'cli') {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'hovis') {
    return 'external';
  }
  if (normalized === 'cli' || normalized === 'openai' || normalized === 'fallback' || normalized === 'external') {
    return normalized;
  }
  return fallback;
}

function normalizeGenerationProviderOptional(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    return '';
  }
  return normalizeGenerationProvider(normalized, '');
}

function toScopeMap(entries) {
  const output = {};
  for (const [key, value] of entries) {
    if (value) {
      output[key] = value;
    }
  }
  return output;
}

function resolveWorkspaceAllowlistEntry(entry, { cwd, projectsRoot }) {
  const raw = String(entry || '').trim();
  if (!raw) {
    return '';
  }

  if (raw.startsWith('~/')) {
    return path.resolve(os.homedir(), raw.slice(2));
  }

  if (path.isAbsolute(raw)) {
    return path.resolve(raw);
  }

  if (raw.startsWith('./') || raw.startsWith('../')) {
    return path.resolve(cwd, raw);
  }

  return path.resolve(projectsRoot, raw);
}

export function loadConfig({ cwd = process.cwd(), env = process.env } = {}) {
  const fileValues = loadEnvFile(cwd);
  const mergedEnv = {
    ...fileValues,
    ...env
  };
  const projectsRoot = path.join(os.homedir(), 'workspace');
  const configuredAllowlist = readList(mergedEnv, 'WORKSPACE_ALLOWLIST')
    .map((item) => resolveWorkspaceAllowlistEntry(item, {
      cwd,
      projectsRoot
    }))
    .filter(Boolean);
  const defaultAgentProvider = normalizeAgentProvider(readValue(mergedEnv, 'AGENT_PROVIDER', 'codex'));
  const generationProvider = normalizeGenerationProvider(readValue(mergedEnv, 'GENERATION_PROVIDER', 'cli'));
  const generationDefaultAgentProvider = normalizeAgentProvider(
    readValue(mergedEnv, 'GENERATION_AGENT_PROVIDER', defaultAgentProvider),
    defaultAgentProvider
  );
  const generationScopeProviders = toScopeMap([
    ['slack', normalizeGenerationProviderOptional(readValue(mergedEnv, 'SLACK_GENERATION_PROVIDER', ''))],
    ['github_review', normalizeGenerationProviderOptional(readValue(mergedEnv, 'GITHUB_REVIEW_PROVIDER', ''))],
    ['code_planning', normalizeGenerationProviderOptional(readValue(mergedEnv, 'CODE_PLANNING_PROVIDER', ''))],
    ['meeting_notes', normalizeGenerationProviderOptional(readValue(mergedEnv, 'MEETING_NOTES_PROVIDER', ''))]
  ]);
  const generationScopeAgentProviders = toScopeMap([
    ['slack', normalizeAgentProviderOptional(readValue(mergedEnv, 'SLACK_GENERATION_AGENT_PROVIDER', ''))],
    ['github_review', normalizeAgentProviderOptional(readValue(mergedEnv, 'GITHUB_REVIEW_AGENT_PROVIDER', ''))],
    ['code_planning', normalizeAgentProviderOptional(readValue(mergedEnv, 'CODE_PLANNING_AGENT_PROVIDER', ''))],
    ['meeting_notes', normalizeAgentProviderOptional(readValue(mergedEnv, 'MEETING_NOTES_AGENT_PROVIDER', ''))]
  ]);
  const generationScopeTimeoutSeconds = {};
  const slackCodeKeywordConfig = loadSlackCodeKeywordRules(cwd, mergedEnv);
  const externalAgentCommand = readValue(
    mergedEnv,
    'EXTERNAL_AGENT_COMMAND',
    readValue(mergedEnv, 'HOVIS_COMMAND', '')
  );
  const slackTimeout = readOptionalTimeoutSeconds(mergedEnv, 'SLACK_GENERATION_TIMEOUT_SECONDS');
  const githubReviewTimeout = readOptionalTimeoutSeconds(mergedEnv, 'GITHUB_REVIEW_TIMEOUT_SECONDS');
  const codePlanningTimeout = readOptionalTimeoutSeconds(mergedEnv, 'CODE_PLANNING_TIMEOUT_SECONDS');
  const meetingNotesTimeout = readOptionalTimeoutSeconds(mergedEnv, 'MEETING_NOTES_TIMEOUT_SECONDS');
  if (slackTimeout !== undefined) {
    generationScopeTimeoutSeconds.slack = slackTimeout;
  }
  if (githubReviewTimeout !== undefined) {
    generationScopeTimeoutSeconds.github_review = githubReviewTimeout;
  }
  if (codePlanningTimeout !== undefined) {
    generationScopeTimeoutSeconds.code_planning = codePlanningTimeout;
  }
  if (meetingNotesTimeout !== undefined) {
    generationScopeTimeoutSeconds.meeting_notes = meetingNotesTimeout;
  }

  const config = {
    cwd,
    app: {
      host: readValue(mergedEnv, 'APP_HOST', '127.0.0.1'),
      port: readNumber(mergedEnv, 'APP_PORT', 4318),
      baseUrl: readValue(mergedEnv, 'APP_BASE_URL', 'http://127.0.0.1:4318'),
      corsOrigins: readList(mergedEnv, 'APP_CORS_ORIGINS'),
      encryptionKey: readValue(mergedEnv, 'APP_ENCRYPTION_KEY', ''),
      sessionSecret: readValue(mergedEnv, 'SESSION_SECRET', ''),
      databasePath: path.resolve(cwd, readValue(mergedEnv, 'DATABASE_PATH', '.local/agent.db'))
    },
    slack: {
      readToken: readValue(mergedEnv, 'SLACK_READ_TOKEN', ''),
      writeToken: readValue(mergedEnv, 'SLACK_WRITE_TOKEN', ''),
      userId: readValue(mergedEnv, 'SLACK_USER_ID', ''),
      initialLookbackMinutes: readNumber(mergedEnv, 'SLACK_INITIAL_LOOKBACK_MINUTES', 1440),
      searchPageSize: readNumber(mergedEnv, 'SLACK_SEARCH_PAGE_SIZE', 100),
      searchMaxPages: readNumber(mergedEnv, 'SLACK_SEARCH_MAX_PAGES', 3),
      ignoreChannels: readList(mergedEnv, 'SLACK_IGNORE_CHANNELS'),
      codeKeywordsPath: slackCodeKeywordConfig.path,
      codeKeywordRules: slackCodeKeywordConfig.rules,
      codeAnalysisMaxFindings: readPositiveNumber(mergedEnv, 'SLACK_CODE_ANALYSIS_MAX_FINDINGS', 12),
      codeReviewTimeoutSeconds: readTimeoutSeconds(mergedEnv, 'SLACK_CODE_REVIEW_TIMEOUT_SECONDS', 0)
    },
    openai: {
      apiKey: readValue(mergedEnv, 'OPENAI_API_KEY', ''),
      model: readValue(mergedEnv, 'OPENAI_MODEL', 'gpt-5.3-codex'),
      baseUrl: readValue(mergedEnv, 'OPENAI_BASE_URL', 'https://api.openai.com/v1')
    },
    codex: {
      command: readValue(mergedEnv, 'CODEX_COMMAND', 'codex')
    },
    claude: {
      command: readValue(mergedEnv, 'CLAUDE_COMMAND', 'claude')
    },
    externalAgent: {
      command: externalAgentCommand
    },
    hovis: {
      command: externalAgentCommand
    },
    agent: {
      defaultProvider: defaultAgentProvider
    },
    generation: {
      provider: generationProvider,
      defaultAgentProvider: generationDefaultAgentProvider,
      timeoutSeconds: readTimeoutSeconds(mergedEnv, 'GENERATION_TIMEOUT_SECONDS', 90),
      scopeProviders: generationScopeProviders,
      scopeAgentProviders: generationScopeAgentProviders,
      scopeTimeoutSeconds: generationScopeTimeoutSeconds
    },
    github: {
      token: readValue(mergedEnv, 'GITHUB_TOKEN', ''),
      owner: readValue(mergedEnv, 'GITHUB_OWNER', ''),
      repositories: readList(mergedEnv, 'GITHUB_REPOSITORIES')
    },
    workspace: {
      projectsRoot,
      allowlist: configuredAllowlist.length > 0 ? configuredAllowlist : [projectsRoot]
    }
  };

  return config;
}

export function getConnectorReadiness(config) {
  const generationProviders = [
    config.generation?.provider || 'cli',
    ...Object.values(config.generation?.scopeProviders || {})
  ];
  const openaiRequired = generationProviders.includes('openai');

  return {
    slack: {
      ready: Boolean(config.slack.readToken && (config.slack.writeToken || config.slack.readToken)),
      missing: listMissing([
        ['SLACK_READ_TOKEN', config.slack.readToken],
        ['SLACK_WRITE_TOKEN', config.slack.writeToken || config.slack.readToken]
      ])
    },
    openai: {
      ready: openaiRequired ? Boolean(config.openai.apiKey) : true,
      missing: openaiRequired
        ? listMissing([
          ['OPENAI_API_KEY', config.openai.apiKey]
        ])
        : []
    },
    github: {
      ready: Boolean(config.github.token && config.github.owner && config.github.repositories.length > 0),
      missing: listMissing([
        ['GITHUB_TOKEN', config.github.token],
        ['GITHUB_OWNER', config.github.owner],
        ['GITHUB_REPOSITORIES', config.github.repositories.length > 0 ? 'configured' : '']
      ])
    },
    workspace: {
      ready: config.workspace.allowlist.length > 0 && fs.existsSync(config.workspace.projectsRoot),
      missing: fs.existsSync(config.workspace.projectsRoot) ? [] : [config.workspace.projectsRoot]
    }
  };
}
