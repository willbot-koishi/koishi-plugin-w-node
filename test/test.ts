import { it } from 'node:test'

import { Context } from 'koishi'
import NodeService from '../src'

import * as semver from 'semver'

const app = new Context()

app.plugin(NodeService)

it('w-node', async () => {
  void [semver]

  throw new Error('Not implemented')
})
