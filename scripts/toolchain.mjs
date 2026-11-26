import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

/** The single source for the Node.js pin: `.nvmrc`. */
export function nodeVersion() {
  return readFileSync(resolve(root, '.nvmrc'), 'utf8').trim()
}

/** Values the committed Gradle project already declares, so CI cannot drift from it. */
export function androidSdkLevels() {
  const gradle = readFileSync(
    resolve(root, 'src-tauri/gen/android/app/build.gradle.kts'),
    'utf8',
  )
  const compileSdk = gradle.match(/compileSdk\s*=\s*(\d+)/)?.[1]
  const minSdk = gradle.match(/minSdk\s*=\s*(\d+)/)?.[1]
  const targetSdk = gradle.match(/targetSdk\s*=\s*(\d+)/)?.[1]

  if (!compileSdk || !minSdk || !targetSdk) {
    throw new Error('The committed Gradle project is missing a compileSdk/minSdk/targetSdk pin.')
  }
  return { compileSdk: Number(compileSdk), minSdk: Number(minSdk), targetSdk: Number(targetSdk) }
}

/** Android SDK packages and NDK that CI and the container install. */
export function androidPackages() {
  const toolchain = JSON.parse(readFileSync(resolve(root, '.toolchain.json'), 'utf8'))
  const levels = androidSdkLevels()
  return {
    platforms: toolchain.androidPlatforms,
    buildTools: toolchain.androidBuildTools,
    ndk: toolchain.androidNdk,
    compileSdk: levels.compileSdk,
  }
}

if (process.argv[1] && process.argv[1].endsWith('toolchain.mjs')) {
  const mode = process.argv[2]
  if (mode === 'node') {
    console.log(nodeVersion())
  } else if (mode === 'ndk') {
    console.log(androidPackages().ndk)
  } else if (mode === 'sdkmanager') {
    const { platforms, buildTools, ndk } = androidPackages()
    const packages = [
      'platform-tools',
      ...platforms.map((platform) => `platforms;android-${platform}`),
      ...buildTools.map((tool) => `build-tools;${tool}`),
      `ndk;${ndk}`,
    ]
    process.stdout.write(packages.map((name) => `"${name}"`).join(' \\\n    '))
    process.stdout.write('\n')
  } else {
    throw new Error('Usage: node scripts/toolchain.mjs <node|sdkmanager|ndk>')
  }
}
