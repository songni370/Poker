import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

test('部署脚本在检查或上传失败时中止，成功时才请求远程发布', () => {
  const dir = mkdtempSync(join(tmpdir(), 'poker-deploy-test-'))
  try {
    const log = join(dir, 'calls')
    const payload = join(dir, 'remote.sh')
    const mocks = {
      npm: 'echo "npm $*" >> "$DEPLOY_TEST_LOG"\n[ "$*" != "${DEPLOY_TEST_FAIL:-}" ]',
      rsync: 'echo "rsync" >> "$DEPLOY_TEST_LOG"\n[ "${DEPLOY_TEST_FAIL:-}" != upload ]',
      ssh: `echo "ssh" >> "$DEPLOY_TEST_LOG"
case "$*" in
  *"bash -se --"*) cat > "$DEPLOY_TEST_PAYLOAD"; bash -n "$DEPLOY_TEST_PAYLOAD" ;;
  *) cat >/dev/null; echo /var/www/poker-room/.deploy-test1234 ;;
esac`,
    }
    for (const [name, body] of Object.entries(mocks)) {
      writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 })
    }
    const run = (failure: string, args: string[] = []) => {
      writeFileSync(log, '')
      const result = spawnSync(resolve('deploy.sh'), args, {
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH ?? ''}`,
          DEPLOY_TEST_LOG: log,
          DEPLOY_TEST_PAYLOAD: payload,
          DEPLOY_TEST_FAIL: failure,
        },
        encoding: 'utf8',
      })
      return { result, calls: readFileSync(log, 'utf8').trim().split('\n') }
    }
    const invalid = run('', ['-bad-host'])
    assert.equal(invalid.result.status, 2)
    assert.deepEqual(invalid.calls, [''])
    const lintFailure = run('run lint')
    assert.notEqual(lintFailure.result.status, 0)
    assert.deepEqual(lintFailure.calls, ['npm run lint'])
    const uploadFailure = run('upload')
    assert.notEqual(uploadFailure.result.status, 0)
    assert.deepEqual(uploadFailure.calls, [
      'npm run lint', 'npm run typecheck', 'npm run build', 'ssh', 'rsync',
    ])
    const success = run('')
    assert.equal(success.result.status, 0, success.result.stderr)
    assert.deepEqual(success.calls, [
      'npm run lint', 'npm run typecheck', 'npm run build', 'ssh', 'rsync', 'rsync', 'ssh',
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
