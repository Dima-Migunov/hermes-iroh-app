import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..', '..')
const configPath = join(root, 'src-tauri/tauri.conf.json')
const androidConfigPath = join(root, 'src-tauri/tauri.android.conf.json')
const capabilityPath = join(root, 'src-tauri/capabilities/default.json')

async function loadJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

describe('desktop configuration contract', () => {
  it('does not expose a raw Tauri global', async () => {
    const config = await loadJson(configPath)
    expect(config.app.withGlobalTauri).toBe(false)
  })

  it('restricts production content and connections', async () => {
    const config = await loadJson(configPath)
    const csp = config.app.security.csp
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain('connect-src ipc: http://ipc.localhost')
    expect(csp).not.toContain('localhost:1420')
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("object-src 'none'")

    const devCsp = config.app.security.devCsp
    expect(devCsp).toContain('http://localhost:1420')
    expect(devCsp).toContain('ws://localhost:1420')
  })

  it('grants only core permissions to the main window', async () => {
    const capability = await loadJson(capabilityPath)
    expect(capability.windows).toEqual(['main'])
    expect(capability.permissions).toEqual(['core:default'])
    expect(JSON.stringify(capability)).not.toMatch(/shell|filesystem|process|webview:allow-create/)
  })

  it('declares every supported bundle and the release metadata', async () => {
    const config = await loadJson(configPath)
    expect(config.bundle.targets.sort()).toEqual(['app', 'appimage', 'deb', 'dmg', 'nsis'])
    expect(config.bundle.linux.deb.depends).toContain('libwebkit2gtk-4.1-0')
    expect(config.bundle.linux.appimage.bundleMediaFramework).toBe(false)
    expect(config.bundle.macOS.signingIdentity).toBe('-')
    expect(config.bundle.macOS.hardenedRuntime).toBe(false)
    expect(config.identifier).toBe('com.number0.hermes-iroh-app')
  })

  it('ships every icon referenced by the bundle', async () => {
    const config = await loadJson(configPath)
    for (const icon of config.bundle.icon) {
      expect(existsSync(join(root, 'src-tauri', icon)), icon).toBe(true)
    }
  })

  it('builds the renderer from the Vite output directory', async () => {
    const config = await loadJson(configPath)
    expect(config.build.frontendDist).toBe('../out/renderer')
    expect(config.build.devUrl).toBe('http://localhost:1420')
    expect(config.build.beforeDevCommand).toBe('npm run dev')
    expect(config.build.beforeBuildCommand).toBe('npm run build')
  })
})

describe('android configuration contract', () => {
  it('overrides the identifier with a hyphen-free package name', async () => {
    const config = await loadJson(androidConfigPath)
    expect(config.identifier).toBe('com.number0.hermesirohapp')
    expect(config.identifier).not.toContain('-')
  })

  it('supports Android 7.0 and newer', async () => {
    const config = await loadJson(androidConfigPath)
    expect(config.bundle.android.minSdkVersion).toBe(24)
  })
})
