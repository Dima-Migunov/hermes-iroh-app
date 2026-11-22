import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const packagePath = resolve(root, 'package.json')
const tauriConfigPath = resolve(root, 'src-tauri/tauri.conf.json')

const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'))
const packageVersion = packageJson.version
if (typeof packageVersion !== 'string' || packageVersion.length === 0) {
  throw new Error('package.json does not contain a version.')
}

const mode = process.argv[2]
if (mode !== 'sync' && mode !== 'check') {
  throw new Error('Usage: node scripts/tauri-version.mjs <sync|check>')
}

const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, 'utf8'))
const tauriVersion = tauriConfig.version

if (mode === 'check') {
  const errors = []
  if (tauriVersion !== packageVersion) {
    errors.push(
      `tauri.conf.json version ${tauriVersion} does not match package.json version ${packageVersion}`,
    )
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

  console.log(`Version ${packageVersion} is consistent.`)
  process.exit(0)
}

if (tauriVersion !== packageVersion) {
  tauriConfig.version = packageVersion
  writeFileSync(tauriConfigPath, `${JSON.stringify(tauriConfig, null, 2)}\n`)
  console.log(`Synced tauri.conf.json to version ${packageVersion}.`)
} else {
  console.log(`tauri.conf.json already at version ${packageVersion}.`)
}
