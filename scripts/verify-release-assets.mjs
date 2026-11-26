import { pathToFileURL } from 'node:url'
import { expectedAssetNames, verifyAssetSet } from './release-assets.mjs'

function parseArguments(argv) {
  let directory = 'release'
  let version

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const value = argv[index + 1]

    if (argument === '--directory') {
      if (!value) throw new Error('--directory requires a path.')
      directory = value
      index += 1
    } else if (argument === '--version') {
      if (!value) throw new Error('--version requires a value.')
      version = value.replace(/^v/, '')
      index += 1
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }

  if (!version) throw new Error('--version is required.')
  return { directory, version }
}

async function main() {
  const { directory, version } = parseArguments(process.argv.slice(2))
  const present = await verifyAssetSet(directory, version)
  for (const name of present) {
    console.log(name)
  }
  console.log(`Verified ${present.length} of ${expectedAssetNames(version).length} release assets.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`::error::${error.message}`)
    process.exit(1)
  })
}
