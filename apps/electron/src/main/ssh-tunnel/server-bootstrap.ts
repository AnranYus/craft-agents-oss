import type { SshHostConfig } from '@craft-agent/shared/config'
import type { RemoteTarget } from './server-artifact.ts'

export type BootstrapPhase =
  | 'checking-server'
  | 'detecting-os'
  | 'downloading-server'
  | 'installing-server'
  | 'starting-server'
  | 'waiting-for-server'
  | 'connecting-tunnel'
  | 'creating-workspace'
  | 'ready'
  | 'error'

export interface BootstrapProgress {
  phase: BootstrapPhase
  /** Human-readable detail (never contains secrets). */
  detail?: string
}

export interface BootstrapResult {
  /** The token the server was started with (managed secret). */
  token: string
}

/** Directory on the remote host where the managed server is installed. */
export const REMOTE_INSTALL_DIR = '~/.craft-agent/remote-server'
export const REMOTE_LOG_PATH = '~/.craft-agent/remote-server/server.log'
/** Token file on the remote (0600). The token travels over ssh stdin, never argv. */
export const REMOTE_TOKEN_PATH = '~/.craft-agent/remote-server/.token'
/** Version marker written on install; read on reconnect to detect a stale server. */
export const REMOTE_VERSION_PATH = '~/.craft-agent/remote-server/.version'

export interface RunRemoteOptions {
  /** Timeout for the remote command, ms. */
  timeoutMs?: number
  /** Data piped to the remote command's stdin. Transfers the token without it
   * ever appearing in any argv (local or remote `ps`). */
  stdin?: string
}

export interface ServerBootstrapDeps {
  /** Run a command over ssh on the remote host; resolves stdout. */
  runRemote: (host: SshHostConfig, command: string, opts?: RunRemoteOptions) => Promise<string>
  /** Detect remote target from `uname -sm`. */
  detectTarget: (unameOutput: string) => RemoteTarget
  /** Direct download URL of the prebuilt server archive for a target. */
  resolveDownloadUrl: (target: RemoteTarget) => string
  /** App version to install; a mismatch with the remote marker forces an upgrade. */
  appVersion: string
  /** Probe the (already forwarded) local port for a live server. */
  probe: () => Promise<boolean>
  /** Generate a fresh server auth token. */
  generateToken: () => string
  /** Persist the managed token for this host in the encrypted credential store. */
  storeToken: (hostId: string, token: string) => Promise<void>
  /** Read a previously stored managed token for this host, if any. */
  loadStoredToken: (hostId: string) => Promise<string | undefined>
  /** Injectable delay (ms) for probe retry loops. */
  sleep?: (ms: number) => Promise<void>
  /** Max attempts (with delay) to re-probe after starting the server. */
  probeAttempts?: number
  /** Delay between post-start probe attempts, ms. */
  probeIntervalMs?: number
}

const DEFAULT_PROBE_ATTEMPTS = 40
const DEFAULT_PROBE_INTERVAL_MS = 500

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** POSIX single-quote a string for safe embedding in a remote shell command. */
export function posixSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

/** Build the remote shell command that writes the token file from stdin. The
 * token is piped over ssh stdin so the secret never appears in any argv; umask 077 makes it 0600 from creation. */
export function buildWriteTokenCommand(): string {
  return (
    `mkdir -p ${REMOTE_INSTALL_DIR} && umask 077 && ` +
    `cat > ${REMOTE_TOKEN_PATH} && chmod 600 ${REMOTE_TOKEN_PATH}`
  )
}

/** Build the remote shell command that installs an uploaded archive and starts
 * the server. The token is read from the 0600 file, never argv; detached under nohup. */
function buildLaunch(remotePort: number): string {
  // The `$(cat ...)` stays literal in argv, so `ps` never shows the token.
  // CRAFT_CONFIG_DIR isolates the managed server's state from any user craft instance.
  return (
    `CRAFT_SERVER_TOKEN="$(cat ${REMOTE_TOKEN_PATH})" CRAFT_RPC_PORT=${remotePort} ` +
    `CRAFT_CONFIG_DIR=${REMOTE_INSTALL_DIR}/config ` +
    `nohup ${REMOTE_INSTALL_DIR}/start.sh > ${REMOTE_LOG_PATH} 2>&1 < /dev/null &`
  )
}

/** Detached launcher: `sh -c '... &'` with all fds redirected so ssh returns immediately. */
function detach(launch: string): string {
  // Must fully detach so the ssh channel closes immediately (else ssh blocks
  // until the server exits and times out): nohup + background, all fds redirected.
  return `sh -c ${posixSingleQuote(launch)} > /dev/null 2>&1 < /dev/null`
}

