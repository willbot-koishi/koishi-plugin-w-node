import { it, before, after } from 'node:test'
import { setTimeout as wait } from 'node:timers/promises'
import assert from 'node:assert/strict'

import { Context } from 'koishi'
import MOCK from '@koishijs/plugin-mock'
import HTTP from '@cordisjs/plugin-http'
import { Installer } from '@koishijs/plugin-market'
import NodeService from '../src'

import * as semver from 'semver'

const app = new Context()

app.plugin(HTTP)
app.plugin(Installer, { endpoint: 'https://registry.npmmirror.com/' })
app.plugin(NodeService)
app.plugin(MOCK)
const client = app.mock.client('123')

before(() => app.start())
after(() => app.stop())

const p = 'semver'
it('w-node service', async (t) => {
  await t.test('install', async () => {
    const v = await app.node.install(p)
    assert.ok(v)
  })

  await t.test('install ~6.1', async () => {
    const v = await app.node.install(p, '~6.1')
    assert.ok(v)
  })

  await t.test('has', async () => {
    assert.ok(await app.node.has(p))
  })

  await t.test('has ~6.1', async () => {
    assert.ok(await app.node.has(p, '~6.1'))
  })

  await t.test('import', async () => {
    const pkg: typeof semver = await app.node.import(p)
    assert.equal(
      pkg.sort(['11.45.13', '11.45.14', '1.2.3', '11.45.14-1919810']).join(', '),
      '1.2.3, 11.45.13, 11.45.14-1919810, 11.45.14')
  })

  await t.test('remove ~6.1', async () => {
    assert.ok(await app.node.remove(p, '~6.1'))
  })

  await t.test('remove', async () => {
    assert.ok(await app.node.remove(p))
  })
})

it('w-node cmd', async (t) => {
  await t.test('install', async () => {
    const [msg] = await client.receive(`node.install ${p}`)
    assert.match(msg, /^安装成功/)
  })

  await t.test('install ~6.1', async () => {
    const [msg] = await client.receive(`node.install ${p} -v ~6.1`)
    assert.match(msg, /^安装成功/)
  })

  await t.test('install 2', async () => {
    const [msg] = await client.receive(`node.install ${p} -v 2`)
    assert.match(msg, /^安装成功/)
  })

  await t.test('install ~2.0.0-0 <2.0.1', async () => {
    const [msg] = await client.receive(`node.install ${p} -v '~2.0.0-0 <2.0.1'`)
    assert.match(msg, /^安装成功/)
  })

  await t.test('list', async () => {
    const [msg] = await client.receive(`node.list`)
    console.log(msg)
  })

  await t.test('info', async () => {
    const [msg] = await client.receive(`node.info ${p}`)
    assert.ok(msg.includes(`"name": "${p}"`))
  })

  await t.test('exec', async () => {
    await client.shouldReply(
      `node.exec ${p} pkg.sort(['11.45.13', '11.45.14', '1.2.3', '11.45.14-1919810']).join(', ')`,
      '1.2.3, 11.45.13, 11.45.14-1919810, 11.45.14',
    )
  })

  await t.test('remove 2', async () => {
    await client.shouldReply(`node.remove ${p} -v 2`, '移除成功')
  })

  await t.test('remove', async () => {
    await client.shouldReply(`node.remove ${p}`, '移除成功')
  })
})

it('w-node clean', async () => {
  await app.node.install(p, '7.8.5')
  await app.node.install(p, '6.1.3')
  await wait(3000)
  await app.node.import(p, { version: '6.1.3' })
  await app.node.removeUnaccessed(2000)
  const res6 = await app.node.has(p, '6.1.3')
  const res7 = await app.node.has(p, '7.8.5')
  await app.node.remove(p)
  assert.ok(res6)
  assert.ok(! res7)
})
