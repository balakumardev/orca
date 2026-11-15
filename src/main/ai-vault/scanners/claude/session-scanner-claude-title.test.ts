import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAiVaultSessions } from '../../session-scanner'
import { isolatedScanRoots, writeJsonlFile } from '../../session-scanner-test-fixtures'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

describe('scanAiVaultSessions Claude title selection', () => {
  it('prefers the latest generated ai-title over the first user prompt, but a custom-title wins over both, and marks which is a name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-ai-title-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const projectDir = join(roots.claudeProjectsDir, 'project')

    await writeJsonlFile(join(projectDir, 'generated.jsonl'), [
      {
        type: 'user',
        sessionId: 'generated',
        timestamp: '2026-05-01T10:00:00.000Z',
        cwd: '/tmp/claude',
        message: { role: 'user', content: 'First user prompt' }
      },
      {
        type: 'ai-title',
        sessionId: 'generated',
        timestamp: '2026-05-01T10:01:00.000Z',
        aiTitle: 'Understanding karma and moral accountability'
      },
      {
        type: 'ai-title',
        sessionId: 'generated',
        timestamp: '2026-05-01T10:02:00.000Z',
        aiTitle: 'Updated karma discussion title'
      }
    ])
    await writeJsonlFile(join(projectDir, 'custom.jsonl'), [
      {
        type: 'user',
        sessionId: 'custom',
        timestamp: '2026-05-01T11:00:00.000Z',
        cwd: '/tmp/claude',
        message: { role: 'user', content: 'First user prompt' }
      },
      {
        type: 'ai-title',
        sessionId: 'custom',
        timestamp: '2026-05-01T11:01:00.000Z',
        aiTitle: 'Generated title that must lose'
      },
      {
        type: 'custom-title',
        sessionId: 'custom',
        timestamp: '2026-05-01T11:02:00.000Z',
        customTitle: 'User set title'
      }
    ])

    await writeJsonlFile(join(projectDir, 'prompt.jsonl'), [
      {
        type: 'user',
        sessionId: 'prompt',
        timestamp: '2026-05-01T12:00:00.000Z',
        cwd: '/tmp/claude',
        message: { role: 'user', content: 'Unnamed session prompt' }
      }
    ])

    const result = await scanAiVaultSessions({ ...roots, platform: 'darwin' })

    expect(result.issues).toEqual([])
    // Renames and generated names are the session's own; a prompt only stands in until one exists.
    expect(
      result.sessions
        .map((session) => [session.title, session.titleKind])
        .sort(([a], [b]) => String(a).localeCompare(String(b)))
    ).toEqual([
      ['Unnamed session prompt', 'fallback'],
      ['Updated karma discussion title', 'named'],
      ['User set title', 'named']
    ])
  })

  it('never takes a tool result for the stand-in title, but keeps text typed beside one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-tool-result-title-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const projectDir = join(roots.claudeProjectsDir, 'project')
    const toolResult = (text: string): object => ({
      type: 'tool_result',
      tool_use_id: 'toolu_1',
      content: text
    })
    const userRecord = (sessionId: string, minute: number, content: unknown): object => ({
      type: 'user',
      sessionId,
      timestamp: `2026-05-01T10:0${minute}:00.000Z`,
      cwd: '/tmp/claude',
      message: { role: 'user', content }
    })

    await writeJsonlFile(join(projectDir, 'slash-command.jsonl'), [
      userRecord(
        'slash-command',
        0,
        '<command-name>/goal</command-name><command-args>ship it</command-args>'
      ),
      userRecord('slash-command', 1, [toolResult('Shell output that is not a prompt')]),
      userRecord('slash-command', 2, 'Real follow-up prompt')
    ])
    await writeJsonlFile(join(projectDir, 'mixed.jsonl'), [
      userRecord('mixed', 0, [toolResult('Tool output'), { type: 'text', text: 'Typed beside it' }])
    ])

    const result = await scanAiVaultSessions({ ...roots, platform: 'darwin' })

    expect(result.issues).toEqual([])
    expect(
      result.sessions
        .map((session) => [session.title, session.titleKind])
        .sort(([a], [b]) => String(a).localeCompare(String(b)))
    ).toEqual([
      ['Real follow-up prompt', 'fallback'],
      ['Typed beside it', 'fallback']
    ])
  })
})
