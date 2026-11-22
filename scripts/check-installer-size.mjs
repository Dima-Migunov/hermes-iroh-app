import { pathToFileURL } from 'node:url'
import { checkInstallerSizes } from './release-assets.mjs'

function parseArguments(argv) {
  let directory = 'release'

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const value = argv[index + 1]

    if (argument === '--directory') {
      if (!value) throw new Error('--directory requires a path.')
      directory = value
      index += 1
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }

  return { directory }
}

async function main() {
  const { directory } = parseArguments(process.argv.slice(2))
  const installers = await checkInstallerSizes(directory)
  for (const installer of installers) {
    console.log(`${installer.size} bytes  ${installer.path}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`::error::${error.message}`)
    process.exit(1)
  })
}
