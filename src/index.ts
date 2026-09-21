import path from 'node:path'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import url from 'node:url'
import module from 'node:module'

import getPMRegistry from 'get-registry'
import maxSatisfying from 'semver/ranges/max-satisfying'
import satisfies from 'semver/functions/satisfies'

import { Context, z, Service } from 'koishi'

import { deepForEach, exists, PackageInfo, ReadWriteLock, useCoalescer, VERSION_SYMBOL } from './utils'
import enUS from './locales/en-US.yml'
import zhCN from './locales/zh-CN.yml'

const INSTALLING_DIRECTORY = '.installing'

declare module 'koishi' {
  interface Context {
    node: NodeService
  }
}

/**
 * Options for dynamic import
 * @field allowInstall Whether to install the package if it is not found (default: `true`)
 * @field useRequire Whether to use `require` instead of `import` (default: `false`)
 * @field version The version of the package (default: `latest`)
 */
export interface ImportOptions {
  allowInstall?: boolean
  useRequire?: boolean
  version?: string | 'latest'
}

const locales = {
  zhCN,
  enUS,
}

class NodeService extends Service {
  constructor(ctx: Context, public config: NodeService.Config) {
    super(ctx, 'node')

    ctx.i18n.define('zh-CN', locales.zhCN)
    ctx.i18n.define('en-US', locales.enUS)

    ctx.command('node')

    ctx.command('node.list', { authority: 2 })
      .action(async ({ session }) => {
        const dir = this.config.packagePath
        if (! (await exists(dir))) return session.text('.package-not-exist')
        const infoStrs = (await fs.readdir(dir, { withFileTypes: true }))
          .filter(entry => entry.isDirectory() && entry.name !== INSTALLING_DIRECTORY)
          .map((dir): PackageInfo => {
            const index = dir.name.lastIndexOf(VERSION_SYMBOL)
            const name = dir.name.slice(0, index)
            const version = dir.name.slice(index + VERSION_SYMBOL.length)
            return { name: this.unescapePackageName(name), version }
          })
          .sort(PackageInfo.compare)
          .map(PackageInfo.show)
        return session.text('.summary', { count: infoStrs.length }) + '\n' + infoStrs.join('\n')
      })

    ctx.command('node.install <package:string>', { authority: 4 })
      .option('version', '-v <version:string>')
      .alias('node.add')
      .action(async ({ session, options }, packageName) => {
        try {
          const version = await this.install(packageName, options.version)
          return session.text('.success', { version })
        }
        catch (err) {
          return session.text('.failure', { err: err?.stack || String(err) })
        }
      })

    ctx.command('node.info <package:string>', { authority: 2 })
      .option('version', '-v <version:string>')
      .action(async ({ session, options }, packageName) => {
        const version = await this.selectInstalledVersion(packageName, options.version, true)
        if (! version) {
          return session.text('.not-exist', { name: packageName })
        }
        const packageJsonPath = path.resolve(this.buildPackageDir(packageName, version), 'package.json')
        const packageJson = await fs.readFile(packageJsonPath, 'utf-8')
        return packageJson
      })

    ctx.command('node.remove <package:string>', { authority: 4 })
      .option('version', '-v <version:string>')
      .action(async ({ session, options }, packageName) => {
        const isRemoved = await this.remove(packageName, options.version)
        return isRemoved
          ? session.text('.success')
          : session.text('.not-exist', { name: packageName + (options.version ? `@${options.version}` : '') })
      })

    ctx.command('node.exec <package:string> <code:text>', { authority: 4 })
      .option('version', '-v <version:string>')
      .option('as', '-a <varname:string>', { fallback: 'pkg' })
      .option('return', '-r')
      .action(async ({ session, options }, packageName, code) => {
        const script = new vm.Script(code)
        try {
          const result = await script.runInNewContext({
            [options.as]: await this.import(packageName, { version: options.version }),
          })
          return options.return ? result : String(result)
        }
        catch (err) {
          return session.text('.runtime-error', { err: err?.stack || String(err) })
        }
      })

    const dayTime = 24 * 60 * 60 * 1000
    ctx.setInterval(() => {
      void this.removeUnaccessed(this.config.packageIdleTimeout * dayTime).catch((error) => {
        this.logger.error('Failed to clean up idle packages: %o', error)
      })
    }, dayTime)
  }

