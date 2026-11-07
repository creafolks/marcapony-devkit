import { describe, expect, it } from 'bun:test'
import {
  ALLOW_COMMENT,
  FORBIDDEN_DIRS,
  forbiddenPathReason,
  blockingFindings,
  isUnscannable,
  jwtHasPrivateRole,
  MAX_SCAN_BYTES,
  maskValue,
  scanText,
  shannonEntropy,
} from '../scan-rules'

// Every example below is built at runtime so this file itself never holds a
// real-shaped secret on one line.
const j = (...parts: string[]) => parts.join('')
const b64url = (o: unknown) =>
  btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const jwt = (claims: unknown) =>
  `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}.${'s'.repeat(43)}`

const cli = (path: string, text: string) => scanText(path, text, { side: 'cli' })
const server = (path: string, text: string) => scanText(path, text, { side: 'server' })
const ids = (path: string, text: string) => cli(path, text).map((f) => f.ruleId)

describe('provider patterns', () => {
  const cases: Array<[string, string, string]> = [
    ['marcapony-key', j('const k = "mpk', '_', 'A1b2C3d4E5f6G7h8I9"'), j('mpk', '_', 'short')],
    ['artifacts-token', j('art', '_v1_', 'abcdefghijklmnop1234'), j('art', '_v1_', 'abc')],
    ['stripe-key', j('sk', '_live_', 'a'.repeat(24)), j('sk', '_live_', 'abc')],
    ['aws-access-key-id', j('AKIA', 'ABCDEFGHIJKLMNOP'), j('AKIA', 'abc')],
    [
      'aws-secret-key',
      j('aws_secret_access_key = "', 'A'.repeat(20), 'b/c+'.repeat(5), '"'),
      'aws_secret_access_key = "short"',
    ],
    ['gcp-service-account', '{ "type": "service_account" }', '{ "type": "user" }'],
    ['gcp-api-key', j('AIza', 'B'.repeat(35)), j('AIza', 'B'.repeat(10))],
    ['github-token', j('ghp', '_', 'a'.repeat(36)), j('ghp', '_', 'a'.repeat(10))],
    ['slack-token', j('xox', 'b-', '1234567890-abcdef'), j('xox', 'b-', '12')],
    ['anthropic-key', j('sk', '-ant-', 'api03-', 'x'.repeat(30)), j('sk', '-ant-', 'x')],
    ['openai-key', j('sk', '-proj-', 'y'.repeat(30)), j('sk', '-', 'y')],
    [
      'cloudflare-token',
      j('CLOUDFLARE_API_TOKEN=', 'Z'.repeat(40)),
      j('CLOUDFLARE_API_TOKEN=', 'Z'.repeat(8)),
    ],
    ['private-key', j('-----BEGIN RSA ', 'PRIVATE KEY-----'), '-----BEGIN PUBLIC KEY-----'],
    [
      'iyzico-key',
      j('IYZICO_SECRET_KEY: "', 'sandbox-', 'q'.repeat(20), '"'),
      'IYZICO_SECRET_KEY: "abc"',
    ],
    ['paytr-key', j("paytr_merchant_salt = '", 'r'.repeat(16), "'"), "paytr_merchant_salt = 'r'"],
  ]

  for (const [rule, hit, miss] of cases) {
    it(`${rule}: a real-shaped value is found, a near-miss is not`, () => {
      expect(ids('src/a.ts', hit)).toContain(rule)
      expect(ids('src/a.ts', miss)).not.toContain(rule)
    })
  }

  it('the Anthropic key is not also reported as an OpenAI key', () => {
    expect(ids('a.ts', j('sk', '-ant-', 'x'.repeat(30)))).not.toContain('openai-key')
  })

  it('reports the line number and masks the value', () => {
    const [finding] = cli('src/a.ts', j('// one\nconst k = "mpk', '_', 'A1b2C3d4E5f6G7h8I9"'))
    expect(finding?.line).toBe(2)
    expect(finding?.masked).toBe('mpk_…')
    expect(JSON.stringify(finding)).not.toContain('A1b2C3d4')
  })
})

describe('JWT roles', () => {
  it('a service_role key is a finding', () => {
    expect(jwtHasPrivateRole(jwt({ role: 'service_role' }))).toBe(true)
    expect(ids('a.ts', jwt({ role: 'service_role' }))).toContain('jwt-private-role')
  })
  it('anon and authenticated keys, and tokens without a role, are not', () => {
    expect(jwtHasPrivateRole(jwt({ role: 'anon' }))).toBe(false)
    expect(jwtHasPrivateRole(jwt({ role: 'authenticated' }))).toBe(false)
    expect(jwtHasPrivateRole(jwt({ sub: 'x' }))).toBe(false)
    expect(jwtHasPrivateRole('eyJ.not-json.x')).toBe(false)
  })
})

