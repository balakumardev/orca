import type { AiVaultSearchHit } from '../../../../shared/ai-vault/search/ai-vault-search-types'

export function sessionHit(
  sessionId: string,
  overrides: Partial<AiVaultSearchHit> = {}
): AiVaultSearchHit {
  return {
    agent: 'claude',
    sessionId,
    title: `Title of ${sessionId}`,
    cwd: '/code/acme-web',
    branch: 'main',
    updatedAt: '2026-11-10T08:00:00.000Z',
    messageCount: 4,
    score: 1,
    source: { presence: 'present', filePath: `/home/dev/.claude/projects/acme/${sessionId}.jsonl` },
    evidence: { role: 'assistant', timestamp: null, snippet: 'ship the [[billing]] exporter' },
    resumeCommand: `claude --resume ${sessionId}`,
    ...overrides
  }
}