  logger = this.ctx.logger('w-node')
  rmLock = new ReadWriteLock()
  coalesceInstall = useCoalescer()

  async getRegistry(): Promise<string> {
    let marketRegistry: string
    await deepForEach(this.ctx.root.config?.plugins || {}, (value, key) => {
      if (! key.startsWith?.('market:')) {
        return
      }
      marketRegistry = value?.['registry']?.['endpoint']
      return false
    }, { onValue: false })
    return marketRegistry ?? await getPMRegistry()
  }

  async start() {
    if (! this.config.registry) {
      this.config.registry = await this.getRegistry()
      this.ctx.scope.update(this.config)
    }

    this.execaPackage = await import('execa')
  }

  private execaPackage: typeof import('execa')

  get execa() {
    const wrapStd = (type: 'out' | 'err') => {
      const log = this.logger[type === 'out' ? 'info' : 'error']
      return function* (line: string) {
        log(line)
      }
    }

    return this.execaPackage.execa({
      verbose: 'short',
      stdout: wrapStd('out'),
      stderr: wrapStd('err'),
    })
  }

  escapePackageName = (packageName: string) => packageName
    .replace('/', '+')

  unescapePackageName = (escapedPackageName: string) => escapedPackageName
    .replace('+', '/')

  /**
   * Build the root directory of a package
   * @param packageName The name of the package
   * @param version The version of the package
   * @returns The root directory path of the package
   */
  buildPackageRootDir(packageName: string, version: string) {
    const packageDir = path.resolve(
      this.config.packagePath,
      `${this.escapePackageName(packageName)}${VERSION_SYMBOL}${version}`,
    )
    return packageDir
  }

  /**
   * Build the installation directory of a package
   * @param packageName The name of the package
   * @param version The version of the package
   * @returns The root directory path of the package
   */
  buildPackageDir(packageName: string, version: string) {
    const rootDir = this.buildPackageRootDir(packageName, version)
    const packageDir = path.resolve(rootDir, 'node_modules', packageName)
    return packageDir
  }

  /**
   * List all installed versions of the package
   * @param packageName The name of the package
   * @returns an array of all installed versions of the package
   */
  async listVersionDirs(packageName: string) {
    if (! (await exists(this.config.packagePath))) {
      return []
    }
    const prefix = `${this.escapePackageName(packageName)}${VERSION_SYMBOL}`
    const files = await fs.readdir(this.config.packagePath, {
      withFileTypes: true,
    })
    const versionDirs = files
      .filter(file => file.isDirectory() && file.name.startsWith(prefix))
      .map(file => ({
        version: file.name.replace(prefix, ''),
        path: path.join(file.parentPath, file.name, path.sep),
      }))
    return versionDirs
  }

  /**
   * Select the max-satisfying installed version of the package
   * @param packageName The name of the package
   * @param versionRange The version of the package, defaults to `*`
   * @param includePrerelease include prerelease
   * @returns installed versions of the package
   */
  async selectInstalledVersion(packageName: string, versionRange: string = '*', includePrerelease: boolean = false) {
    if (versionRange === 'latest') versionRange = '*'
    const versionDirs = await this.listVersionDirs(packageName)
    const version = maxSatisfying(
      versionDirs.map(dir => dir.version),
      versionRange, { loose: true, includePrerelease },
    )
    return version
  }

