import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { androidPackages, androidSdkLevels, nodeVersion } from '../../scripts/toolchain.mjs'

const root = join(import.meta.dirname, '..', '..')

async function readJson(path) {
  return JSON.parse(await readFile(join(root, path), 'utf8'))
}

async function text(path) {
  return readFile(join(root, path), 'utf8')
}

describe('toolchain version policy', () => {
  it('single-sources the Node.js pin in .nvmrc', async () => {
    const pin = nodeVersion()
    expect(pin).toMatch(/^\d+\.\d+\.\d+$/)

    const packageJson = await readJson('package.json')
    expect(packageJson.engines.node).toBe(`>=${pin}`)

    const container = await text('container/Dockerfile')
    const arg = container.match(/ARG NODE_VERSION=(\S+)/)
    expect(arg?.[1], 'the container Node.js ARG must match .nvmrc').toBe(pin)
  })

  it('derives the Android SDK levels from the committed Gradle project', async () => {
    const levels = androidSdkLevels()
    const gradle = await text('src-tauri/gen/android/app/build.gradle.kts')

    expect(gradle).toContain(`compileSdk = ${levels.compileSdk}`)
    expect(gradle).toContain(`minSdk = ${levels.minSdk}`)
    expect(gradle).toContain(`targetSdk = ${levels.targetSdk}`)
  })

  it('keeps the Android packages single-sourced for CI and the container', async () => {
    const packages = androidPackages()
    const toolchain = await readJson('.toolchain.json')

    expect(packages.platforms).toEqual(toolchain.androidPlatforms)
    expect(packages.buildTools).toEqual(toolchain.androidBuildTools)
    expect(packages.ndk).toBe(toolchain.androidNdk)

    const workflow = await text('.github/workflows/release.yml')
    expect(workflow).toContain('node scripts/toolchain.mjs sdkmanager')
    expect(workflow).toContain('node scripts/toolchain.mjs ndk')
    expect(workflow).not.toContain('platforms;android-')

    const container = await text('container/Dockerfile')
    expect(container).toContain('/tmp/.toolchain.json')
    expect(container).not.toMatch(/platforms;android-37/)
    expect(container).not.toMatch(/build-tools;37\.0\.0/)
    expect(container).not.toMatch(/ndk;30\.0\./)
  })

  it('pins the latest stable iroh in the manifest and lockfile', async () => {
    const manifest = await text('src-tauri/Cargo.toml')
    expect(manifest).toContain('iroh = "=1.5.0"')

    const lock = await text('src-tauri/Cargo.lock')
    const iroh = lock.match(/\[\[package\]\]\nname = "iroh"\nversion = "([^"]+)"/)
    expect(iroh?.[1]).toBe('1.5.0')
  })

  it('keeps the documented Node.js prerequisite in sync', async () => {
    const readme = await text('README.md')
    expect(readme).toContain(`Node.js ≥ ${nodeVersion()}`)
  })
})