/** Temp path on the remote for the downloaded archive. */
export const REMOTE_DOWNLOAD_TMP = '~/.craft-agent/craft-server-download.tar.gz'

/** Remote command that downloads the prebuilt archive with curl (wget fallback),
 * both following redirects (GitHub release -> CDN). */
export function buildDownloadCommand(url: string): string {
  const q = posixSingleQuote(url)
  return (
    `mkdir -p ${REMOTE_INSTALL_DIR} && ` +
    `if command -v curl >/dev/null 2>&1; then curl -fL --retry 3 --connect-timeout 20 -o ${REMOTE_DOWNLOAD_TMP} ${q}; ` +
    `elif command -v wget >/dev/null 2>&1; then wget -q -O ${REMOTE_DOWNLOAD_TMP} ${q}; ` +
    `else echo 'neither curl nor wget is available on the remote host' >&2; exit 1; fi`
  )
}

/** Read the installed version marker; empty when absent (legacy/first install). */
export function buildReadVersionCommand(): string {
  return `cat ${REMOTE_VERSION_PATH} 2>/dev/null || true`
}

/** Remove stale code (keeping the token file + server state), extract the archive,
 * stamp its version, and drop the temp download. */
export function buildExtractCommand(version: string): string {
  return [
    `find ${REMOTE_INSTALL_DIR} -mindepth 1 -maxdepth 1 ! -name .token ! -name config -exec rm -rf {} +`,
    `tar -xzf ${REMOTE_DOWNLOAD_TMP} -C ${REMOTE_INSTALL_DIR}`,
    `chmod +x ${REMOTE_INSTALL_DIR}/start.sh ${REMOTE_INSTALL_DIR}/bin/craft-server ${REMOTE_INSTALL_DIR}/vendor/bun/bun 2>/dev/null || true`,
    `printf '%s' ${posixSingleQuote(version)} > ${REMOTE_VERSION_PATH}`,
    `rm -f ${REMOTE_DOWNLOAD_TMP}`,
  ].join(' && ')
}

/** Restart an already-installed server without re-uploading the artifact — the
 * path taken when the process died but the install dir is intact. */
export function buildRestartCommand(remotePort: number): string {
  return detach(buildLaunch(remotePort))
}

/** Shell test used to decide the restart-only path: is a runnable install present? */
export const CHECK_INSTALLED_COMMAND = `test -x ${REMOTE_INSTALL_DIR}/start.sh && echo INSTALLED || true`

/** Kill a running app-managed server so it can be relaunched with a new token.
 * The `[.]` bracket keeps the pattern from matching the shell running this command. */
export const KILL_MANAGED_SERVER_COMMAND =
  `pkill -f '[.]craft-agent/remote-server' 2>/dev/null || true`

/** Run the full bootstrap. Assumes the SSH tunnel is already established and the
 * remote server port is forwarded locally (so `probe()` targets it). */
