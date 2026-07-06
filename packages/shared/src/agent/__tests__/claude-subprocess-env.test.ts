import { describe, expect, it } from 'bun:test'
import { buildClaudeSubprocessEnv } from '../options.ts'

function withGetuid(uid: number | undefined, fn: () => void): void {
  const original = process.getuid
  process.getuid = uid === undefined ? undefined : () => uid
  try {
    fn()
  } finally {
    process.getuid = original
  }
}

describe('buildClaudeSubprocessEnv IS_SANDBOX handling', () => {
  it('sets IS_SANDBOX=1 when running as root', () => {
    withGetuid(0, () => {
      expect(buildClaudeSubprocessEnv().IS_SANDBOX).toBe('1')
    })
  })

  it('does not set IS_SANDBOX when not root', () => {
    withGetuid(1000, () => {
      expect(buildClaudeSubprocessEnv().IS_SANDBOX).toBeUndefined()
    })
  })

  it('does not set IS_SANDBOX where getuid is unavailable (Windows)', () => {
    withGetuid(undefined, () => {
      expect(buildClaudeSubprocessEnv().IS_SANDBOX).toBeUndefined()
    })
  })

  it('leaves an explicitly provided IS_SANDBOX untouched under root', () => {
    withGetuid(0, () => {
      expect(buildClaudeSubprocessEnv({ IS_SANDBOX: 'preset' }).IS_SANDBOX).toBe('preset')
    })
  })
})
