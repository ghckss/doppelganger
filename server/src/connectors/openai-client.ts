// @ts-nocheck
export class OpenAIClient {
  constructor(config, fetchImpl = fetch) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  isConfigured() {
    return Boolean(this.config.openai.apiKey);
  }

  async createTextResponse({ instructions, input, model }) {
    if (!this.config.openai.apiKey) {
      throw new Error('OPENAI_API_KEY가 설정되지 않았습니다');
    }

    const response = await this.fetch(`${this.config.openai.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.openai.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: model || this.config.openai.model,
        instructions,
        input,
        text: {
          format: {
            type: 'text'
          },
          verbosity: 'low'
        }
      })
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error?.message || `OpenAI API 호출이 ${response.status}로 실패했습니다`);
    }

    return payload.output_text || '';
  }
}
