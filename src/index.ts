import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import vm from 'node:vm'

import getRegistry from 'get-registry'

import { Context, z, Service } from 'koishi'

export const name = 'w-node'

declare module 'koishi' {
  interface Context {
    node: NodeService
  }
}

async function exists(path: string) {
  try {
    await fs.stat(path)
    return true
  }
  catch {
    return false
  }
}

export interface ImportOptions {
  allowInstall?: boolean
}

const locales = {
  zhCN: require('./locales/zh-CN.yml'),
  enUS: require('./locales/en-US.yml'),
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
        if (! exists(dir)) return '包目录不存在'
        const subs = await Promise.all((await fs.readdir(dir)).map(async sub => {
          const packageJsonPath = path.resolve(dir, sub, 'node_modules', this.unescapePackageName(sub), 'package.json')
          const packageJson = await fs.readFile(packageJsonPath, 'utf-8')
          const { name, version }: { name: string, version: string } = JSON.parse(packageJson)
          return `${name}@${version}`
        }))
        return session.text('.summary', { count: subs.length }) + '\n' + subs.join('\n')
      })

    ctx.command('node.install <package:string>', { authority: 4 })
      .option('version', '-v <version:string>')
      .alias('node.add')
      .action(async ({ session, options }, packageName) => {
        try {
          await this.install(packageName, options.version)
          return session.text('.success')
        }
        catch (err) {
          return session.text('.failure', { err })
        }
      })

    ctx.command('node.info <package:string>', { authority: 2 })
      .action(async ({ session }, packageName) => {
        const packageDir = this.getPackageDir(packageName)
        if (await exists(packageDir)) {
          const packageJsonPath = path.resolve(packageDir, 'package.json')
          const packageJson = await fs.readFile(packageJsonPath, 'utf-8')
          return packageJson
        }
        return session.text('.not-exist', { name: packageName })
      })

    ctx.command('node.remove <package:string>', { authority: 4 })
      .action(async ({ session }, packageName) => {
        const isRemoved = await this.remove(packageName)
        return isRemoved
          ? session.text('.success')
          : session.text('.not-exist', { name: packageName })
      })

    ctx.command('node.exec <package:string> <code:text>', { authority: 4 })
      .option('var', '-v <varname:string>')
      .option('return', '-r')
      .action(async (argv, packageName, code) => {
        const varName = argv.options.var || 'pkg'
        const script = new vm.Script(code)
        try {
          const result = await script.runInNewContext({
            [varName]: await this.import(packageName),
          })
          return argv.options.return ? result : String(result)
        }
        catch (err) {
          return argv.session.text('.runtime-error', { err })
        }
      })
  }

  logger = this.ctx.logger('w-node')

  async start() {
    if (! this.config.registry) {
      this.config.registry = await getRegistry()
      this.ctx.scope.update(this.config)
    }

    this.execaPackage = await import('execa')
  }

  private execaPackage: typeof import('execa')

  get execa() {
    const wrapStd = (type: 'out' | 'err') => {
      const log = this.logger[type === 'out' ? 'info' : 'error']
      return function * (line: string) {
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
   * Get the root directory of a package
   * @param packageName The name of the package
   * @returns The root directory path of the package
   */
  getPackageRootDir(packageName: string) {
    return path.resolve(this.config.packagePath, this.escapePackageName(packageName))
  }

  /**
   * Get the installation directory of a package
   * @param packageName The name of the package
   * @returns The installation directory path of the package
   */
  getPackageDir(packageName: string) {
    const rootDir = this.getPackageRootDir(packageName)
    const packageDir = path.resolve(rootDir, 'node_modules', packageName)
    return packageDir
  }

  /**
   * Install a package by `npm`
   * @param packageName The name of the package
   * @param version The version of the package, defaults to `latest`
   */
  async install(packageName: string, version?: string) {
    const rootDir = this.getPackageRootDir(packageName)

    this.logger.info(`Making directory '${rootDir}'.`)
    await fs.mkdir(rootDir, { recursive: true })
    await fs.writeFile(path.resolve(rootDir, 'package.json'), '{}')

    const packageStr = `${packageName}@${version || 'latest'}`
    this.logger.info(`Installing '${packageStr}'...`)
    await this.execa({ cwd: rootDir })`npm add ${packageStr} --color always --registry ${this.config.registry}`

    this.logger.info(`Installed package '${packageStr}'.`)
  }

  /**
   * Remove a package
   * @param packageName The name of the package
   * @returns Fulfills with whether the package was removed
   */
  async remove(packageName: string): Promise<boolean> {
    const rootDir = path.resolve(this.config.packagePath, this.escapePackageName(packageName))
    if (! await exists(rootDir)) return false

    this.logger.info(`Uninstalling '${packageName}'...`)
    await fs.rm(rootDir, { recursive: true, force: true })
    this.logger.info(`Uninstalled package '${packageName}'.`)
    return true
  }

  /**
   * Check if a package is installed
   * @param packageName The name of the package
   * @returns Fulfills with whether the package is installed
   */
  async has(packageName: string): Promise<boolean> {
    const packageDir = this.getPackageDir(packageName)
    return exists(packageDir)
  }

  /**
   * Dynamically import a package, installing it if necessary
   * @template T The _expected_ type of the imported package
   * @param packageName The name of the package
   * @param options Import options, see {@link ImportOptions}
   * @return Fulfills with the imported package
   */
  async import<T>(packageName: string, options: ImportOptions = {}): Promise<T> {
    const { allowInstall = true } = options
    const packageDir = this.getPackageDir(packageName)

    if (! await exists(packageDir) && allowInstall) await this.install(packageName)

    return require(packageDir) as T
  }

  /**
   * @deprecated use `import` instead
   */
  async safeImport<T>(packageName: string): Promise<T> {
    return this.import<T>(packageName)
  }
}

namespace NodeService {
  export interface Config {
    packagePath: string
    registry: string
  }

  export const Config: z<Config> = z
    .object({
      packagePath: z
        .string()
        .default('cache/node'),
      registry: z
        .string()
        .default(''),
    })
    .i18n({
      'zh-CN': locales.zhCN._config,
      'en-US': locales.enUS._config,
    })
}

export default NodeService
