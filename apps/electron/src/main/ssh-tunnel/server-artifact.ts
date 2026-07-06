export type RemotePlatform = 'linux' | 'darwin'
export type RemoteArch = 'x64' | 'arm64'

export interface RemoteTarget {
  platform: RemotePlatform
  arch: RemoteArch
}

/** Parse the output of `uname -sm` into a supported target, or throw. */
export function parseUnameTarget(unameOutput: string): RemoteTarget {
  const parts = unameOutput.trim().split(/\s+/)
  const sys = (parts[0] ?? '').toLowerCase()
  const machine = (parts[1] ?? '').toLowerCase()

  let platform: RemotePlatform
  if (sys === 'linux') platform = 'linux'
  else if (sys === 'darwin') platform = 'darwin'
  else throw new Error(`Unsupported remote OS "${parts[0] || 'unknown'}" (only Linux and macOS are supported).`)

  let arch: RemoteArch
  if (machine === 'x86_64' || machine === 'amd64') arch = 'x64'
  else if (machine === 'arm64' || machine === 'aarch64') arch = 'arm64'
  else throw new Error(`Unsupported remote architecture "${parts[1] || 'unknown'}" (only x64 and arm64 are supported).`)

  return { platform, arch }
}

/** Where prebuilt server archives are published, per app version (release tag
 * `v<version>`). Override with CRAFT_SERVER_RELEASE_BASE for a mirror/CDN. */
export const DEFAULT_SERVER_RELEASE_BASE =
  'https://github.com/AnranYus/craft-agents-oss/releases/download'

/** Basename of the prebuilt server archive for a target + app version. */
export function serverArchiveName(target: RemoteTarget, version: string): string {
  return `craft-server-${version}-${target.platform}-${target.arch}.tar.gz`
}

/** Direct download URL of the prebuilt server archive. The remote host fetches
 * this itself — nothing is built locally or on the remote. */
export function buildServerDownloadUrl(
  target: RemoteTarget,
  version: string,
  baseUrl: string = process.env.CRAFT_SERVER_RELEASE_BASE || DEFAULT_SERVER_RELEASE_BASE,
): string {
  return `${baseUrl.replace(/\/+$/, '')}/v${version}/${serverArchiveName(target, version)}`
}