  /**
   * Install a package by `npm`
   * @param packageName The name of the package
   * @param version The version of the package, defaults to `latest`
   * @return package installed version
   */
  async install(packageName: string, version: string | 'latest' = 'latest'): Promise<string> {
    return this.rmLock.r(() => {
      const requestKey = `request:${packageName}@${version}`
      return this.coalesceInstall(requestKey, async () => {
        let versions: string[]
        try {
          const res = (await this.execaPackage.execa`npm view ${packageName}@${version} version --json --registry ${this.config.registry}`)
          versions = JSON.parse(res.stdout)
          if (typeof versions === 'string') {
            versions = [versions]
          }
        }
        catch (err) {
          this.logger.error(err)
          return null
        }

        const targetVersion = maxSatisfying(versions, '*', { loose: true, includePrerelease: true })?.toString()
        if (! targetVersion) {
          this.logger.error(`Invalid version: ${version}`)
          return null
        }

        const rootDir = this.buildPackageRootDir(packageName, targetVersion)
        const packageDir = this.buildPackageDir(packageName, targetVersion)
        const packageStr = `${packageName}@${targetVersion}`

        return this.coalesceInstall(`target:${packageStr}`, async () => {
          // Exact versions are immutable. A completed target needs no reinstall.
          if (await exists(path.resolve(packageDir, 'package.json'))) {
            return targetVersion
          }

          // Clear remnants of an interrupted legacy installation before
          // starting. The final path stays absent until the atomic publish.
          await fs.rm(rootDir, { recursive: true, force: true })

          // Install beside the final directory, so readers never observe a
          // partially populated package. rename() publishes it atomically.
          const stagingRoot = path.resolve(this.config.packagePath, INSTALLING_DIRECTORY)
          await fs.mkdir(stagingRoot, { recursive: true })
          const stagingDir = await fs.mkdtemp(path.resolve(
            stagingRoot,
            `${this.escapePackageName(packageName)}${VERSION_SYMBOL}${targetVersion}-`,
          ))

          try {
            await fs.writeFile(path.resolve(stagingDir, 'package.json'), '{}')
            this.logger.info(`Installing '${packageStr}'...`)
            await this.execa({ cwd: stagingDir })`npm add ${packageStr} --color always --registry ${this.config.registry}`

            await fs.rename(stagingDir, rootDir)
            this.logger.info(`Installed package '${packageStr}'.`)
            return targetVersion
          }
          catch (err) {
            try {
              await fs.rm(stagingDir, { recursive: true, force: true })
            }
            catch (cleanupError) {
              this.logger.warn(`Failed to clean up installation directory '${stagingDir}': %o`, cleanupError)
            }
            throw err
          }
        })
      })
    })
  }

  /**
   * Remove a package
   * @param packageName The name of the package
   * @param versionRange The version range of the package, defaults `*`
   * @returns Fulfills with whether the package was removed
   */
  async remove(packageName: string, versionRange: string = '*'): Promise<boolean> {
    return this.rmLock.w(async () => {
      let versionDirs = await this.listVersionDirs(packageName)
      versionDirs = versionDirs.filter(vd => satisfies(vd.version, versionRange, {
        loose: true,
        includePrerelease: true,
      }))
      if (! versionDirs.length) return false

      const versionMsg = versionDirs.map(vd => vd.version).join(', ')
      this.logger.info(`Uninstalling '${packageName}' range from '${versionRange}' target: ${versionMsg}`)
      await Promise.all(versionDirs.map(vd => fs.rm(vd.path, { recursive: true, force: true })))
      this.logger.info(`Uninstalled package '${packageName}'.`)
      return true
    })
  }

  /**
   * Check if a package is installed
   * @param packageName The name of the package
   * @param versionRange The version range of the package, defaults `*`
   * @returns Fulfills with whether the package is installed
   */
  async has(packageName: string, versionRange: string = '*'): Promise<boolean> {
    return this.rmLock.r(async () => {
      const versionDirs = await this.listVersionDirs(packageName)
      return versionDirs.some(vd => satisfies(vd.version, versionRange, { loose: true, includePrerelease: true }))
    })
  }

