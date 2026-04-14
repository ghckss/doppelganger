function normalizeGenerationProvider(value, fallback = 'cli') {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'cli' || normalized === 'openai' || normalized === 'fallback' || normalized === 'hovis') {
    return normalized;
  }
  return fallback;
}

function normalizeAgentProvider(value, fallback = 'codex') {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'codex' || normalized === 'claude') {
    return normalized;
  }
  return fallback;
}

export class GenerationClient {
  constructor({ config, openaiClient, cliClient, hovisClient }) {
    this.config = config;
    this.openaiClient = openaiClient;
    this.cliClient = cliClient;
    this.hovisClient = hovisClient;
  }

  getMode(scope = 'default') {
    const scopeProviders = this.config.generation?.scopeProviders || {};
    const scoped = scopeProviders[scope];
    return normalizeGenerationProvider(scoped || this.config.generation?.provider || 'cli', 'cli');
  }

  isConfigured(scope = 'default') {
    const mode = this.getMode(scope);
    if (mode === 'fallback') {
      return true;
    }
    if (mode === 'openai') {
      return Boolean(this.openaiClient?.isConfigured?.());
    }
    if (mode === 'hovis') {
      return Boolean(this.hovisClient?.isConfigured?.());
    }
    return Boolean(this.cliClient?.isConfigured?.());
  }

  resolveAgentProvider({ scope = 'default', agentProvider }) {
    const scopedAgent = this.config.generation?.scopeAgentProviders?.[scope];
    return normalizeAgentProvider(
      agentProvider || scopedAgent || this.config.generation?.defaultAgentProvider || this.config.agent?.defaultProvider || 'codex',
      'codex'
    );
  }

  async createTextResponse({ instructions, input, model, scope = 'default', agentProvider, pullRequestUrl }) {
    const mode = this.getMode(scope);

    if (mode === 'fallback') {
      throw new Error(`생성 공급자가 fallback으로 설정되어 있어 모델 생성을 수행하지 않습니다 (scope: ${scope})`);
    }

    if (mode === 'openai') {
      if (!this.openaiClient?.isConfigured?.()) {
        throw new Error('OPENAI_API_KEY가 설정되지 않았습니다');
      }
      const text = await this.openaiClient.createTextResponse({
        instructions,
        input,
        model
      });
      return {
        text,
        provider: 'openai',
        agentProvider: ''
      };
    }

    if (mode === 'hovis') {
      if (scope !== 'github_review') {
        throw new Error(`hovis 공급자는 github_review 스코프에서만 사용할 수 있습니다 (scope: ${scope})`);
      }
      if (!this.hovisClient?.isConfigured?.()) {
        throw new Error('HOVIS_COMMAND가 설정되지 않았습니다');
      }
      const result = await this.hovisClient.createPullRequestReview({
        pullRequestUrl,
        scope
      });
      return {
        text: result.text,
        provider: 'hovis',
        agentProvider: ''
      };
    }

    if (!this.cliClient?.isConfigured?.()) {
      throw new Error('CLI 생성기가 설정되지 않았습니다');
    }

    const resolvedAgentProvider = this.resolveAgentProvider({ scope, agentProvider });
    const result = await this.cliClient.createTextResponse({
      instructions,
      input,
      agentProvider: resolvedAgentProvider,
      scope
    });

    return {
      text: result.text,
      provider: `cli:${resolvedAgentProvider}`,
      agentProvider: resolvedAgentProvider
    };
  }
}
