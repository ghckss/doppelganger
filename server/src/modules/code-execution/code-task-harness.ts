export type CodeTaskHarnessStage = 'coding' | 'review' | 'patch';

export interface CodeTaskHarnessRules {
  global: string[];
  coding: string[];
  review: string[];
  patch: string[];
}

/**
 * 코드 작업 하네스 규칙 정의.
 *
 * - `global`: 모든 단계(coding/review/patch)에 공통 적용
 * - `coding`: 코딩 에이전트 단계에만 적용
 * - `review`: 리뷰 에이전트 단계에만 적용
 * - `patch`: 패치(수정) 에이전트 단계에만 적용
 *
 * 각 항목은 프롬프트에 bullet 규칙으로 주입됩니다.
 */
export const CODE_TASK_HARNESS_RULES: CodeTaskHarnessRules = {
  global: [],
  coding: [],
  review: [],
  patch: []
};

function normalizeRules(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  return values
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function renderRuleList(values: string[]): string {
  return values.map((value) => `- ${value}`).join('\n');
}

function stageLabel(stage: CodeTaskHarnessStage): string {
  if (stage === 'coding') {
    return 'Coding Stage Rules';
  }
  if (stage === 'review') {
    return 'Review Stage Rules';
  }
  return 'Patch Stage Rules';
}

export function buildCodeTaskHarnessSection(stage: CodeTaskHarnessStage): string {
  const globalRules = normalizeRules(CODE_TASK_HARNESS_RULES.global);
  const stageRules = normalizeRules(CODE_TASK_HARNESS_RULES[stage]);
  if (globalRules.length === 0 && stageRules.length === 0) {
    return '';
  }

  const sections: string[] = [
    '## Execution Harness',
    'The following rules are mandatory for this run.'
  ];

  if (globalRules.length > 0) {
    sections.push('### Global Rules');
    sections.push(renderRuleList(globalRules));
  }

  if (stageRules.length > 0) {
    sections.push(`### ${stageLabel(stage)}`);
    sections.push(renderRuleList(stageRules));
  }

  return sections.join('\n');
}

export function applyCodeTaskHarnessPrompt(stage: CodeTaskHarnessStage, prompt: string): string {
  const harnessSection = buildCodeTaskHarnessSection(stage);
  if (!harnessSection) {
    return prompt;
  }

  return [harnessSection, '', prompt].join('\n');
}

