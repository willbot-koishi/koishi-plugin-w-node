import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { execaCommand, type Options as ExecaOptions } from 'execa'

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
    logger = this.ctx.logger('w-node')
    execa = async <NewOptionsType extends ExecaOptions = {}>(command: string, options?: NewOptionsType) => {
        this.logger.info('Running $ ' + command)
        const result = await execaCommand(command, options)
        if (result.stdout) this.logger.info(result.stdout)
        if (result.stderr) this.logger.error(result.stderr)
        return result
    }

    constructor(ctx: Context, public config: NodeService.Config) {
        super(ctx, 'node')

        ctx.command('node.list')
            .action(async () => {
                const dir = this.config.packagePath
                if (! exists(dir)) return 'Package directory '
                const subs = await fs.readdir(dir)
                return `共安装了 ${subs.length} 个包：`
            })
    }

    async safeImport<T>(packageName: string): Promise<T> {
        const cwd = path.resolve(this.config.packagePath, packageName)
        const proxy = this.config.proxyPrefix
        if (! await exists(cwd)) {
            this.logger.info(`Installing '${packageName}'...`)
            this.logger.info(`Making directory '${cwd}'.`)
            await fs.mkdir(cwd, { recursive: true })
            await this.execa(`npm init -y`, { cwd })
            await this.execa(`${proxy} npm add ${packageName}`, { cwd })
            this.logger.info(`Installed package '${packageName}'.`)
        }
        else {
            this.logger.info(`Hit cached package '${packageName}'.`)
        }
        return require(path.resolve(cwd, 'node_modules', packageName)) as T
    }
}

namespace NodeService {
    export interface Config {
        packagePath: string
        proxyPrefix: string
    }

    export const Config: z<Config> = z.object({
        packagePath: z
            .string()
            .default(path.resolve(os.tmpdir(), 'w-node'))
            .description('存放 npm 包的位置'),
        proxyPrefix: z
            .string()
            .default('')
            .description('命令行代理前缀')
    })
}

export default NodeService