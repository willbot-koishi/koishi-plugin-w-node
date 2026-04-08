import path from 'node:path'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import url from 'node:url'
import module from 'node:module'

import getRegistry from 'get-registry'
import maxSatisfying from 'semver/ranges/max-satisfying'
import satisfies from 'semver/functions/satisfies'
import semverCompare from 'semver/functions/compare'

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

export interface VersionDir {
  version: string
  path: string
}

const isKoishi = ("," + Object.keys(process.env).join(",").toLowerCase()).includes(",koishi")

const locales = !isKoishi ? {} : {
  zhCN: require('./locales/zh-CN.yml'),
  enUS: require('./locales/en-US.yml'),
}

class NodeService extends Service {
  constructor(ctx: Context, public config: NodeService.Config) {
    super(ctx, 'node')

    ctx.i18n.define('zh-CN', locales.zhCN)
    ctx.i18n.define('en-US', locales.enUS)

    ctx.command('node')

    ctx.command("node.list", {authority: 2})
      .action(async ({session}) => {
        const dir = this.config.packagePath;
        if (!(await exists(dir))) return session.text(".package-not-exist");
        const subs = (await fs.readdir(dir, {withFileTypes: true}))
          .filter((d) => d.isDirectory())
          .map((dir) => {
            const index = dir.name.lastIndexOf(this.versionDelimiter);
            const name = dir.name.slice(0, index);
            const version = dir.name.slice(index + this.versionDelimiter.length);
            return [this.unescapePackageName(name), version];
          })
          .sort((a, b) => {
           const d =  a[0].localeCompare(b[0])
            if (d !== 0) {
              return d
            }
            return semverCompare(b[1], a[1], {loose: true})
          })
          .map((d) => d[0] + '@' + d[1]);
        return session.text(".summary", {count: subs.length}) + "\n" + subs.join("\n");
      });

    ctx.command('node.install <package:string>', { authority: 4 })
      .option('version', '-v <version:string>')
      .alias('node.add')
      .action(async ({ session, options }, packageName) => {
        try {
          const version = await this.install(packageName, options.version)
          return session.text('.success', {version})
        }
        catch (err) {
          return session.text('.failure', {err: err?.stack || String(err)})
        }
      })

    ctx.command('node.info <package:string>', { authority: 2 })
      .option('version', '-v <version:string>')
      .action(async ({ session, options }, packageName) => {
        const version =  await this.maxSatisfyingForPackageInstalled(packageName, options.version, true)
        if(!version){
          return session.text('.not-exist', { name: packageName })
        }
        const packageJsonPath = path.resolve(this.buildPackageVersionDir(packageName, version), "package.json");
        const packageJson = await fs.readFile(packageJsonPath, "utf-8");
        return packageJson;
      })

    ctx.command('node.remove <package:string>', { authority: 4 })
      .option('version', '-v <version:string>')
      .action(async ({ session, options }, packageName) => {
        const isRemoved = await this.remove(packageName, options.version)
        return isRemoved
          ? session.text('.success')
          : session.text('.not-exist', {name: packageName + (options.version ? '@' + options.version : '')})
      })

    ctx.command('node.exec <package:string> <code:text>', { authority: 4 })
      .option('version', '--ver <version:string>')
      .option('var', '-v <varname:string>')
      .option('return', '-r')
      .action(async ({ session, options }, packageName, code) => {
        const varName = options.var || 'pkg'
        const script = new vm.Script(code)
        try {
          const result = await script.runInNewContext({
            [varName]: await this.import(packageName, {version: options.version}),
          })()
          return options.return ? result : String(result)
        } catch (err) {
          return session.text('.runtime-error', {err: err?.stack || String(err)})
        }
      })
  }

  logger = this.ctx.logger('w-node')
  readonly versionDelimiter = "@"

