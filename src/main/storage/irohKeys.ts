import { SecretKey } from '@number0/iroh'
import type { KeyFactory } from './keys'

export const irohKeyFactory: KeyFactory = {
  generate: () => SecretKey.generate(),
  fromBytes: (bytes) => SecretKey.fromBytes(bytes),
}
