import { describe, it, expect } from 'bun:test'
import {
  bootstrapRemoteServer,
  buildDownloadCommand,
  buildExtractCommand,
  buildReadVersionCommand,
  buildRestartCommand,
  buildWriteTokenCommand,
  CHECK_INSTALLED_COMMAND,
  KILL_MANAGED_SERVER_COMMAND,
  REMOTE_DOWNLOAD_TMP,
  REMOTE_LOG_PATH,
  REMOTE_TOKEN_PATH,
  REMOTE_VERSION_PATH,
  type ServerBootstrapDeps,
  type BootstrapProgress,
} from '../ssh-tunnel/server-bootstrap.ts'
import type { SshHostConfig } from '@craft-agent/shared/config'

const HOST: SshHostConfig = {
  id: 'box',
  label: 'Box',
  host: '127.0.0.1',
  port: 2222,
  user: 'tester',
  remotePort: 9200,
}

const DOWNLOAD_URL = 'https://example.com/dl/v1.0.0/craft-server-1.0.0-darwin-arm64.tar.gz'

interface Recorded {
  remoteCommands: string[]
  /** stdin payloads passed alongside remote commands (parallel to remoteCommands). */
  remoteStdins: Array<string | undefined>
  stored: Record<string, string>
  progress: BootstrapProgress[]
}

/** True when a remote command fetched the prebuilt archive. */
const ranDownload = (cmds: string[]): boolean => cmds.some((c) => c.includes(DOWNLOAD_URL))

function makeDeps(
  overrides: Partial<ServerBootstrapDeps> & {
    probeResults?: boolean[]
    initialToken?: string
    installedVersion?: string
  } = {},
): { deps: ServerBootstrapDeps; rec: Recorded; onProgress: (p: BootstrapProgress) => void } {
  const rec: Recorded = { remoteCommands: [], remoteStdins: [], stored: {}, progress: [] }
  if (overrides.initialToken) rec.stored[HOST.id] = overrides.initialToken
  const probeResults = overrides.probeResults ? [...overrides.probeResults] : []
  let probeIdx = 0
  const appVersion = overrides.appVersion ?? '1.0.0'
  const installedVersion = overrides.installedVersion ?? appVersion

  const deps: ServerBootstrapDeps = {
    runRemote: async (_h, cmd, opts) => {
      rec.remoteCommands.push(cmd)
      rec.remoteStdins.push(opts?.stdin)
      if (cmd === buildReadVersionCommand()) return installedVersion
      if (cmd.includes('uname')) return 'Darwin arm64\n'
      if (cmd.includes('tail')) return 'boom: server crashed\n'
      return ''
    },
    detectTarget: () => ({ platform: 'darwin', arch: 'arm64' }),
    resolveDownloadUrl: () => DOWNLOAD_URL,
    appVersion,
    probe: async () => {
      const r = probeResults[probeIdx] ?? false
      probeIdx++
      return r
    },
    generateToken: () => 'GENERATED_SECRET_TOKEN_abcdef0123456789',
    storeToken: async (hostId, token) => {
      rec.stored[hostId] = token
    },
    loadStoredToken: async (hostId) => rec.stored[hostId],
    sleep: async () => {},
    probeAttempts: 3,
    probeIntervalMs: 1,
    ...overrides,
  }
  const onProgress = (p: BootstrapProgress) => rec.progress.push(p)
  return { deps, rec, onProgress }
}

describe('buildWriteTokenCommand', () => {
  it('writes the token file from stdin with 0600 permissions', () => {
    const cmd = buildWriteTokenCommand()
    expect(cmd).toContain('umask 077')
    expect(cmd).toContain(`cat > ${REMOTE_TOKEN_PATH}`)
    expect(cmd).toContain(`chmod 600 ${REMOTE_TOKEN_PATH}`)
  })
})

describe('buildDownloadCommand', () => {
  it('downloads with curl and a wget fallback, both following redirects', () => {
    const cmd = buildDownloadCommand('https://host/x.tar.gz')
    expect(cmd).toContain('curl -fL')
    expect(cmd).toContain('wget')
    expect(cmd).toContain("'https://host/x.tar.gz'")
    expect(cmd).toContain(REMOTE_DOWNLOAD_TMP)
  })
})

describe('buildExtractCommand', () => {
  it('cleans stale code (keeping token/config), extracts, stamps version, drops temp', () => {
    const cmd = buildExtractCommand('2.3.4')
    expect(cmd).toContain('find')
    expect(cmd).toContain('! -name .token')
    expect(cmd).toContain('! -name config')
    expect(cmd).toContain(`tar -xzf ${REMOTE_DOWNLOAD_TMP}`)
    expect(cmd).toContain('chmod +x')
    expect(cmd).toContain(`printf '%s' '2.3.4' > ${REMOTE_VERSION_PATH}`)
    expect(cmd).toContain(`rm -f ${REMOTE_DOWNLOAD_TMP}`)
  })
})

