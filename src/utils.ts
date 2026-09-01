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

export class ReadWriteLock {
  private readMap: Record<symbol, true> = {}
  private reading: Promise<void> = null
  private readingRes: (value: (PromiseLike<void> | void)) => void = null
  private writeQueue: ((value: (PromiseLike<void> | void)) => void)[] = []
  private writing: Promise<void> = null
  private writingRes: (value: (PromiseLike<void> | void)) => void = null

  async r<T>(cb: () => T | Promise<T>): Promise<T> {
    if (this.writing) {
      await this.writing
    }
    if (! this.reading) {
      this.reading = new Promise(resolve => this.readingRes = resolve)
    }
    const key = Symbol('read')
    this.readMap[key] = true
    try {
      return await cb()
    }
    finally {
      delete this.readMap[key]
      if (Object.getOwnPropertySymbols(this.readMap).length === 0) {
        this.readingRes()
        this.reading = null
        this.readingRes = null
      }
    }
  }

  async w<T>(cb: () => T | Promise<T>): Promise<T> {
    if (this.reading) {
      await this.reading
    }
    if (! this.writing) {
      this.writing = new Promise(resolve => this.writingRes = resolve)
    }
    else {
      let res: (value: (PromiseLike<void> | void)) => void
      const lock = new Promise<void>(resolve => res = resolve)
      this.writeQueue.push(res)
      await lock
    }
    try {
      return await cb()
    }
    finally {
      if (this.writeQueue.length === 0) {
        this.writingRes()
        this.writing = null
        this.writingRes = null
      }
      else {
        this.writeQueue.shift()()
      }
    }
  }
}