  /**
   * Dynamically import a package, installing it if necessary
   * @template T The _expected_ type of the imported package
   * @param packageName The name of the package
   * @param options Import options, see {@link ImportOptions}
   * @return Fulfills with the imported package
   */
  async import<T>(packageName: string, options: ImportOptions = {}): Promise<T> {
    return this.rmLock.r(async () => {
      const { allowInstall = true, useRequire = false, version = 'latest' } = options

      let targetVersion = await this.selectInstalledVersion(packageName, version, true)

      if (! targetVersion) {
        if (allowInstall) {
          targetVersion = await this.install(packageName, version)
        }
        else {
          this.logger.error(`Package not installed: ${packageName}@${version}`)
          return null
        }
      }

      const packageDir = this.buildPackageDir(packageName, targetVersion)

      let packageObject: T = null

      if (useRequire) {
        packageObject = require(packageDir) as T
      }
      else {
        // Resolve from the npm project that owns node_modules. Resolving a
        // package by its own name from inside its directory is sensitive to
        // Node's lookup state when the package was installed at runtime.
        const packageRoot = this.buildPackageRootDir(packageName, targetVersion)
        const packageRequire = module.createRequire(path.resolve(packageRoot, 'package.json'))
        const packageEntry = packageRequire.resolve(packageName)
        const packageEntryHref = url.pathToFileURL(packageEntry).href
        const packageHref = url.pathToFileURL(packageDir + path.sep).href
        if (packageEntryHref.startsWith(packageHref)) {
          packageObject = await import(packageEntryHref) as T
        }
      }

      if (packageObject !== null) {
        const now = new Date()
        await fs.utimes(this.buildPackageRootDir(packageName, targetVersion), now, now)
      }

      return packageObject
    })
  }

  /**
   * @deprecated use `import` instead
   */
  async safeImport<T>(packageName: string, options: ImportOptions = {}): Promise<T> {
    return this.import<T>(packageName, options)
  }

  /**
   * Remove unaccessed package
   * @param idleTimeout Package that remain unaccessed for this duration will be removed, in milliseconds
   */
  async removeUnaccessed(idleTimeout: number): Promise<any[]> {
    return this.rmLock.w(async () => {
      if (! (await exists(this.config.packagePath))) {
        return []
      }
      // No installation can be active while holding the write lock. Remove
      // empty or abandoned staging directories without counting them as packages.
      const stagingRoot = path.resolve(this.config.packagePath, INSTALLING_DIRECTORY)
      try {
        await fs.rm(stagingRoot, { recursive: true, force: true })
      }
      catch (err) {
        this.logger.warn(`Failed to clean up installation staging directory '${stagingRoot}': %o`, err)
      }
      let files = await fs.readdir(this.config.packagePath, {
        withFileTypes: true,
      })
      files = files
        .filter(file => file.isDirectory())
      const now = Date.now()
      const rmPaths: string[] = []
      for (const file of files) {
        const dirPath = path.join(file.parentPath, file.name)
        const stat = await fs.stat(dirPath)
        if (now - stat.mtimeMs > idleTimeout) {
          rmPaths.push(dirPath)
        }
      }
      if (! rmPaths.length) {
        return
      }
      const results = await Promise.allSettled(rmPaths.map(path => fs.rm(path, { recursive: true, force: true })))
      let removedCount = 0
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          removedCount += 1
        }
        else {
          this.logger.warn(`Failed to remove idle package '${rmPaths[index]}': %o`, result.reason)
        }
      })
      this.logger.info(`Removed ${removedCount} idle package(s).`)
    })
  }
}

namespace NodeService {
  export interface Config {
    packagePath: string
    registry: string
    packageIdleTimeout: number
  }

  export const Config: z<Config> = z
    .object({
      packagePath: z
        .string()
        .default('data/node'),
      registry: z
        .string()
        .default(''),
      packageIdleTimeout: z
        .number()
        .min(1)
        .default(7),
    })
    .i18n({
      'zh-CN': locales.zhCN._config,
      'en-US': locales.enUS._config,
    })
}

export default NodeService
