import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..', '..')
const script = join(root, 'scripts', 'tauri-version.mjs')
const manifests = [
  'package.json',
  'package-lock.json',
  'src-tauri/tauri.conf.json',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
]

const workspaces = []

async function createWorkspace() {
  const workspace = await mkdtemp(join(tmpdir(), 'version-check-'))
  workspaces.push(workspace)
  await cp(join(root, 'scripts'), join(workspace, 'scripts'), { recursive: true })
  await cp(join(root, 'src-tauri', 'Cargo.toml'), join(workspace, 'src-tauri/Cargo.toml'))
  await cp(join(root, 'src-tauri', 'Cargo.lock'), join(workspace, 'src-tauri/Cargo.lock'))
  await cp(join(root, 'src-tauri', 'tauri.conf.json'), join(workspace, 'src-tauri/tauri.conf.json'))
  await cp(join(root, 'package.json'), join(workspace, 'package.json'))
  await cp(join(root, 'package-lock.json'), join(workspace, 'package-lock.json'))
  return workspace
}

function run(workspace, mode = 'check') {
  return spawnSync(process.execPath, [join(workspace, 'scripts', 'tauri-version.mjs'), mode], {
    cwd: workspace,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_REF_NAME: '', GITHUB_REF_TYPE: '' },
  })
}

async function packageVersion(workspace) {
  return JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8')).version
}

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map((workspace) => rm(workspace, { recursive: true, force: true })),
  )
})

describe('version synchronization', () => {
  it('accepts the committed manifests', async () => {
    const workspace = await createWorkspace()
    const result = run(workspace)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('is consistent')
  })

  it.each([
    ['src-tauri/tauri.conf.json', (value) => value.replace(/"version": "[^"]+"/, '"version": "9.9.9"')],
    ['src-tauri/Cargo.toml', (value) => value.replace(/^version = "[^"]+"/m, 'version = "9.9.9"')],
    [
      'src-tauri/Cargo.lock',
      (value) =>
        value.replace(
          /(name = "hermes-iroh-app"\nversion = )"[^"]+"/,
          '$1"9.9.9"',
        ),
    ],
    [
      'package-lock.json',
      (value) => value.replace(/^  "version": "[^"]+"/m, '  "version": "9.9.9"'),
    ],
  ])('fails when %s drifts', async (relative, mutate) => {
    const workspace = await createWorkspace()
    const path = join(workspace, relative)
    await writeFile(path, mutate(await readFile(path, 'utf8')))

    const result = run(workspace)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(relative)
  })

  it('fails when the tag does not match the package version', async () => {
    const workspace = await createWorkspace()
    const version = await packageVersion(workspace)
    const result = spawnSync(process.execPath, [join(workspace, 'scripts', 'tauri-version.mjs'), 'check'], {
      cwd: workspace,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_REF_NAME: 'v9.9.9', GITHUB_REF_TYPE: 'tag' },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`v${version}`)
  })

  it('ignores the ref name on a branch push', async () => {
    const workspace = await createWorkspace()
    const result = spawnSync(process.execPath, [join(workspace, 'scripts', 'tauri-version.mjs'), 'check'], {
      cwd: workspace,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_REF_NAME: 'main', GITHUB_REF_TYPE: 'branch' },
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('is consistent')
  })

  it('syncs a drifted manifest back to the package version', async () => {
    const workspace = await createWorkspace()
    const cargoPath = join(workspace, 'src-tauri', 'Cargo.toml')
    await writeFile(cargoPath, (await readFile(cargoPath, 'utf8')).replace(
      /^version = "[^"]+"/m,
      'version = "9.9.9"',
    ))

    expect(run(workspace, 'sync').status).toBe(0)
    expect(run(workspace).status).toBe(0)
  })
})
