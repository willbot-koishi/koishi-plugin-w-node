import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'

import { type ExecaMethod } from 'execa'
import getRegistry from 'get-registry'

import { Context, z, Service } from 'koishi'

export const name = 'w-node'

declare module 'koishi' {
    interface Context {
        node: NodeService
    }
}

const exists = async (path: string) => {
    try {
        await fs.stat(path)
        return true
    }
    catch {
        return false
    }
}

class NodeService extends Service {
    constructor(ctx: Context, public config: NodeService.Config) {
        super(ctx, 'node')

        ctx.command('node', 'Node 服务')

        ctx.command('node.list', '列出安装的包')
            .action(async () => {
                const dir = this.config.packagePath
                if (! exists(dir)) return '包目录不存在'
                const subs = await Promise.all((await fs.readdir(dir)).map(async sub => {
                    const packageJsonPath = path.resolve(dir, sub, 'node_modules', this.unescapePackageName(sub), 'package.json')
                    const packageJson = await fs.readFile(packageJsonPath, 'utf-8')
                    const { name, version }: { name: string, version: string } = JSON.parse(packageJson)
                    return `${name}@${version}`
                }))
                return `共安装了 ${subs.length} 个包：${subs.join(', ')}`
            })

        ctx.command('node.add <package:string> [version:string]', '安装包', { authority: 4 })
            .action(async (_, packageName, version) => {
                try {
                    await this.install(packageName, version)
                    return '安装成功'
                }
                catch (err) {
                    return `安装失败：${err}`
                }
            })

        ctx.command('node.remove <package:string>', '移除包', { authority: 4 })
            .action(async (_, packageName) => {
                const cwd = path.resolve(this.config.packagePath, this.escapePackageName(packageName))
                if (await exists(cwd)) {
                    await fs.rm(cwd, { recursive: true, force: true })
                    return '移除成功'
                }
                return `包 ${packageName} 不存在`
            })

        ctx.command('node.debug.evalwith <package:string> <code:text>', '引入包并运行 JavaScript', { authority: 4 })
            .option('varname', '-v <varname:string> 引入包的变量名')
            .action(async (argv, packageName, code) => {
                const varName = argv.options.varname || packageName.replace(/^@.*\//, '').replace(/(^(?=\d))/, '_')
                try {
                    const _package = await this.safeImport(packageName)
                    const result = await eval(`const ${varName} = _package; ${code}`)
                    return JSON.stringify(result)
                }
                catch (error) {
                    return String(error)
                }
            })

    }

    async start() {
        this.execaPackage = await import('execa')

        const wrapStdoutStderr = (type: 'stdout' | 'stderr') => {
            const log = this.logger[type === 'stdout' ? 'info' : 'error']
            return function * (line: string) {
                log(' '.repeat('Running $ '.length) + line)
            }
        }

        const wrapExeca = <T>(execa: ExecaMethod<T>): ExecaMethod<T> => (...p: any[]) => {
            if (p.length > 1 && p[0] instanceof Array) this.logger.info('Running $ %s', String.raw(...p as [any]))
            const result = execa({
                stdout: wrapStdoutStderr('stdout'),
                stderr: wrapStdoutStderr('stderr')
            })(...p as [any])
            if (typeof result === 'function') return wrapExeca(result) as any
            return result
        }

        this.execa = wrapExeca(this.execaPackage.execa)

        if (! this.config.registry) {
            this.config.registry = await getRegistry()
            this.ctx.scope.update(this.config)
        }
    }

    logger = this.ctx.logger('w-node')

    execaPackage: typeof import('execa')
    execa: ExecaMethod<{}>

    escapePackageName = (packageName: string) => packageName
        .replace('@', 'at__').replace('/', '__slash__')

    unescapePackageName = (escapedPackageName: string) => escapedPackageName
        .replace('at__', '@').replace('__slash__', '/')

    async install(packageName: string, version?: string) {
        const cwd = path.resolve(this.config.packagePath, this.escapePackageName(packageName))

        this.logger.info(`Making directory '${cwd}'.`)
        await fs.mkdir(cwd, { recursive: true })
        await fs.writeFile(path.resolve(cwd, 'package.json'), '{}')

        const packageStr = `${packageName}@${version || 'latest'}`
        this.logger.info(`Installing '${packageName}'...`)
        await this.execa({ cwd })`npm add ${packageName} --color always --registry ${this.config.registry}`

        this.logger.info(`Installed package '${packageName}'.`)
    }

    async safeImport<T>(
        packageName: string,
        { maxRetry = 3, forceInstall = false }: { maxRetry?: number, forceInstall?: boolean } = {}
    ): Promise<T> {
        const cwd = path.resolve(this.config.packagePath, this.escapePackageName(packageName))
        const pkgd = path.resolve(cwd, 'node_modules', packageName)

        if (forceInstall || ! await exists(pkgd)) await this.install(packageName)
        else this.logger.info(`Hit cached package '${packageName}'.`)

        try {
            return require(pkgd) as T
        }
        catch (err) {
            this.logger.error('Failed to require package: %o', err)
            if (maxRetry > 0) {
                return this.safeImport(packageName, { maxRetry: maxRetry - 1, forceInstall: true })
            }
            throw err
        }
    }
}

namespace NodeService {
    export interface Config {
        packagePath: string
        registry: string
    }

    export const Config: z<Config> = z.object({
        packagePath: z
            .string()
            .default(path.resolve(os.tmpdir(), 'w-node'))
            .description('存放 npm 包的位置'),
        registry: z
            .string()
            .default('')
            .description('npm 源地址，默认与当前项目相同')
    })
}

export default NodeService