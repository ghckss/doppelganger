export class GitHubApiError extends Error {
  constructor(message, { status = 0, payload = null, method = 'GET', path = '' } = {}) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = Number(status) || 0;
    this.payload = payload;
    this.method = String(method || 'GET').toUpperCase();
    this.path = path || '';
  }
}

export class GitHubClient {
  constructor(config, fetchImpl = fetch) {
    this.config = config;
    this.fetch = fetchImpl;
    this.cachedViewer = null;
  }

  isConfigured() {
    return Boolean(this.config.github.token);
  }

  async request(path, { method = 'GET', body } = {}) {
    if (!this.isConfigured()) {
      throw new Error('GitHub 연결이 설정되지 않았습니다');
    }

    const response = await this.fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.config.github.token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      body: body ? JSON.stringify(body) : undefined
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new GitHubApiError(payload.message || `GitHub API 호출이 ${response.status}로 실패했습니다`, {
        status: response.status,
        payload,
        method,
        path
      });
    }

    return payload;
  }

  async requestAll(path) {
    const items = [];
    let page = 1;

    while (true) {
      const separator = path.includes('?') ? '&' : '?';
      const batch = await this.request(`${path}${separator}per_page=100&page=${page}`);
      if (!Array.isArray(batch) || batch.length === 0) {
        break;
      }

      items.push(...batch);
      if (batch.length < 100) {
        break;
      }
      page += 1;
    }

    return items;
  }

  async getAuthenticatedUser() {
    if (this.cachedViewer) {
      return this.cachedViewer;
    }

    this.cachedViewer = await this.request('/user');
    return this.cachedViewer;
  }

  async getAuthenticatedUserLogin() {
    const viewer = await this.getAuthenticatedUser();
    return viewer.login || '';
  }

  async listOpenPullRequests({ owner, repo }) {
    return this.requestAll(`/repos/${owner}/${repo}/pulls?state=open&sort=updated&direction=desc`);
  }

  async listPullRequestFiles({ owner, repo, pullNumber }) {
    return this.requestAll(`/repos/${owner}/${repo}/pulls/${pullNumber}/files`);
  }

  async listPullRequestReviews({ owner, repo, pullNumber }) {
    return this.requestAll(`/repos/${owner}/${repo}/pulls/${pullNumber}/reviews`);
  }

  async findLatestSubmittedReviewByUser({ owner, repo, pullNumber, login }) {
    const reviews = await this.listPullRequestReviews({ owner, repo, pullNumber });
    const normalizedLogin = String(login || '').toLowerCase();

    return reviews
      .filter((review) => review?.user?.login?.toLowerCase() === normalizedLogin && review.state && review.state !== 'PENDING')
      .sort((left, right) => new Date(right.submitted_at || 0).valueOf() - new Date(left.submitted_at || 0).valueOf())[0] || null;
  }

  async submitPullRequestReview({ owner, repo, pullNumber, review }) {
    return this.request(`/repos/${owner}/${repo}/pulls/${pullNumber}/reviews`, {
      method: 'POST',
      body: review
    });
  }

  async createIssueComment({ owner, repo, issueNumber, body }) {
    return this.request(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
      method: 'POST',
      body: {
        body
      }
    });
  }

  async createPullRequest({ owner, repo, head, base, title, body }) {
    return this.request(`/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      body: {
        head,
        base,
        title,
        body
      }
    });
  }
}
