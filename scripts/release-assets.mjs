import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

export const MAX_INSTALLER_BYTES = 25_000_000

const INSTALLER_PATTERN = /\.(exe|dmg|zip|AppImage|deb|apk)$/

/**
 * The single source of truth for release asset naming and verification.
 * `count` is the number of that asset the release publishes.
 */
export const RELEASE_ASSETS = Object.freeze([
  Object.freeze({ kind: 'exe', platform: 'win', arch: 'x64', count: 1 }),
  Object.freeze({ kind: 'exe', platform: 'win', arch: 'arm64', count: 1 }),
  Object.freeze({ kind: 'dmg', platform: 'mac', arch: 'arm64', count: 1 }),
  Object.freeze({ kind: 'zip', platform: 'mac', arch: 'arm64', count: 1 }),
  Object.freeze({ kind: 'AppImage', platform: 'linux', arch: 'x86_64', count: 1 }),
  Object.freeze({ kind: 'AppImage', platform: 'linux', arch: 'arm64', count: 1 }),
  Object.freeze({ kind: 'deb', platform: 'linux', arch: 'amd64', count: 1 }),
  Object.freeze({ kind: 'deb', platform: 'linux', arch: 'arm64', count: 1 }),
  Object.freeze({ kind: 'apk', platform: 'android', arch: 'arm64', count: 1 }),
])

export function publishedName({ kind, version, arch }) {
  const asset = RELEASE_ASSETS.find((entry) => entry.kind === kind && entry.arch === arch)
  if (!asset) {
    throw new Error(`Unsupported release asset: ${kind}/${arch}`)
  }
  return `hermes-iroh-app-${version}-${asset.platform}-${asset.arch}.${asset.kind}`
}

/** Every asset name a release publishes for a given version. */
export function expectedAssetNames(version) {
  const names = []
  for (const asset of RELEASE_ASSETS) {
    for (let index = 0; index < asset.count; index += 1) {
      names.push(publishedName({ kind: asset.kind, version, arch: asset.arch }))
    }
  }
  return names.sort()
}

function archFromName(name, kind) {
  if (kind === 'dmg' || kind === 'zip' || kind === 'apk') return 'arm64'

  const normalized = name.toLowerCase()
  if (normalized.includes('arm64') || normalized.includes('aarch64')) return 'arm64'
  if (kind === 'AppImage') return 'x86_64'
  if (kind === 'deb') return 'amd64'
  return 'x64'
}

async function listEntries(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const results = []

  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name.endsWith('.app')) {
        results.push({ path, directory: true })
      } else {
        results.push(...(await listEntries(path)))
      }
    } else {
      results.push({ path, directory: false })
    }
  }

  return results
}

function dittoArchive(appPath, outputPath) {
  const result = spawnSync('ditto', ['-c', '-k', '--keepParent', appPath, outputPath], {
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    throw new Error(`ditto failed with exit code ${result.status ?? 'unknown'}`)
  }
}

function installerKind(name) {
  if (name.endsWith('.exe')) return 'exe'
  if (name.endsWith('.dmg')) return 'dmg'
  if (name.endsWith('.zip')) return 'zip'
  if (name.endsWith('.AppImage')) return 'AppImage'
  if (name.endsWith('.deb')) return 'deb'
  if (name.endsWith('.apk')) return 'apk'
  return null
}

export async function collectAssets({
  inputDirs,
  outputDir,
  version,
  ditto = dittoArchive,
}) {
  if (!Array.isArray(inputDirs) || inputDirs.length === 0) {
    throw new Error('At least one input directory is required.')
  }
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('A version is required.')
  }

  await rm(outputDir, { recursive: true, force: true })
  await mkdir(outputDir, { recursive: true })

  const entries = []
  for (const inputDir of inputDirs) {
    entries.push(...(await listEntries(inputDir)))
  }

  const assets = []
  const destinations = new Set()

  for (const entry of entries) {
    if (entry.directory && entry.path.endsWith('.app')) {
      const destination = join(outputDir, publishedName({ kind: 'zip', version, arch: 'arm64' }))
      if (destinations.has(destination)) {
        throw new Error(`Two sources resolve to the same release asset: ${destination}`)
      }
      await ditto(entry.path, destination)
      destinations.add(destination)
      assets.push({ source: entry.path, destination })
      continue
    }

    if (entry.directory) continue

    const kind = installerKind(basename(entry.path))
    if (!kind) continue

    const arch = archFromName(basename(entry.path), kind)
    const destination = join(outputDir, publishedName({ kind, version, arch }))
    if (destinations.has(destination)) {
      throw new Error(
        `Two sources resolve to the same release asset: ${destination} (from ${entry.path})`,
      )
    }

    await copyFile(entry.path, destination)
    destinations.add(destination)
    assets.push({ source: entry.path, destination })
  }

  return assets.sort((left, right) => left.destination.localeCompare(right.destination))
}

export async function verifyAssetSet(directory, version) {
  const entries = await readdir(directory, { withFileTypes: true })
  const present = entries
    .filter((entry) => entry.isFile() && INSTALLER_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort()

  const expected = expectedAssetNames(version)
  const missing = expected.filter((name) => !present.includes(name))
  const unexpected = present.filter((name) => !expected.includes(name))

  if (missing.length > 0 || unexpected.length > 0) {
    const details = [
      missing.length > 0 ? `missing: ${missing.join(', ')}` : '',
      unexpected.length > 0 ? `unexpected: ${unexpected.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('; ')
    throw new Error(`Release asset set is incomplete (${details})`)
  }

  return present
}

export async function checkInstallerSizes(directory, maxBytes = MAX_INSTALLER_BYTES) {
  const entries = await listEntries(directory)
  const installers = entries.filter(
    (entry) => !entry.directory && INSTALLER_PATTERN.test(entry.path),
  )

  if (installers.length === 0) {
    throw new Error(`No installers were found in ${directory}.`)
  }

  const results = []
  for (const entry of installers) {
    const { size } = await stat(entry.path)
    results.push({ path: entry.path, size })
    if (size > maxBytes) {
      throw new Error(
        `Installer ${entry.path} is ${size} bytes, exceeding the ${maxBytes}-byte budget.`,
      )
    }
  }

  return results.sort((left, right) => left.path.localeCompare(right.path))
}
