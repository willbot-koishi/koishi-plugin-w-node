import { it, before, after, skip } from 'node:test'
import { setTimeout as wait } from 'node:timers/promises'
import assert from 'node:assert/strict'

import { Context, type Plugin } from 'koishi'
import Mock from '@koishijs/plugin-mock'
import Http from '@cordisjs/plugin-http'
import NodeService from '../src'

import * as semver from 'semver'
import { ReadWriteLock } from '../src/utils'

const app = new Context()

app.plugin(Http)
app.plugin(NodeService)
const mock = app.plugin(Mock as Plugin.Constructor)
const client = app.mock.client('mock')

before(() => app.start())
after(async () => {
  mock.dispose()
  await app.stop()
})

const p = 'semver'

skip('ReadWriteLock', async () => {
  const l = []
  const lock = new ReadWriteLock()
  const startTime = Date.now()
  let wStartTime: number
  let rStartTime: number
  void lock.r(async () => {
    await wait(300)
  })
  void lock.r(async () => {
    await wait(300)
  })
  await lock.r(async () => {
    await wait(300)
  })
  void lock.w(async () => {
    wStartTime = Date.now()
    await wait(300)
    l.push(Date.now())
  })
  void lock.w(async () => {
    await wait(100)
    l.push(Date.now())
  })
  void lock.w(async () => {
    await wait(200)
    l.push(Date.now())
  })
  await lock.r(async () => {
    rStartTime = Date.now()
    const ll = [...l]
    ll.sort()
    assert.ok(l.length === 3)
    assert.ok(JSON.stringify(l) === JSON.stringify(ll))
  })
  assert.ok(wStartTime - startTime < 320)
  assert.ok(rStartTime - startTime > (300 + 300 + 100 + 200))
})

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

it('w-node ReadWriteLock', async () => {
  await app.node.install(p)
  const promise = app.node.remove(p)
  assert.ok(! (await app.node.has(p)))
  assert.ok(await promise)
})

it('w-node install concurrent', async () => {
  const tasks = []
  for (let i = 0; i < 30; i ++) {
    tasks.push(app.node.install(p, '7.8.5'))
  }
  await Promise.all(tasks)
  await app.node.remove(p, '7.8.5')
})