export async function bootstrapRemoteServer(
  host: SshHostConfig,
  deps: ServerBootstrapDeps,
  onProgress: (p: BootstrapProgress) => void = () => {},
): Promise<BootstrapResult> {
  const sleep = deps.sleep ?? defaultSleep
  const probeAttempts = deps.probeAttempts ?? DEFAULT_PROBE_ATTEMPTS
  const probeIntervalMs = deps.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS

  // 1. A live server on our current version is reused; a stale/unmarked one is
  //    killed and reinstalled below (forceReinstall).
  onProgress({ phase: 'checking-server' })
  const alreadyAlive = await deps.probe()
  const stored = await deps.loadStoredToken(host.id)
  let forceReinstall = false
  if (alreadyAlive && stored) {
    const installedVersion = (await deps.runRemote(host, buildReadVersionCommand())).trim()
    if (installedVersion === deps.appVersion) {
      onProgress({ phase: 'ready' })
      return { token: stored }
    }
    onProgress({ phase: 'checking-server', detail: `upgrading ${installedVersion || 'unknown'} -> ${deps.appVersion}` })
    await deps.runRemote(host, KILL_MANAGED_SERVER_COMMAND)
    forceReinstall = true
  } else if (alreadyAlive) {
    // A server answers but we hold no token for it. If OUR install dir is present,
    // it's a managed server whose token we lost — restart with a fresh token.
    const installed = (await deps.runRemote(host, CHECK_INSTALLED_COMMAND)).includes('INSTALLED')
    if (installed) {
      const token = deps.generateToken()
      await deps.storeToken(host.id, token)
      onProgress({ phase: 'starting-server', detail: 'restart' })
      await deps.runRemote(host, buildWriteTokenCommand(), { stdin: token })
      // The old (token-less to us) server still holds the port; kill it first.
      await deps.runRemote(host, KILL_MANAGED_SERVER_COMMAND)
      await deps.runRemote(host, buildRestartCommand(host.remotePort))
      onProgress({ phase: 'waiting-for-server' })
      for (let attempt = 0; attempt < probeAttempts; attempt++) {
        if (await deps.probe()) {
          onProgress({ phase: 'ready' })
          return { token }
        }
        await sleep(probeIntervalMs)
      }
      const detail = 'The managed server did not come back up after a restart with a new token.'
      onProgress({ phase: 'error', detail })
      throw new Error(detail)
    }
    // A server we don't manage occupies the port. Installing another would fail
    // to bind and the re-probe would hit the old server — fail fast with a clear message.
    const detail =
      `A server is already running on port ${host.remotePort} on this host, but it is not managed by this app. ` +
      `Connect to it via "Connect to remote server" (with its own token), or change this host's server port to install a managed server.`
    onProgress({ phase: 'error', detail })
    throw new Error(detail)
  }

  // 2. Server not answering but the install is intact (process died: crash,
  //    reboot, OOM) — restart in place when the installed version still matches.
  if (!forceReinstall && stored) {
    const installed = (await deps.runRemote(host, CHECK_INSTALLED_COMMAND)).includes('INSTALLED')
    const installedVersion = installed
      ? (await deps.runRemote(host, buildReadVersionCommand())).trim()
      : ''
    if (installed && installedVersion === deps.appVersion) {
      onProgress({ phase: 'starting-server', detail: 'restart' })
      // Re-write the token file (cheap to refresh) and relaunch; fall through to
      // a full reinstall if the restart doesn't bring the server up.
      await deps.runRemote(host, buildWriteTokenCommand(), { stdin: stored })
      await deps.runRemote(host, buildRestartCommand(host.remotePort))
      onProgress({ phase: 'waiting-for-server' })
      for (let attempt = 0; attempt < probeAttempts; attempt++) {
        if (await deps.probe()) {
          onProgress({ phase: 'ready' })
          return { token: stored }
        }
        await sleep(probeIntervalMs)
      }
      // Restart failed — continue into the full install path below.
    }
  }

  // 3. Detect the remote OS/arch, then write the token file (0600, never argv).
  onProgress({ phase: 'detecting-os' })
  const uname = await deps.runRemote(host, 'uname -sm')
  const target = deps.detectTarget(uname)

  const token = stored ?? deps.generateToken()
  await deps.storeToken(host.id, token)
  await deps.runRemote(host, buildWriteTokenCommand(), { stdin: token })

  // 4. Download the prebuilt archive directly onto the remote — no local build,
  //    no upload. A small VPS only downloads + extracts, never compiles.
  const url = deps.resolveDownloadUrl(target)
  onProgress({ phase: 'downloading-server', detail: `${target.platform}-${target.arch}` })
  try {
    await deps.runRemote(host, buildDownloadCommand(url), { timeoutMs: 600_000 })
  } catch (err) {
    const detail =
      `Failed to download the server for ${target.platform}-${target.arch}. Check the remote ` +
      `has internet access and that a release exists for this app version.`
    onProgress({ phase: 'error', detail })
    throw new Error(`${detail} (${err instanceof Error ? err.message : String(err)})`)
  }

  // 5. Extract, then start the server detached.
  onProgress({ phase: 'installing-server' })
  await deps.runRemote(host, buildExtractCommand(deps.appVersion), { timeoutMs: 180_000 })

  onProgress({ phase: 'starting-server' })
  await deps.runRemote(host, buildRestartCommand(host.remotePort))

  // 6. Re-probe until the server answers.
  onProgress({ phase: 'waiting-for-server' })
  for (let attempt = 0; attempt < probeAttempts; attempt++) {
    if (await deps.probe()) {
      onProgress({ phase: 'ready' })
      return { token }
    }
    await sleep(probeIntervalMs)
  }

  // Failure — surface a tail of the remote log to help diagnosis (no secrets in it).
  let logTail = ''
  try {
    logTail = (await deps.runRemote(host, `tail -n 30 ${REMOTE_LOG_PATH} 2>/dev/null || true`)).trim()
  } catch {
    /* best effort */
  }
  const detail = logTail
    ? `Server did not come up in time. Remote log tail:\n${logTail}`
    : 'Server did not come up in time and no remote log was available.'
  onProgress({ phase: 'error', detail })
  throw new Error(detail)
}