describe('buildReadVersionCommand', () => {
  it('reads the version marker and tolerates its absence', () => {
    const cmd = buildReadVersionCommand()
    expect(cmd).toContain(`cat ${REMOTE_VERSION_PATH}`)
    expect(cmd).toContain('|| true')
  })
})

describe('buildRestartCommand', () => {
  it('reads the token from file, detaches under nohup, logs to a file', () => {
    const cmd = buildRestartCommand(9200)
    expect(cmd).toContain(`CRAFT_SERVER_TOKEN="$(cat ${REMOTE_TOKEN_PATH})"`)
    expect(cmd).toContain('CRAFT_RPC_PORT=9200')
    expect(cmd).toContain('CRAFT_CONFIG_DIR=')
    expect(cmd).toContain('nohup')
    expect(cmd).toContain(REMOTE_LOG_PATH)
    expect(cmd).toContain('sh -c')
    expect(cmd).toContain('< /dev/null')
  })
})

describe('bootstrapRemoteServer', () => {
  it('short-circuits when a live server is already on the current version', async () => {
    const { deps, rec } = makeDeps({ probeResults: [true], initialToken: 'EXISTING_TOKEN' })
    const result = await bootstrapRemoteServer(HOST, deps, (p) => rec.progress.push(p))
    expect(result.token).toBe('EXISTING_TOKEN')
    // Only the version marker was read; no install work.
    expect(rec.remoteCommands).toEqual([buildReadVersionCommand()])
    expect(ranDownload(rec.remoteCommands)).toBe(false)
    expect(rec.progress.map((p) => p.phase)).toEqual(['checking-server', 'ready'])
  })

  it('fails fast when a server is alive, no token is stored, and no install dir exists', async () => {
    const { deps, rec, onProgress } = makeDeps({ probeResults: [true] })
    await expect(bootstrapRemoteServer(HOST, deps, onProgress)).rejects.toThrow(
      /already running on port 9200.*not managed/s,
    )
    // Only the install-dir check ran — no download, no start/restart.
    expect(ranDownload(rec.remoteCommands)).toBe(false)
    expect(rec.remoteCommands).toEqual([CHECK_INSTALLED_COMMAND])
    // No token generated or stored for a server we don't manage.
    expect(rec.stored[HOST.id]).toBeUndefined()
    expect(rec.progress.at(-1)!.phase).toBe('error')
  })

  it('runs the full download+install path when no server exists', async () => {
    // First probe (initial check) false, then post-start probe true.
    const { deps, rec, onProgress } = makeDeps({ probeResults: [false, true] })
    const result = await bootstrapRemoteServer(HOST, deps, onProgress)

    expect(result.token).toBe('GENERATED_SECRET_TOKEN_abcdef0123456789')
    // Token was persisted.
    expect(rec.stored[HOST.id]).toBe('GENERATED_SECRET_TOKEN_abcdef0123456789')
    // Downloaded the prebuilt archive (never uploaded/built locally).
    expect(ranDownload(rec.remoteCommands)).toBe(true)
    // Detected OS, extracted, then started the server.
    expect(rec.remoteCommands.some((c) => c.includes('uname'))).toBe(true)
    expect(rec.remoteCommands.some((c) => c.includes(`tar -xzf ${REMOTE_DOWNLOAD_TMP}`))).toBe(true)
    expect(rec.remoteCommands.some((c) => c.includes('nohup'))).toBe(true)
    // Progress narrated the download phase and reached ready.
    expect(rec.progress.some((p) => p.phase === 'downloading-server')).toBe(true)
    expect(rec.progress.at(-1)!.phase).toBe('ready')
  })

  it('transfers the token via stdin only — never in any command argv', async () => {
    const { deps, rec, onProgress } = makeDeps({ probeResults: [false, true] })
    await bootstrapRemoteServer(HOST, deps, onProgress)

    // The token travels exactly once, as stdin to the write-token command.
    const stdinPayloads = rec.remoteStdins.filter((s) => s !== undefined)
    expect(stdinPayloads).toEqual(['GENERATED_SECRET_TOKEN_abcdef0123456789'])
    const writeIdx = rec.remoteStdins.findIndex((s) => s !== undefined)
    expect(rec.remoteCommands[writeIdx]).toContain(`cat > ${REMOTE_TOKEN_PATH}`)

    // No remote command string ever contains the literal token (ps-safe).
    for (const cmd of rec.remoteCommands) {
      expect(cmd).not.toContain('GENERATED_SECRET_TOKEN')
    }
  })

  it('never leaks the token into progress events', async () => {
    const { deps, rec, onProgress } = makeDeps({ probeResults: [false, true] })
    await bootstrapRemoteServer(HOST, deps, onProgress)
    const serialized = JSON.stringify(rec.progress)
    expect(serialized).not.toContain('GENERATED_SECRET_TOKEN')
  })

  it('reuses a stored token when the server needs (re)installing', async () => {
    const { deps, rec, onProgress } = makeDeps({
      probeResults: [false, true],
      initialToken: 'REUSED_TOKEN_0123456789abcdef',
    })
    const result = await bootstrapRemoteServer(HOST, deps, onProgress)
    expect(result.token).toBe('REUSED_TOKEN_0123456789abcdef')
    // The reused token was written to the remote token file via stdin.
    expect(rec.remoteStdins).toContain('REUSED_TOKEN_0123456789abcdef')
  })

  it('surfaces a remote log tail on start timeout', async () => {
    // Initial probe false, and all post-start probes false → timeout.
    const { deps, onProgress } = makeDeps({ probeResults: [false, false, false, false] })
    await expect(bootstrapRemoteServer(HOST, deps, onProgress)).rejects.toThrow(/server crashed/)
  })

  it('reports a clear error when the remote download fails', async () => {
    const { deps, rec, onProgress } = makeDeps({
      probeResults: [false],
      runRemote: (async (_h: unknown, cmd: string) => {
        if (cmd.includes('uname')) return 'Darwin arm64\n'
        if (cmd.includes(DOWNLOAD_URL)) throw new Error('curl: (22) 404 Not Found')
        return ''
      }) as ServerBootstrapDeps['runRemote'],
    })
    await expect(bootstrapRemoteServer(HOST, deps, onProgress)).rejects.toThrow(
      /Failed to download the server/,
    )
    expect(rec.progress.at(-1)!.phase).toBe('error')
  })
})

