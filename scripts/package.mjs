import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

const version = JSON.parse(readFileSync('package.json', 'utf8')).version
const targetDir = process.env.CARGO_TARGET_DIR || resolve('src-tauri', 'target')
const bundleDir = resolve(targetDir, 'release', 'bundle')

// Versions are checked, never synced, in a build: a build must not mutate its inputs.
run('npm', ['run', 'tauri:check'])
// `beforeBuildCommand` runs the renderer build once, so it is not repeated here.
run('npx', ['tauri', 'build', '--bundles', process.platform === 'linux' ? 'deb' : ''])

if (process.platform === 'linux') {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64'
  run('bash', [
    'scripts/build-appimage.sh',
    resolve(targetDir, 'release', 'hermes-iroh-app'),
    version,
    arch,
    resolve(bundleDir, 'appimage'),
  ])
}
