// 服务端日志的单测：精简日志的「行为合同」。
//
// 为什么要测：日志是**给人看的**，最容易悄悄退化——要么被请求级噪声淹没，
// 要么被人顺手改成打一整坨 JSON，要么在测试里刷屏。这里把三条约定钉住：
//   1) silent 级别完全不输出（测试环境靠它保持 node --test 输出干净）；
//   2) 每行使用 `[yy/mm/dd HH:mm:ss UTC] LEVEL: message` 格式；
//   3) 上下文压成 key=value，避免把 JSON 直接展示给人看。
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

test('日志：info 输出指定时间戳和级别格式', () => {
  const lines = capture(() => createLogger('info').info('建房「周末局」房主 阿水')).split('\n')
  assert.equal(lines.length, 1)
  assert.match(lines[0]!, /^\[\d{2}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} UTC\] INFO: 建房「周末局」房主 阿水$/)
})

test('日志：上下文压成简洁的 key=value 文本，Error 保留原因', () => {
  const lines = capture(() =>
    createLogger('info').error('端口监听失败，进程退出', { host: '127.0.0.1', port: 3000, detail: new Error('EADDRINUSE') }),
  ).split('\n')
  assert.equal(lines.length, 1)
  assert.match(lines[0]!, / ERROR: 端口监听失败，进程退出 host=127\.0\.0\.1 port=3000 detail=EADDRINUSE$/)
})

test('日志：长文本按 120 个字符换行，续行缩进对齐', () => {
  const lines = capture(() => createLogger('info').info('牌局摘要'.repeat(50))).split('\n')
  assert.ok(lines.length > 1)
  assert.match(lines[0]!, /^\[\d{2}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} UTC\] INFO: /)
  const indent = ' '.repeat(lines[0]!.indexOf('INFO: ') + 'INFO: '.length)
  assert.ok(lines.slice(1).every((line) => line.startsWith(indent)))
  assert.ok(lines.every((line) => Array.from(line).length <= 120))
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
