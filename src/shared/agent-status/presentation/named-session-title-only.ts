import type { ConversationNameTab } from './agent-row-conversation-name'

// Why: a first-prompt stand-in is not the agent's own name, so card titles keep the last prompt until a name exists.
export function withNamedSessionTitleOnly<T extends Pick<ConversationNameTab, 'aiVaultTitle'>>(
  tab: T
): T {
  return !tab.aiVaultTitle || tab.aiVaultTitle.kind === 'named'
    ? tab
    : { ...tab, aiVaultTitle: null }
}
