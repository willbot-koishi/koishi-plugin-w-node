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

export async function deepForEach(
  obj: any,
  fn: (
    value: any,
    key: string,
    obj: any,
    parentPath: string[],
    root: any,
  ) => Promise<void | false> | void | false,
  {
    onObject = true,
    onValue = true,
    parentPath = [] as string[],
    root = obj,
  } = {},
) {
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'object' && value !== null) {
      if (onObject) {
        if (await fn(value, key, obj, parentPath, root) === false) {
          return false
        }
      }
      if (await deepForEach(value, fn, {
        onObject,
        onValue,
        parentPath: [...parentPath, key],
        root,
      }) === false) {
        return false
      }
    }
    else if (onValue) {
      if (await fn(value, key, obj, parentPath, root) === false) {
        return false
      }
    }
  }
}

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

export namespace Locks {
  const coalescePool = {}
  export async function coalesce(
    key: string | symbol,
    fn?: () => any | Promise<any>,
  ) {
    const lockObj = (coalescePool[key] ||= {
      lock: null,
      resolve: null,
      reject: null,
    })

    if (! fn || lockObj.lock) {
      return lockObj.lock
    }

    lockObj.lock = new Promise((resolve, reject) => {
      lockObj.resolve = resolve
      lockObj.reject = reject
    })
    try {
      const res = await fn()
      lockObj.resolve(res)
      return res
    }
    catch (e) {
      lockObj.reject(e)
      throw e
    }
    finally {
      delete lockObj.lock
      delete lockObj.resolve
      delete lockObj.reject
      delete coalescePool[key]
    }
  }
}
