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

run('npm', ['run', 'tauri:sync'])
run('npm', ['run', 'build'])

if (process.platform === 'linux') {
  run('npx', ['tauri', 'build', '--bundles', 'deb'])
  const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64'
  run('bash', [
    'scripts/build-appimage.sh',
    resolve(targetDir, 'release', 'hermes-iroh-app'),
    version,
    arch,
    resolve(targetDir, 'release', 'bundle', 'appimage'),
  ])
} else {
  run('npx', ['tauri', 'build'])
}