describe('bootstrapRemoteServer — alive server, lost token, our install dir', () => {
  // Host re-added with the same slug while the app-managed server kept running:
  // port answers, no token, but OUR install dir is there — restart, not throw.
  it('kills + restarts the managed server with a freshly generated token', async () => {
    const cmds: string[] = []
    const stdins: (string | undefined)[] = []
    const { deps, rec } = makeDeps({
      probeResults: [true, true], // alive on first check, up again after restart
      runRemote: (async (_h: unknown, cmd: string, opts?: { stdin?: string }) => {
        cmds.push(cmd)
        stdins.push(opts?.stdin)
        if (cmd === CHECK_INSTALLED_COMMAND) return 'INSTALLED\n'
        return ''
      }) as ServerBootstrapDeps['runRemote'],
    })
    const { token } = await bootstrapRemoteServer(HOST, deps, (p) => rec.progress.push(p))
    expect(token).toBe('GENERATED_SECRET_TOKEN_abcdef0123456789')
    expect(rec.stored[HOST.id]).toBe(token) // fresh token persisted
    expect(ranDownload(cmds)).toBe(false) // restart in place, no re-download
    // Old server killed before the relaunch, token via stdin only.
    expect(cmds).toContain(KILL_MANAGED_SERVER_COMMAND)
    expect(cmds).toContain(buildRestartCommand(HOST.remotePort))
    expect(cmds.indexOf(KILL_MANAGED_SERVER_COMMAND)).toBeLessThan(
      cmds.indexOf(buildRestartCommand(HOST.remotePort)),
    )
    expect(stdins.filter(Boolean)).toEqual([token])
    expect(cmds.some((c) => c.includes('GENERATED_SECRET_TOKEN'))).toBe(false)
    expect(rec.progress.at(-1)!.phase).toBe('ready')
  })

  it('throws with an error phase when the restarted server never answers', async () => {
    const { deps, rec } = makeDeps({
      probeResults: [true, false, false, false], // alive, then never back up
      runRemote: (async (_h: unknown, cmd: string) =>
        cmd === CHECK_INSTALLED_COMMAND ? 'INSTALLED\n' : '') as ServerBootstrapDeps['runRemote'],
    })
    await expect(bootstrapRemoteServer(HOST, deps, (p) => rec.progress.push(p))).rejects.toThrow(
      /did not come back up/,
    )
    expect(rec.progress.at(-1)!.phase).toBe('error')
  })
})

