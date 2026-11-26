import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const packagePath = resolve(root, 'package.json')
const tauriConfigPath = resolve(root, 'src-tauri/tauri.conf.json')
const cargoManifestPath = resolve(root, 'src-tauri/Cargo.toml')
const packageLockPath = resolve(root, 'package-lock.json')
const cargoLockPath = resolve(root, 'src-tauri/Cargo.lock')
const CARGO_PACKAGE_NAME = 'hermes-iroh-app'

const mode = process.argv[2]
if (mode !== 'sync' && mode !== 'check') {
  throw new Error('Usage: node scripts/tauri-version.mjs <sync|check>')
}

function readPackageVersion() {
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'))
  const version = packageJson.version
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('package.json does not contain a version.')
  }
  return version
}

/** Reads the `[package]` version from Cargo.toml without a toml parser dependency. */
function readCargoManifestVersion(text) {
  const match = text.match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)
  return match?.[1]
}

function writeCargoManifestVersion(text, version) {
  return text.replace(
    /(^\[package\][\s\S]*?^version\s*=\s*)"[^"]+"/m,
    (_match, prefix) => `${prefix}"${version}"`,
  )
}

/** Reads `version` from the `[[package]]` block named `name` in a Cargo.lock. */
function readCargoLockVersion(text, name) {
  const blocks = text.split('[[package]]')
  for (const block of blocks) {
    const nameMatch = block.match(/^\s*name\s*=\s*"([^"]+)"/m)
    if (nameMatch?.[1] !== name) continue
    return block.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1]
  }
  return undefined
}

function writeCargoLockVersion(text, name, version) {
  const blocks = text.split('[[package]]')
  const updated = blocks.map((block) => {
    const nameMatch = block.match(/^\s*name\s*=\s*"([^"]+)"/m)
    if (nameMatch?.[1] !== name) return block
    return block.replace(/(^\s*version\s*=\s*)"[^"]+"/m, `$1"${version}"`)
  })
  return updated.join('[[package]]')
}

function readPackageLockVersion() {
  return JSON.parse(readFileSync(packageLockPath, 'utf8')).version
}

function writePackageLockVersion(version) {
  const lock = JSON.parse(readFileSync(packageLockPath, 'utf8'))
  lock.version = version
  if (lock.packages?.['']) {
    lock.packages[''].version = version
  }
  writeFileSync(packageLockPath, `${JSON.stringify(lock, null, 2)}\n`)
}

function readTauriVersion() {
  return JSON.parse(readFileSync(tauriConfigPath, 'utf8')).version
}

function writeTauriVersion(version) {
  const config = JSON.parse(readFileSync(tauriConfigPath, 'utf8'))
  config.version = version
  writeFileSync(tauriConfigPath, `${JSON.stringify(config, null, 2)}\n`)
}

function readCargoVersion() {
  return readCargoManifestVersion(readFileSync(cargoManifestPath, 'utf8'))
}

function readCargoLockRootVersion() {
  return readCargoLockVersion(readFileSync(cargoLockPath, 'utf8'), CARGO_PACKAGE_NAME)
}

const packageVersion = readPackageVersion()

/** Every manifest and lockfile root that must agree with `package.json`. */
function collectVersions() {
  return [
    ['src-tauri/tauri.conf.json', readTauriVersion()],
    ['src-tauri/Cargo.toml', readCargoVersion()],
    ['package-lock.json', readPackageLockVersion()],
    ['src-tauri/Cargo.lock', readCargoLockRootVersion()],
  ]
}

if (mode === 'check') {
  const errors = []
  for (const [name, version] of collectVersions()) {
    if (version !== packageVersion) {
      errors.push(`${name} version ${version} does not match package.json version ${packageVersion}`)
    }
  }

  const tag = process.env.GITHUB_REF_NAME
  if (tag !== undefined && tag.length > 0) {
    const expectedTag = `v${packageVersion}`
    if (tag !== expectedTag) {
      errors.push(`Tag ${tag} does not match package.json version ${expectedTag}`)
    }
  }

  if (errors.length > 0) {
    for (const error of errors) console.error(`::error::${error}`)
    process.exit(1)
  }

  console.log(`Version ${packageVersion} is consistent across every manifest and lockfile.`)
  process.exit(0)
}

writeTauriVersion(packageVersion)
writeFileSync(
  cargoManifestPath,
  writeCargoManifestVersion(readFileSync(cargoManifestPath, 'utf8'), packageVersion),
)
writePackageLockVersion(packageVersion)
writeFileSync(
  cargoLockPath,
  writeCargoLockVersion(
    readFileSync(cargoLockPath, 'utf8'),
    CARGO_PACKAGE_NAME,
    packageVersion,
  ),
)
console.log(`Synced every manifest and lockfile to version ${packageVersion}.`)