  async start() {

    if (!this.config.registry) {
      let registry: string;
      for (const group of Object.values(this.ctx.root.config?.plugins || {})) {
        const market = Object.entries(group).find((e) =>
          e[0]?.startsWith?.("market:"),
        );
        if (market) {
          registry = market[1]?.["registry"]?.["endpoint"];
          break;
        }
      }
      if (!registry) {
        registry = await getRegistry();
      }
      this.config.registry = registry;
      this.ctx.scope.update(this.config);
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
   * build the root directory of a package
   * @param packageName The name of the package
   * @param version The version of the package
   * @returns The root directory path of the package
   */
  buildPackageVersionRootDir(packageName: string, version: string) {
    const packageDir = path.resolve(
      this.config.packagePath,
      this.escapePackageName(packageName) + this.versionDelimiter + version,
    );
    return packageDir;
  }

  /**
   * build the root directory of a package
   * @param packageName The name of the package
   * @param version The version of the package
   * @returns The root directory path of the package
   */
  buildPackageVersionDir(packageName: string, version: string) {
    const rootDir = this.buildPackageVersionRootDir(packageName, version)
    const packageDir = path.resolve(rootDir, 'node_modules', packageName)
    return packageDir
  }

  /**
   * Get for all installed versions of the package
   * @param packageName The name of the package
   * @returns for all installed versions of the package
   */
  async getAllInstalledVersionsOfPackage(packageName: string) {
    const versionDirs: VersionDir[] = [];
    if (!(await exists(this.config.packagePath))) {
      return versionDirs;
    }
    const prefix = this.escapePackageName(packageName) + this.versionDelimiter;
    const files = await fs.readdir(this.config.packagePath, {
      withFileTypes: true,
    });
    files
      .filter((file) => file.isDirectory() && file.name.startsWith(prefix))
      .forEach((file) =>
        versionDirs.push({
          version: file.name.replace(prefix, ""),
          path: path.join(file.parentPath, file.name, path.sep),
        }),
      );
    return versionDirs;
  }

  /**
   * Find for installed versions of the package
   * @param packageName The name of the package
   * @param versionRange The version of the package, defaults to `*`
   * @param includePrerelease include prerelease
   * @returns installed versions of the package
   */
  async maxSatisfyingForPackageInstalled(packageName: string, versionRange: string = '*', includePrerelease: boolean = false) {
    if (versionRange === 'latest') versionRange = '*';
    const versionDirs = await this.getAllInstalledVersionsOfPackage(packageName);
    const version = maxSatisfying(
      versionDirs.map(vd => vd.version),
      versionRange, {loose: true, includePrerelease}
    );
    return version
  }

  /**
   * Install a package by `npm`
   * @param packageName The name of the package
   * @param version The version of the package, defaults to `latest`
   * @return package installed version
   */
  async install(packageName: string, version: string | 'latest' = 'latest') {
    let versions: string[];
    try {
      const res = (await this.execaPackage.execa
        `npm view ${packageName}@${version} version --json --registry ${this.config.registry}`);
      versions = JSON.parse(res.stdout);
      if (typeof versions === 'string') {
        versions = [versions]
      }
    } catch (e) {
      this.logger.error(e);
      return null;
    }

    const targetVersion = maxSatisfying(versions, '*', {loose: true, includePrerelease: true})?.toString();
    if (!targetVersion) {
      this.logger.error(`Invalid version: ${version}`);
      return null;
    }

    const rootDir = this.buildPackageVersionRootDir(packageName, targetVersion)

    this.logger.info(`Making directory '${rootDir}'.`)
    await fs.mkdir(rootDir, {recursive: true})
    await fs.writeFile(path.resolve(rootDir, 'package.json'), '{}')

    const packageStr = `${packageName}@${targetVersion}`
    this.logger.info(`Installing '${packageStr}'...`)
    await this.execa({cwd: rootDir})`npm add ${packageStr} --color always --registry ${this.config.registry}`

    this.logger.info(`Installed package '${packageStr}'.`)

    return targetVersion;
  }

  /**
   * Remove a package
   * @param packageName The name of the package
   * @param versionRange The version range of the package, defaults `*`
   * @returns Fulfills with whether the package was removed
   */
  async remove(packageName: string, versionRange: string  = "*"): Promise<boolean> {
    let versionDirs = await this.getAllInstalledVersionsOfPackage(packageName);
    versionDirs = versionDirs.filter(vd => satisfies(vd.version, versionRange, {loose: true, includePrerelease: true}));
    if (versionDirs.length === 0) return false

    const versionMsg = versionDirs.map(vd=>vd.version).join(', ')
    this.logger.info(`Uninstalling '${packageName}' range from '${versionRange}' target: ${versionMsg}`)
    await Promise.all(versionDirs.map(vd => fs.rm(vd.path, {recursive: true, force: true})))
    this.logger.info(`Uninstalled package '${packageName}'.`)
    return true
  }

  /**
   * Check if a package is installed
   * @param packageName The name of the package
   * @param versionRange The version range of the package, defaults `*`
   * @returns Fulfills with whether the package is installed
   */
  async has(packageName: string, versionRange: string = "*"): Promise<boolean> {
    const versionDirs = await this.getAllInstalledVersionsOfPackage(packageName);
    return versionDirs.some(vd => satisfies(vd.version, versionRange, {loose: true, includePrerelease: true}));
  }

  /**
   * Dynamically import a package, installing it if necessary
   * @template T The _expected_ type of the imported package
   * @param packageName The name of the package
   * @param options Import options, see {@link ImportOptions}
   * @return Fulfills with the imported package
   */
  async import<T>(packageName: string, options: ImportOptions = {}): Promise<T> {
    const {allowInstall = true, useRequire = false, version = 'latest'} = options

    let targetVersion = await this.maxSatisfyingForPackageInstalled(packageName, version, true);

    if (!targetVersion) {
      if (allowInstall) {
        targetVersion = await this.install(packageName, version);
      } else {
        this.logger.error(`Package not installed: ${packageName}@${version}`);
        return null;
      }
    }

    const packageDir = this.buildPackageVersionDir(packageName, targetVersion);

    if (useRequire) {
      return require(packageDir) as T
    }

    const packageHref = url.pathToFileURL(packageDir).href
    const packageRequire = module.createRequire(packageHref)
    const packageEntry = packageRequire.resolve(packageName)
    const packageObject = await import(url.pathToFileURL(packageEntry).href) as T
    return packageObject
  }

  /**
   * @deprecated use `import` instead
   */
  async safeImport<T>(packageName: string, options: ImportOptions = {}): Promise<T> {
    return this.import<T>(packageName, options)
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
      'zh-CN': locales.zhCN?._config,
      'en-US': locales.enUS?._config,
    })
}

export default NodeService
