/**
 * Prisma 7 generates TS with bare relative imports (e.g. from "./enums").
 * tsc + module:NodeNext copies them verbatim — Node ESM can't resolve them.
 * This patches all .js files under dist/generated/prisma to add .js extensions.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(import.meta.url), '../../dist/generated/prisma')

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.name.endsWith('.js')) yield full
  }
}

let patched = 0
for await (const file of walk(root)) {
  const original = readFileSync(file, 'utf8')
  const fixed = original.replace(
    /(from\s+["'])(\.{1,2}\/[^"']+?)(?<!\.js)(?<!\.mjs)(?<!\.cjs)(["'])/g,
    '$1$2.js$3'
  )
  if (fixed !== original) {
    writeFileSync(file, fixed, 'utf8')
    patched++
    console.log(`  patched: ${file}`)
  }
}
console.log(`fix-prisma-imports: ${patched} file(s) patched.`)
