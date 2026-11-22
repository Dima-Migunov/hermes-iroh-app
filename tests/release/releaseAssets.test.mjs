import { mkdir, mkdtemp, readdir, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_INSTALLER_BYTES,
  checkInstallerSizes,
  collectAssets,
} from '../../scripts/release-assets.mjs'

const directories = []

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'release-assets-'))
  directories.push(directory)
  return directory
}

async function createBundleFixture() {
  const root = await temporaryDirectory()
  const bundle = join(root, 'bundle')

  const files = {
    'nsis/Hermes Iroh App_0.7.0_x64-setup.exe': 'x64',
    'nsis/Hermes Iroh App_0.7.0_arm64-setup.exe': 'arm64',
    'dmg/Hermes Iroh App_0.7.0_aarch64.dmg': 'dmg',
    'appimage/hermes-iroh-app_0.7.0_amd64.AppImage': 'appimage-x64',
    'appimage/hermes-iroh-app_0.7.0_aarch64.AppImage': 'appimage-arm64',
    'deb/hermes-iroh-app_0.7.0_amd64.deb': 'deb-x64',
    'deb/hermes-iroh-app_0.7.0_arm64.deb': 'deb-arm64',
    'apk/hermes-iroh-app-arm64-release.apk': 'apk-arm64',
  }

  for (const [relative, contents] of Object.entries(files)) {
    const path = join(bundle, relative)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, contents)
  }

  await mkdir(join(bundle, 'macos/Hermes Iroh App.app'), { recursive: true })
  await writeFile(join(bundle, 'macos/Hermes Iroh App.app/Contents'), 'app')

  return { root, bundle }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('release assets', () => {
  it('renames a Tauri output fixture into the nine published names', async () => {
    const { root, bundle } = await createBundleFixture()
    const output = join(root, 'release')

    const assets = await collectAssets({
      inputDirs: [bundle],
      outputDir: output,
      version: '0.7.0',
      ditto: async (_appPath, outputPath) => writeFile(outputPath, 'zip'),
    })

    expect(assets).toHaveLength(9)
    expect((await readdir(output)).sort()).toEqual(
      [
        'hermes-iroh-app-0.7.0-win-x64.exe',
        'hermes-iroh-app-0.7.0-win-arm64.exe',
        'hermes-iroh-app-0.7.0-mac-arm64.dmg',
        'hermes-iroh-app-0.7.0-mac-arm64.zip',
        'hermes-iroh-app-0.7.0-linux-x86_64.AppImage',
        'hermes-iroh-app-0.7.0-linux-arm64.AppImage',
        'hermes-iroh-app-0.7.0-linux-amd64.deb',
        'hermes-iroh-app-0.7.0-linux-arm64.deb',
        'hermes-iroh-app-0.7.0-android-arm64.apk',
      ].sort(),
    )
  })

  it('keeps one APK when several Android outputs are collected', async () => {
    const root = await temporaryDirectory()
    const first = join(root, 'first')
    const second = join(root, 'second')
    await mkdir(first, { recursive: true })
    await mkdir(second, { recursive: true })
    await writeFile(join(first, 'app-arm64-release.apk'), 'first')
    await writeFile(join(second, 'app-universal-release.apk'), 'second')

    const output = join(root, 'release')
    const assets = await collectAssets({
      inputDirs: [first, second],
      outputDir: output,
      version: '0.7.0',
    })

    expect(assets).toHaveLength(1)
    expect(await readdir(output)).toEqual(['hermes-iroh-app-0.7.0-android-arm64.apk'])
  })

  it('accepts installers at the size budget', async () => {
    const directory = await temporaryDirectory()
    await writeFile(join(directory, 'small.AppImage'), 'small')
    await writeFile(join(directory, 'exact.deb'), 'x')
    await truncate(join(directory, 'exact.deb'), MAX_INSTALLER_BYTES)

    const results = await checkInstallerSizes(directory)

    expect(results).toHaveLength(2)
    expect(results.find((entry) => entry.path.endsWith('.deb'))?.size).toBe(MAX_INSTALLER_BYTES)
  })

  it('fails when an installer exceeds the size budget', async () => {
    const directory = await temporaryDirectory()
    const installer = join(directory, 'oversized.exe')
    await writeFile(installer, 'x')
    await truncate(installer, MAX_INSTALLER_BYTES + 1)

    await expect(checkInstallerSizes(directory)).rejects.toThrow(/exceeding the/)
  })

  it('applies the size budget to the Android APK', async () => {
    const directory = await temporaryDirectory()
    const apk = join(directory, 'hermes-iroh-app-0.7.0-android-arm64.apk')
    await writeFile(apk, 'x')
    await truncate(apk, MAX_INSTALLER_BYTES + 1)

    await expect(checkInstallerSizes(directory)).rejects.toThrow(/exceeding the/)
  })

  it('fails when no installers are present', async () => {
    const directory = await temporaryDirectory()
    await writeFile(join(directory, 'notes.txt'), 'nothing')

    await expect(checkInstallerSizes(directory)).rejects.toThrow(/No installers/)
  })
})