describe('generic rule', () => {
  const random = 'Kq8vZ2pL0xW7nB4tR9mY3cF6'
  it('a key-like name with a random quoted value is found', () => {
    expect(ids('a.ts', `const clientSecret = "${random}"`)).toEqual(['generic-secret'])
  })
  it('a low-entropy value is not', () => {
    expect(shannonEntropy('aaaaaaaaaaaaaaaaaaaaaaaa')).toBe(0)
    expect(ids('a.ts', 'const password = "aaaaaaaaaaaaaaaaaaaaaaaa"')).toEqual([])
  })
  it('the entropy threshold is strict', () => {
    // 16 distinct characters, each once: exactly 4 bits; 8 distinct, repeated: 3 bits.
    expect(shannonEntropy('abcdefghijklmnop')).toBe(4)
    expect(ids('a.ts', 'const token = "abcdefghabcdefghabcdefgh"')).toEqual([])
  })
  it('a short value is not', () => {
    expect(ids('a.ts', 'const token = "Kq8vZ2pL0x"')).toEqual([])
  })
  it('template placeholders are not', () => {
    expect(ids('a.ts', 'const apiKey = "your-api-key-goes-here-123"')).toEqual([])
    expect(ids('.env.local.example', j('MARCAPONY_API_KEY=mpk', '_...'))).toEqual([])
  })
  it('test fixtures are exempt from the generic rule only', () => {
    const generic = cli('src/auth.test.ts', `const token = "${random}"`)
    expect(generic[0]?.allowed).toBe(true)
    const provider = cli(
      'src/__fixtures__/keys.ts',
      j('const k = "mpk', '_', 'A1b2C3d4E5f6G7h8I9"'),
    )
    expect(provider[0]?.allowed).toBe(false)
  })
})

describe('allow comment', () => {
  const random = 'Kq8vZ2pL0xW7nB4tR9mY3cF6'
  const providerLine = j('const k = "mpk', '_', 'A1b2C3d4E5f6G7h8I9"')

  it('exempts its own line and the line below, and the match is still listed', () => {
    const sameLine = cli('a.ts', `const token = "${random}" // ${ALLOW_COMMENT}`)
    expect(sameLine).toHaveLength(1)
    expect(sameLine[0]?.allowed).toBe(true)
    const lineAbove = cli('a.ts', `// ${ALLOW_COMMENT}\nconst token = "${random}"`)
    expect(lineAbove[0]?.allowed).toBe(true)
    expect(blockingFindings(lineAbove)).toEqual([])
  })

  it('on the server it exempts the generic rule but never a provider pattern', () => {
    expect(server('a.ts', `// ${ALLOW_COMMENT}\nconst token = "${random}"`)[0]?.allowed).toBe(true)
    expect(server('a.ts', `// ${ALLOW_COMMENT}\n${providerLine}`)[0]?.allowed).toBe(false)
    expect(cli('a.ts', `// ${ALLOW_COMMENT}\n${providerLine}`)[0]?.allowed).toBe(true)
  })

  it('does not reach two lines down', () => {
    expect(cli('a.ts', `// ${ALLOW_COMMENT}\n\nconst token = "${random}"`)[0]?.allowed).toBe(false)
  })
})

describe('helpers', () => {
  it('masks to four characters', () => {
    expect(maskValue('abcdefgh')).toBe('abcd…')
    expect(maskValue('abc')).toBe('****')
  })
  it('binary and oversized files are not scanned', () => {
    expect(isUnscannable('a\u0000b', 3)).toBe(true)
    expect(isUnscannable('ok', MAX_SCAN_BYTES + 1)).toBe(true)
    expect(isUnscannable('ok', 2)).toBe(false)
  })
})

describe('long lines', () => {
  it('a long line of name characters is scanned quickly', () => {
    const line = `${'a'.repeat(200_000)}token = "x"`
    const started = performance.now()
    scanText('bundle.js', line, { side: 'server' })
    expect(performance.now() - started).toBeLessThan(500)
  })
})

describe('forbiddenPathReason', () => {
  it('names the forbidden directory at any depth', () => {
    expect(forbiddenPathReason('node_modules/react/index.js')).toBe('node_modules/')
    expect(forbiddenPathReason('packages/web/node_modules/x.js')).toBe('node_modules/')
    expect(forbiddenPathReason('.wrangler/state/v3/d1.sqlite')).toBe('.wrangler/')
    expect(forbiddenPathReason('sub/.git/config')).toBe('.git/')
    expect(forbiddenPathReason('.marcapony/state.json')).toBe('.marcapony/')
  })

  it('flags credential file names but not committed examples', () => {
    expect(forbiddenPathReason('.dev.vars')).toBe('credential file')
    expect(forbiddenPathReason('config/.env.production')).toBe('credential file')
    expect(forbiddenPathReason('certs/server.pem')).toBe('credential file')
    expect(forbiddenPathReason('id_ed25519')).toBe('credential file')
    expect(forbiddenPathReason('.env.example')).toBeNull()
    expect(forbiddenPathReason('.env.local.example')).toBeNull()
  })

  it('allows ordinary paths and look-alikes', () => {
    expect(forbiddenPathReason('src/node_modules.ts')).toBeNull()
    expect(forbiddenPathReason('docs/git.md')).toBeNull()
    expect(forbiddenPathReason('marcapony.lock')).toBeNull()
    expect(forbiddenPathReason('src/keyboard.ts')).toBeNull()
  })

  it('lists the directories the CLI never collects', () => {
    expect([...FORBIDDEN_DIRS].sort()).toEqual(['.git', '.marcapony', '.wrangler', 'node_modules'])
  })
})
