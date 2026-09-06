// Angular compiles inline templates at runtime, so webpack cannot see a broken binding — this can.
import { readFileSync } from 'fs'
import * as compiler from '@angular/compiler'

const file = process.argv[2] ?? 'src/sessionList.component.ts'
const src = readFileSync(file, 'utf8')

const match = src.match(/template:\s*`([\s\S]*?)`,\n\s*styles:/)
if (!match) {
  console.error(`${file}: no inline template found`)
  process.exit(1)
}

// Reverse the TS template-literal escaping so we check the string Angular actually receives.
const template = match[1].replace(/\\`/g, '`').replace(/\\\\/g, '\\').replace(/\\\$/g, '$')

const { errors } = compiler.parseTemplate(template, file)
const unique = [...new Set((errors ?? []).map(e => e.msg ?? String(e)))]
if (unique.length) {
  console.error(`${file}: template errors`)
  for (const msg of unique) {
    console.error(`  - ${msg}`)
  }
  process.exit(1)
}

console.log(`${file}: template OK`)
