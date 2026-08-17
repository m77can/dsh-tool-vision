// DeepSeek Web API 的 PoW（DeepSeekHashV1）求解器。
// 移植自 deepseek-vision-mcp-rs crates/cli/src/pow.rs，复用同一份
// sha3_wasm_bg WASM（原项目 assets 目录携带，无外部 import）。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const WASM_PATH = fileURLToPath(new URL('../assets/sha3_wasm_bg.7b9ca65ddd.wasm', import.meta.url))

/** 懒加载的单例 WASM 实例。 */
let wasmInstancePromise

function getWasmInstance() {
  if (wasmInstancePromise === undefined) {
    wasmInstancePromise = (async () => {
      const bytes = readFileSync(WASM_PATH)
      const { instance } = await WebAssembly.instantiate(bytes, {})
      const { memory, wasm_solve, __wbindgen_add_to_stack_pointer, __wbindgen_export_0 } = instance.exports
      if (!memory || typeof wasm_solve !== 'function' || typeof __wbindgen_add_to_stack_pointer !== 'function' || typeof __wbindgen_export_0 !== 'function') {
        throw new Error('PoW WASM 导出不完整')
      }
      return {
        memory,
        wasm_solve,
        stackPtr: __wbindgen_add_to_stack_pointer,
        alloc: __wbindgen_export_0,
      }
    })()
  }
  return wasmInstancePromise
}

function writeMemory(wasm, text) {
  const bytes = new TextEncoder().encode(text)
  const ptr = wasm.alloc(bytes.length, 1)
  // alloc 可能触发 WASM 内存增长，导致旧 buffer 被 detach，因此每次重新读取 buffer。
  const view = new DataView(wasm.memory.buffer)
  if (ptr + bytes.length > view.byteLength) throw new Error('WASM 内存越界')
  for (let i = 0; i < bytes.length; i++) view.setUint8(ptr + i, bytes[i])
  return [ptr, bytes.length]
}

/**
 * 求解 PoW challenge，返回 base64 编码的 JSON 应答（作为 x-ds-pow-response 请求头）。
 * @param {string} configInput - create_pow_challenge 返回的 challenge JSON 字符串
 */
export async function solvePowChallenge(configInput) {
  let config
  try {
    config = JSON.parse(configInput)
  } catch {
    throw new Error('PoW challenge 不是合法 JSON')
  }

  const algorithm = config.algorithm ?? 'DeepSeekHashV1'
  if (algorithm !== 'DeepSeekHashV1' && algorithm !== 'hashcash_v1' && algorithm !== 'hashcash') {
    throw new Error(`不支持的 PoW 算法: ${algorithm}`)
  }
  const challenge = config.challenge
  const salt = config.salt
  const difficulty = Number(config.difficulty)
  const expireAt = config.expire_at
  const signature = config.signature
  const targetPath = config.target_path ?? '/api/v0/chat/completion'

  if (challenge === undefined) throw new Error('PoW challenge 缺失')
  if (salt === undefined) throw new Error('PoW salt 缺失')
  if (!Number.isFinite(difficulty)) throw new Error('PoW difficulty 缺失')
  if (expireAt === undefined) throw new Error('PoW expire_at 缺失')
  if (signature === undefined) throw new Error('PoW signature 缺失')

  const wasm = await getWasmInstance()

  const [chPtr, chLen] = writeMemory(wasm, String(challenge))
  const prefix = `${salt}_${expireAt}_`
  const [pPtr, pLen] = writeMemory(wasm, prefix)

  const retptr = wasm.stackPtr(-16)
  try {
    wasm.wasm_solve(retptr, chPtr, chLen, pPtr, pLen, difficulty)
    // wasm_solve 可能触发内存增长，读取结果前重新取 buffer。
    const resultView = new DataView(wasm.memory.buffer)
    const status = resultView.getInt32(retptr, true)
    if (status === 0) throw new Error('PoW 求解失败')
    const value = resultView.getFloat64(retptr + 8, true)
    const answer = Math.round(value)

    const result = { algorithm, challenge, salt, answer, signature, target_path: targetPath }
    return Buffer.from(JSON.stringify(result), 'utf8').toString('base64')
  } finally {
    wasm.stackPtr(16)
  }
}
