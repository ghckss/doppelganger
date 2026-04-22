import { createCodeExecutionDomain } from '../../domains/code-execution-domain.ts';

export type CodeExecutionModuleDependencies = Parameters<typeof createCodeExecutionDomain>[0];

export function createCodeExecutionModule(dependencies: CodeExecutionModuleDependencies) {
  return createCodeExecutionDomain(dependencies);
}
