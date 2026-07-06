import { describe, it, expect } from 'bun:test'
import {
  parseUnameTarget,
  buildServerDownloadUrl,
  serverArchiveName,
  DEFAULT_SERVER_RELEASE_BASE,
} from '../ssh-tunnel/server-artifact.ts'

describe('parseUnameTarget', () => {
  it('maps linux x86_64', () => {
    expect(parseUnameTarget('Linux x86_64')).toEqual({ platform: 'linux', arch: 'x64' })
  })
  it('maps darwin arm64', () => {
    expect(parseUnameTarget('Darwin arm64')).toEqual({ platform: 'darwin', arch: 'arm64' })
  })
  it('maps aarch64 to arm64 and amd64 to x64', () => {
    expect(parseUnameTarget('Linux aarch64').arch).toBe('arm64')
    expect(parseUnameTarget('Linux amd64').arch).toBe('x64')
  })
  it('rejects unsupported OS', () => {
    expect(() => parseUnameTarget('FreeBSD amd64')).toThrow(/Unsupported remote OS/)
  })
  it('rejects unsupported arch', () => {
    expect(() => parseUnameTarget('Linux i686')).toThrow(/Unsupported remote architecture/)
  })
})

describe('buildServerDownloadUrl', () => {
  it('builds a version-addressable release URL for a target', () => {
    const url = buildServerDownloadUrl({ platform: 'linux', arch: 'x64' }, '0.10.5')
    expect(url).toBe(`${DEFAULT_SERVER_RELEASE_BASE}/v0.10.5/craft-server-0.10.5-linux-x64.tar.gz`)
  })

  it('names the archive per target + version', () => {
    expect(serverArchiveName({ platform: 'darwin', arch: 'arm64' }, '1.2.3')).toBe(
      'craft-server-1.2.3-darwin-arm64.tar.gz',
    )
  })

  it('honors a custom base url and trims a trailing slash', () => {
    const url = buildServerDownloadUrl(
      { platform: 'linux', arch: 'arm64' },
      '2.0.0',
      'https://cdn.example.com/dl/',
    )
    expect(url).toBe('https://cdn.example.com/dl/v2.0.0/craft-server-2.0.0-linux-arm64.tar.gz')
  })
})
