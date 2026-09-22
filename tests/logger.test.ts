// 服务端日志的单测：精简日志的「行为合同」。
//
// 为什么要测：日志是**给人看的**，最容易悄悄退化——要么被请求级噪声淹没，
// 要么被人顺手改成打一整坨 JSON，要么在测试里刷屏。这里把三条约定钉住：
//   1) silent 级别完全不输出（测试环境靠它保持 node --test 输出干净）；
//   2) info 级别的每行都是「一条消息 + ISO 时间戳」，不带 pid/hostname 这类噪声；
//   3) 结构化上下文作为数据保留（便于 grep），但消息本身仍是人话。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLogger, silentLogger } from '../src/server/logger.ts'

/** 抓住 pino 写到 stdout 的那一行。 */
function capture(run: () => void): string {
  const original = process.stdout.write.bind(process.stdout)
  let output = ''
  process.stdout.write = ((chunk: unknown) => {
    output += String(chunk)
    return true
  }) as typeof process.stdout.write
  try {
    run()
  } finally {
    process.stdout.write = original
  }
  return output.trim()
}

test('日志：silent 级别什么也不输出', () => {
  const output = capture(() => {
    const logger = createLogger('silent')
    logger.info('不该出现')
    logger.warn('不该出现')
    logger.error('不该出现')
  })
  assert.equal(output, '')
  // 空实现与 silent 是同一个对象：业务层默认值不会产生任何副作用。
  assert.equal(createLogger('silent'), silentLogger)
})

test('日志：info 每行一条消息，带 ISO 时间戳，不带 pid/hostname', () => {
  const lines = capture(() => createLogger('info').info('建房「周末局」房主 阿水')).split('\n')
  assert.equal(lines.length, 1)
  const line = JSON.parse(lines[0]!) as { level: number; time: string; msg: string; pid?: number; hostname?: string }
  assert.equal(line.msg, '建房「周末局」房主 阿水')
  assert.equal(line.level, 30)
  // ISO 时间戳：肉眼可读、可排序。
  assert.match(line.time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  // 单进程部署里 pid/hostname 只是噪声，必须去掉。
  assert.equal(line.pid, undefined)
  assert.equal(line.hostname, undefined)
})

test('日志：上下文里的 Error 压成一行文本（否则 pino 会输出成 {} 把原因丢掉）', () => {
  const lines = capture(() =>
    createLogger('info').error('端口监听失败，进程退出', { host: '127.0.0.1', port: 3000, detail: new Error('EADDRINUSE') }),
  ).split('\n')
  assert.equal(lines.length, 1)
  const line = JSON.parse(lines[0]!) as Record<string, unknown>
  assert.equal(line.msg, '端口监听失败，进程退出')
  assert.equal(line.host, '127.0.0.1')
  assert.equal(line.port, 3000)
  assert.equal(line.detail, 'EADDRINUSE')
})

test('日志：warn 及以上才输出时，info 被过滤', () => {
  const output = capture(() => {
    const logger = createLogger('warn')
    logger.info('这条不该出现')
    logger.warn('这条要出现')
  })
  assert.ok(!output.includes('这条不该出现'), 'warn 级别不应输出 info')
  assert.ok(output.includes('这条要出现'))
})
