// e2e 专用的数据库清理：每次跑 e2e 前删掉 data/e2e.sqlite。
//
// 为什么需要它：e2e 服务端（playwright.config.ts）用独立的 DATABASE_PATH，
// 启动时会从快照恢复未关闭的房间。e2e 里建的房间不会在用例结束时关闭，
// 于是每跑一轮就多攒几个房间，几轮之后撞上服务器全局桌上的上限
// （MAX_ROOMS=20），大厅直接提示「已满」，后面所有用例都会在建房这一步失败。
// 这个文件只服务于自动化测试，生产库 data/poker.sqlite 不受影响。
import { rmSync } from 'node:fs'

const TARGETS = ['data/e2e.sqlite', 'data/e2e.sqlite-wal', 'data/e2e.sqlite-shm']

for (const file of TARGETS) {
  rmSync(file, { force: true })
}

console.log(`[e2e] 已重置测试数据库：${TARGETS.join('、')}`)
