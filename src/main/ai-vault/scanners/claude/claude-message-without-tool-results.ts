import { isClaudeToolResultContent } from '../../../../shared/agent-hook-listener/providers/claude/transcripts/claude-tool-content'

// Why: Claude logs a tool's output as a `user` record, so its text must not stand in for something the person typed.
export function claudeMessageWithoutToolResults(message: unknown): unknown {
  if (typeof message !== 'object' || message === null) {
    return message
  }
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) {
    return message
  }
  return { ...message, content: content.filter((item) => !isClaudeToolResultContent(item)) }
}
