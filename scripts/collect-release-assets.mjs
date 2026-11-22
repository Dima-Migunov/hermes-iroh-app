import { pathToFileURL } from 'node:url'
import { collectAssets } from './release-assets.mjs'

function parseArguments(argv) {
  const options = { inputs: [], output: 'release', version: undefined }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const value = argv[index + 1]

    if (argument === '--input') {
      if (!value) throw new Error('--input requires a directory.')
      options.inputs.push(value)
      index += 1
    } else if (argument === '--output') {
      if (!value) throw new Error('--output requires a directory.')
      options.output = value
      index += 1
    } else if (argument === '--version') {
      if (!value) throw new Error('--version requires a value.')
      options.version = value.replace(/^v/, '')
      index += 1
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }

  if (options.inputs.length === 0) throw new Error('At least one --input is required.')
  if (!options.version) throw new Error('--version is required.')

  return options
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const assets = await collectAssets({
    inputDirs: options.inputs,
    outputDir: options.output,
    version: options.version,
  })

  if (assets.length === 0) {
    throw new Error('No release assets were collected.')
  }

  for (const asset of assets) {
    console.log(`${asset.source} -> ${asset.destination}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`::error::${error.message}`)
    process.exit(1)
  })
}
