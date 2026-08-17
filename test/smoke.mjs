import assert from 'node:assert/strict'
import { detectFormat, prepareUpload, readImageBase64, imageMime, isAbsoluteImagePath } from '../src/image.js'
import { parseSseResponse } from '../src/vision.js'
import { solvePowChallenge } from '../src/pow.js'
import { name as pluginName, inject, apply } from '../src/index.js'

// --- image ---
assert.equal(readImageBase64('data:image/png;base64,aGVsbG8='), 'aGVsbG8=')
assert.equal(isAbsoluteImagePath('/tmp/a.png'), true)
assert.equal(isAbsoluteImagePath('C:\\Users\\a.png'), true)
assert.equal(isAbsoluteImagePath('D:/a.png'), true)
assert.equal(isAbsoluteImagePath('local://x.png'), false)
assert.equal(detectFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), 'png')
assert.equal(detectFormat(new Uint8Array([0xff, 0xd8, 0xff])), 'jpg')
const up = prepareUpload(Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'))
assert.equal(up.mime, 'image/png')
assert.match(up.filename, /^img_\d+\.png$/)

// --- SSE ---
const sse = [
  'data: {"type":"text","v":"你好"}',
  'data: {"type":"text","text":"，世界"}',
  'data: {"type":"text","v":"！"}',
  'data: [DONE]',
].join('\n')
assert.equal(parseSseResponse(sse), '你好，世界！')
assert.equal(parseSseResponse('data: {"type":"error","content":"boom"}'), '__SSE_ERROR__:boom')
assert.equal(parseSseResponse('no data'), '（无返回内容）')

// --- PoW WASM 可实例化；假 challenge 解不出答案（status 0）---
await assert.rejects(
  () => solvePowChallenge(JSON.stringify({
    algorithm: 'DeepSeekHashV1',
    challenge: 'abc',
    salt: 's',
    difficulty: 100000,
    expire_at: 1,
    signature: 'sig',
  })),
  /PoW 求解失败/,
)

// --- 插件入口结构 ---
assert.equal(pluginName, 'tool-vision')
assert.deepEqual(inject, ['tools', 'systemPrompt', 'webServer'])

// --- apply 注册行为（mock ctx）---
const registered = []
let section = undefined
const ctx = {
  tools: { register: (def) => { registered.push(def); return () => {} } },
  systemPrompt: { section: (s) => { section = s; return () => {} } },
  effect: () => () => {},
  get: () => undefined,
  logger: undefined,
}
apply(ctx, { timeoutMs: 60000 })
assert.equal(registered.length, 1)
const tool = registered[0]
assert.equal(tool.name, 'recognize_image')
assert.equal(tool.parameters.required[0], 'image')
assert.equal(tool.output.schema.type, 'string')
assert.equal(typeof tool.execute, 'function')
assert.equal(section.name, 'plugin:tool-vision')

console.log('smoke ok: image / sse / pow-wasm / plugin-apply')
