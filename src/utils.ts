import fs from 'node:fs/promises'

import semverCompare from 'semver/functions/compare'

export async function exists(path: string) {
  try {
    await fs.stat(path)
    return true
  }
  catch {
    return false
  }
}

export interface VersionDir {
  version: string
  path: string
}

export interface PackageInfo {
  name: string
  version: string
}

export namespace PackageInfo {
  export const show = (info: PackageInfo) => `${info.name}@${info.version}`

  export const compare = (a: PackageInfo, b: PackageInfo) => (
    a.name.localeCompare(b.name) ||
    semverCompare(b.version, a.version, { loose: true })
  )
}

export const VERSION_SYMBOL = '@'
