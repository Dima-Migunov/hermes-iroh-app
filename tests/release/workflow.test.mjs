import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..', '..')

async function text(path) {
  return readFile(join(root, path), 'utf8')
}

describe('reusable verification workflow', () => {
  it('is callable and runs the shared gates', async () => {
    const workflow = await text('.github/workflows/verify.yml')

    expect(workflow).toContain('workflow_call:')
    expect(workflow).toContain('npm run typecheck')
    expect(workflow).toContain('npm test')
    expect(workflow).toContain('cargo test --manifest-path src-tauri/Cargo.toml')
    expect(workflow).toContain('cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings')
    expect(workflow).toContain('cargo fmt --manifest-path src-tauri/Cargo.toml --check')
    expect(workflow).toContain('uses: ./.github/actions/install-linux-deps')
    expect(workflow).toContain('scripts/toolchain.mjs node')
  })

  it('runs the same gates on pull requests and branch pushes', async () => {
    const workflow = await text('.github/workflows/ci.yml')

    expect(workflow).toContain('pull_request:')
    expect(workflow).toContain('push:')
    expect(workflow).toContain('uses: ./.github/workflows/verify.yml')
  })

  it('is called by the tag release before packaging', async () => {
    const workflow = await text('.github/workflows/release.yml')

    expect(workflow).toMatch(/verify:\s*\n\s+uses: \.\/\.github\/workflows\/verify\.yml/)
    expect(workflow).toMatch(/build:\s*\n\s+needs: verify/)
  })

  it('no longer duplicates the Linux dependency install inline', async () => {
    const workflow = await text('.github/workflows/release.yml')

    expect(workflow).not.toContain('libwebkit2gtk-4.1-dev')
    expect(workflow).toContain('uses: ./.github/actions/install-linux-deps')
  })

  it('moves the Linux dependency install into a composite action', async () => {
    const action = await text('.github/actions/install-linux-deps/action.yml')

    expect(action).toContain('using: composite')
    expect(action).toContain('libwebkit2gtk-4.1-dev')
    expect(action).toContain('patchelf')
  })
})

describe('release workflow asset verification', () => {
  it('verifies the exact asset-name set instead of extension counts', async () => {
    const workflow = await text('.github/workflows/release.yml')

    expect(workflow).toContain('scripts/verify-release-assets.mjs')
    expect(workflow).not.toContain('check \'*.exe\'')
    expect(workflow).not.toMatch(/check '\.\w+' \d/)
  })

  it('asserts the uploaded asset count before un-drafting', async () => {
    const workflow = await text('.github/workflows/release.yml')
    const publish = workflow.slice(workflow.indexOf('Publish release'))

    expect(publish.indexOf('verify-release-assets.mjs')).toBeGreaterThan(-1)
    expect(publish.indexOf('verify-release-assets.mjs')).toBeLessThan(
      publish.indexOf('--draft=false'),
    )
  })

  it('resolves the bundle directory from CARGO_TARGET_DIR', async () => {
    const workflow = await text('.github/workflows/release.yml')

    expect(workflow).toContain('CARGO_TARGET_DIR')
    expect(workflow).toMatch(/steps\.bundle\.outputs\.dir/)
    expect(workflow).not.toMatch(/--input src-tauri\/target\/release\/bundle/)
  })

  it('does not sync versions during a build', async () => {
    const workflow = await text('.github/workflows/release.yml')
    const packaging = await text('scripts/package.mjs')

    expect(workflow).not.toContain('tauri:sync')
    expect(packaging).not.toContain('tauri:sync')
    expect(packaging).toContain('tauri:check')
  })
})