describe('bootstrapRemoteServer — restart path (server died, install intact)', () => {
  const installedRunRemote =
    (rec: string[], stdins: (string | undefined)[], installedVersion = '1.0.0') =>
    async (_h: unknown, cmd: string, opts?: { stdin?: string }) => {
      rec.push(cmd)
      stdins.push(opts?.stdin)
      if (cmd === CHECK_INSTALLED_COMMAND) return 'INSTALLED\n'
      if (cmd === buildReadVersionCommand()) return installedVersion
      if (cmd.includes('uname')) return 'Darwin arm64\n'
      if (cmd.includes('tail')) return 'boom\n'
      return ''
    }

  it('restarts without re-downloading when installed and a token is stored', async () => {
    const cmds: string[] = []
    const stdins: (string | undefined)[] = []
    const { deps } = makeDeps({
      initialToken: 'STORED_TOKEN_0123456789abcdef',
      probeResults: [false, true], // dead on first check, up after restart
      runRemote: installedRunRemote(cmds, stdins) as ServerBootstrapDeps['runRemote'],
    })
    const { token } = await bootstrapRemoteServer(HOST, deps)
    expect(token).toBe('STORED_TOKEN_0123456789abcdef')
    expect(ranDownload(cmds)).toBe(false)
    expect(cmds).toContain(buildRestartCommand(HOST.remotePort))
    // Token still travels via stdin only.
    expect(stdins.filter(Boolean)).toEqual(['STORED_TOKEN_0123456789abcdef'])
    expect(cmds.some((c) => c.includes('STORED_TOKEN'))).toBe(false)
  })

  it('falls back to a full download+install when the restart does not bring the server up', async () => {
    const cmds: string[] = []
    const stdins: (string | undefined)[] = []
    const { deps } = makeDeps({
      initialToken: 'STORED_TOKEN_0123456789abcdef',
      // dead check, restart probes all fail (3 attempts), then up after reinstall
      probeResults: [false, false, false, false, true],
      runRemote: installedRunRemote(cmds, stdins) as ServerBootstrapDeps['runRemote'],
    })
    const { token } = await bootstrapRemoteServer(HOST, deps)
    expect(token).toBe('STORED_TOKEN_0123456789abcdef')
    expect(ranDownload(cmds)).toBe(true)
  })

  it('skips the restart probe entirely when nothing is installed', async () => {
    const { deps, rec } = makeDeps({
      initialToken: 'STORED_TOKEN_0123456789abcdef',
      probeResults: [false, true],
    })
    await bootstrapRemoteServer(HOST, deps)
    // Default mock returns '' for the install check → straight to full download+install.
    expect(ranDownload(rec.remoteCommands)).toBe(true)
  })
})

describe('bootstrapRemoteServer — version-aware upgrade', () => {
  it('upgrades a live server whose installed version is stale', async () => {
    const { deps, rec } = makeDeps({
      probeResults: [true, true], // alive now; up again after reinstall
      initialToken: 'EXISTING_TOKEN',
      appVersion: '2.0.0',
      installedVersion: '1.0.0',
    })
    const result = await bootstrapRemoteServer(HOST, deps, (p) => rec.progress.push(p))
    expect(result.token).toBe('EXISTING_TOKEN') // token reused across the upgrade
    // Stale live server killed, then the new version downloaded and stamped.
    expect(rec.remoteCommands).toContain(KILL_MANAGED_SERVER_COMMAND)
    expect(ranDownload(rec.remoteCommands)).toBe(true)
    expect(
      rec.remoteCommands.some((c) => c.includes(`printf '%s' '2.0.0' > ${REMOTE_VERSION_PATH}`)),
    ).toBe(true)
    expect(rec.progress.at(-1)!.phase).toBe('ready')
  })

  it('upgrades a live server with no version marker (legacy install)', async () => {
    const { deps, rec } = makeDeps({
      probeResults: [true, true],
      initialToken: 'EXISTING_TOKEN',
      appVersion: '2.0.0',
      installedVersion: '', // marker absent
    })
    await bootstrapRemoteServer(HOST, deps, (p) => rec.progress.push(p))
    expect(rec.remoteCommands).toContain(KILL_MANAGED_SERVER_COMMAND)
    expect(ranDownload(rec.remoteCommands)).toBe(true)
  })

  it('reinstalls instead of restarting a dead install on a stale version', async () => {
    const cmds: string[] = []
    const { deps } = makeDeps({
      initialToken: 'STORED_TOKEN_0123456789abcdef',
      appVersion: '2.0.0',
      probeResults: [false, true], // dead, then up after reinstall
      runRemote: (async (_h: unknown, cmd: string) => {
        cmds.push(cmd)
        if (cmd === CHECK_INSTALLED_COMMAND) return 'INSTALLED\n'
        if (cmd === buildReadVersionCommand()) return '1.0.0' // stale vs appVersion 2.0.0
        if (cmd.includes('uname')) return 'Darwin arm64\n'
        return ''
      }) as ServerBootstrapDeps['runRemote'],
    })
    await bootstrapRemoteServer(HOST, deps)
    // Version mismatch → skip the in-place restart, do a full re-download.
    expect(ranDownload(cmds)).toBe(true)
  })
})
