import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..', '..')

async function readJson(path) {
  return JSON.parse(await readFile(join(root, path), 'utf8'))
}

async function text(path) {
  return readFile(join(root, path), 'utf8')
}

describe('toolchain version policy', () => {
  it('uses the latest stable Node.js in engines and every CI job', async () => {
    const packageJson = await readJson('package.json')
    expect(packageJson.engines.node).toBe('>=26.13.1')

    const workflow = await text('.github/workflows/release.yml')
    const nodeVersions = [...workflow.matchAll(/node-version:\s*(\S+)/g)].map(
      (match) => match[1],
    )
    expect(nodeVersions).toEqual(['26.13.1', '26.13.1', '26.13.1'])
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
    expect(readme).toContain('Node.js ≥ 26.13.1')
  })
})
