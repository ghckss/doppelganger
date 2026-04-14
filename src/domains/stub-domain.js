export function createStubDomain({ id, label, setupKeys }) {
  return {
    id,
    label,
    implemented: false,
    capabilities: {
      polling: false,
      drafting: true,
      execution: true
    },
    setupKeys,
    async generateDraft() {
      throw new Error(`${label} 도메인은 틀만 준비되어 있고 아직 구현되지 않았습니다`);
    },
    async execute() {
      throw new Error(`${label} 도메인은 틀만 준비되어 있고 아직 구현되지 않았습니다`);
    }
  };
}
