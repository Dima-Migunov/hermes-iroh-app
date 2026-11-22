import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

export const MAX_INSTALLER_BYTES = 25_000_000

const INSTALLER_PATTERN = /\.(exe|dmg|zip|AppImage|deb)$/

export function publishedName({ kind, version, arch }) {
  if (kind === 'exe') {
    return `hermes-iroh-app-${version}-win-${arch === 'arm64' ? 'arm64' : 'x64'}.exe`
  }
  if (kind === 'dmg') {
    return `hermes-iroh-app-${version}-mac-arm64.dmg`
  }
  if (kind === 'zip') {
    return `hermes-iroh-app-${version}-mac-arm64.zip`
  }

  const linuxArch = arch === 'arm64' ? 'arm64' : kind === 'AppImage' ? 'x86_64' : 'amd64'
  return `hermes-iroh-app-${version}-linux-${linuxArch}.${kind}`
}

function archFromName(name, kind) {
  if (kind === 'dmg' || kind === 'zip') return 'arm64'

  const normalized = name.toLowerCase()
  if (normalized.includes('arm64') || normalized.includes('aarch64')) return 'arm64'
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

  await mkdir(outputDir, { recursive: true })

  const entries = []
  for (const inputDir of inputDirs) {
    entries.push(...(await listEntries(inputDir)))
  }

  const assets = []
  const destinations = new Set()

  for (const entry of entries) {
    if (entry.directory && entry.path.endsWith('.app')) {
      const destination = join(
        outputDir,
        publishedName({ kind: 'zip', version, arch: 'arm64' }),
      )
      if (destinations.has(destination)) continue
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
    if (destinations.has(destination)) continue

    await copyFile(entry.path, destination)
    destinations.add(destination)
    assets.push({ source: entry.path, destination })
  }

  return assets.sort((left, right) => left.destination.localeCompare(right.destination))
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
