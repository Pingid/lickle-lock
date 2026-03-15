import { spawn } from 'node:child_process'

const run = (cmd, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', shell: true })
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} exited with code ${code}`))
    })
    child.on('error', reject)
  })

const args = process.argv.slice(2)

const common = ['build', '--release', '--platform', '--no-const-enum']
await run('napi', [...common, '--esm', '--js', './esm.js', ...args])
await run('napi', [...common, '--js', './cjs.js', ...args])

await Promise.all([
  run('tsc', ['-p', 'tsconfig.esm.json']),
  run('tsc', ['-p', 'tsconfig.cjs.json']),
])
