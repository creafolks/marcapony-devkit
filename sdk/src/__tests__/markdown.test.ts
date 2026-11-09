import { describe, expect, it } from 'bun:test'
import { personaMarkdownToText, renderPersonaMarkdown } from '../index'

const md = renderPersonaMarkdown
const text = personaMarkdownToText
const A = 'target="_blank" rel="noopener noreferrer"'

/** Every `<a` in the output, with its href. */
function hrefs(html: string): string[] {
  return [...html.matchAll(/<a href="([^"]*)"/g)].map((m) => m[1]!)
}

/** The tag names in the output; nothing outside the subset may appear. */
function tags(html: string): string[] {
  return [...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1]!.toLowerCase())
}

const SUBSET = new Set(['p', 'br', 'strong', 'em', 'del', 'code', 'a', 'ul', 'ol', 'li'])

describe('renderPersonaMarkdown: inline', () => {
  it('renders bold, emphasis, strikethrough and code', () => {
    expect(md('Try the **Burger**')).toBe('<p>Try the <strong>Burger</strong></p>')
    expect(md('__bold__ and _em_ and *em*')).toBe(
      '<p><strong>bold</strong> and <em>em</em> and <em>em</em></p>',
    )
    expect(md('~~sold out~~')).toBe('<p><del>sold out</del></p>')
    expect(md('use `npm i`')).toBe('<p>use <code>npm i</code></p>')
  })

  it('nests markers', () => {
    expect(md('***both***')).toBe('<p><em><strong>both</strong></em></p>')
    expect(md('**bold *em* bold**')).toBe('<p><strong>bold <em>em</em> bold</strong></p>')
    expect(md('*a **b** c*')).toBe('<p><em>a <strong>b</strong> c</em></p>')
    expect(md('**~~x~~**')).toBe('<p><strong><del>x</del></strong></p>')
    expect(md('*foo**bar**baz*')).toBe('<p><em>foo<strong>bar</strong>baz</em></p>')
  })

  it('leaves unmatched and intraword markers as text', () => {
    expect(md('**unclosed and *also')).toBe('<p>**unclosed and *also</p>')
    expect(md('snake_case_name')).toBe('<p>snake_case_name</p>')
    expect(md('2 * 3 * 4')).toBe('<p>2 * 3 * 4</p>')
    expect(md('~one~ and ~~~three~~~')).toBe('<p>~one~ and ~~~three~~~</p>')
    expect(md('**')).toBe('<p>**</p>')
  })

  it('does not parse inside code spans', () => {
    expect(md('`**x** [a](https://x.test) <b>`')).toBe(
      '<p><code>**x** [a](https://x.test) &lt;b&gt;</code></p>',
    )
    expect(md('``a`b``')).toBe('<p><code>a`b</code></p>')
    expect(md('` `` `')).toBe('<p><code>``</code></p>')
    expect(md('an `unclosed span')).toBe('<p>an `unclosed span</p>')
  })

  it('honours backslash escapes', () => {
    expect(md('\\*not em\\*')).toBe('<p>*not em*</p>')
    expect(md('\\[x](https://x.test)')).toContain('[x](')
  })
})

describe('renderPersonaMarkdown: links', () => {
  it('renders inline links with a new tab and no opener', () => {
    expect(md('[Burger](https://x.test/menu/burger)')).toBe(
      `<p><a href="https://x.test/menu/burger" ${A}>Burger</a></p>`,
    )
  })

  it('renders markup inside a label and links inside emphasis', () => {
    expect(md('[**Burger**](https://x.test)')).toBe(
      `<p><a href="https://x.test" ${A}><strong>Burger</strong></a></p>`,
    )
    expect(md('**[Burger](https://x.test)**')).toBe(
      `<p><strong><a href="https://x.test" ${A}>Burger</a></strong></p>`,
    )
  })

  it('allows mailto, tel, relative and fragment URLs', () => {
    expect(
      hrefs(
        md(
          '[a](mailto:a@x.test) [b](tel:+905551112233) [c](/menu) [d](#hours) [e](?q=1) [f](menu/burger)',
        ),
      ),
    ).toEqual(['mailto:a@x.test', 'tel:+905551112233', '/menu', '#hours', '?q=1', 'menu/burger'])
  })

  it('keeps balanced parentheses and drops a title', () => {
    expect(hrefs(md('[w](https://x.test/a_(b))'))).toEqual(['https://x.test/a_(b)'])
    expect(hrefs(md('[w](https://x.test "Title")'))).toEqual(['https://x.test'])
    expect(hrefs(md('[w](<https://x.test/a b>)'))).toEqual(['https://x.test/a%20b'])
  })

  it('uses the URL as the label of an empty label', () => {
    expect(md('[](https://x.test)')).toBe(`<p><a href="https://x.test" ${A}>https://x.test</a></p>`)
  })

  it('leaves broken link syntax as text', () => {
    expect(md('[label] (https://x.test)')).toContain('[label] (')
    expect(md('[label](https://x.test')).toBe(
      `<p>[label](<a href="https://x.test" ${A}>https://x.test</a></p>`,
    )
  })

  it('autolinks bare http(s) URLs and trims trailing punctuation', () => {
    expect(md('See https://x.test/menu.')).toBe(
      `<p>See <a href="https://x.test/menu" ${A}>https://x.test/menu</a>.</p>`,
    )
    expect(md('(at http://x.test/a_(b))')).toBe(
      `<p>(at <a href="http://x.test/a_(b)" ${A}>http://x.test/a_(b)</a>)</p>`,
    )
    expect(md('**https://x.test**')).toBe(
      `<p><strong><a href="https://x.test" ${A}>https://x.test</a></strong></p>`,
    )
    expect(md('https://x.test/?a=1&b=2')).toBe(
      `<p><a href="https://x.test/?a=1&amp;b=2" ${A}>https://x.test/?a=1&amp;b=2</a></p>`,
    )
  })

  it('does not autolink inside words, labels or without a host', () => {
    expect(md('xhttps://x.test')).toBe('<p>xhttps://x.test</p>')
    expect(md('https://')).toBe('<p>https://</p>')
    expect(hrefs(md('[see https://a.test](https://b.test)'))).toEqual(['https://b.test'])
    expect(md('ftp://x.test')).toBe('<p>ftp://x.test</p>')
  })
})

describe('renderPersonaMarkdown: XSS', () => {
  it('escapes raw HTML', () => {
    expect(md('<script>alert(1)</script>')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')
    expect(md('<img src=x onerror=alert(1)>')).toBe('<p>&lt;img src=x onerror=alert(1)&gt;</p>')
    expect(md(`a & b "c" 'd'`)).toBe('<p>a &amp; b &quot;c&quot; &#39;d&#39;</p>')
  })

  it('refuses dangerous link schemes and keeps the label as text', () => {
    const attacks = [
      '[x](javascript:alert(1))',
      '[x](JaVaScRiPt:alert(1))',
      '[x]( javascript:alert(1))',
      '[x](java\tscript:alert(1))',
      '[x](java\nscript:alert(1))',
      '[x](\u0001javascript:alert(1))',
      '[x](java\u0000script:alert(1))',
      '[x](  JAVASCRIPT :alert(1))',
      '[x](vbscript:msgbox(1))',
      '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
      '[x](file:///etc/passwd)',
      '[x](<javascript:alert(1)>)',
      '[x](javascript:alert(1) "title")',
      '[x](javascript\\:alert(1))',
    ]
    for (const attack of attacks) {
      const html = md(attack)
      expect(hrefs(html)).toEqual([])
      expect(html).not.toContain('<a')
      expect(html.toLowerCase()).not.toMatch(/href\s*=\s*"?\s*(javascript|vbscript|data|file):/)
    }
    expect(md('[x](javascript:alert(1))')).toBe('<p>x</p>')
    expect(md('click [**here**](javascript:alert(1)) now')).toBe(
      '<p>click <strong>here</strong> now</p>',
    )
  })

  it('cannot break out of the href attribute', () => {
    const html = md('[x](https://a.test/" onmouseover="alert(1))')
    expect(html).not.toContain('" onmouseover')
    expect(html).toContain('href="https://a.test/&quot;%20onmouseover=&quot;alert(1)"')
    const auto = md('https://a.test/"onmouseover="alert(1)')
    expect(auto).not.toContain('"onmouseover')
    const single = md("[x](https://a.test/'onmouseover='alert(1))")
    expect(single).not.toContain("'onmouseover")
  })

  it('does not let entities or encoding form a scheme', () => {
    expect(hrefs(md('[x](javascript&#58;alert(1))'))).toEqual(['javascript&amp;#58;alert(1)'])
    expect(hrefs(md('[x](javascript%3Aalert(1))'))).toEqual(['javascript%3Aalert(1)'])
  })

  it('escapes HTML inside every construct', () => {
    const html = md(
      '**<b>x</b>** *<i>* ~~<s>~~ `<u>` [<img src=x onerror=alert(1)>](https://x.test)\n- <li>\n1. <ol>',
    )
    for (const tag of tags(html)) expect(SUBSET.has(tag)).toBe(true)
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<b>')
  })

  it('keeps images and other Markdown as escaped text', () => {
    expect(md('![x](javascript:alert(1))')).toBe('<p>![x](javascript:alert(1))</p>')
    expect(md('![cat](https://x.test/cat.png)')).toBe('<p>![cat](https://x.test/cat.png)</p>')
    expect(md('# Heading\n> quote\n| a | b |\n---')).toBe(
      '<p># Heading<br>&gt; quote<br>| a | b |<br>---</p>',
    )
  })

  it('only ever emits tags from the subset', () => {
    const inputs = [
      '<<script>script>alert(1)<</script>/script>',
      '**[a](https://x.test)** _b_ ~~c~~ `d` <e> &f;',
      '[a](https://x.test)[b](javascript:1)![c](d)',
      '*_~~**__`[]()<>"\'&',
    ]
    for (const input of inputs) {
      for (const tag of tags(md(input))) expect(SUBSET.has(tag)).toBe(true)
    }
  })
})

describe('renderPersonaMarkdown: blocks', () => {
  it('splits paragraphs on blank lines and turns single newlines into <br>', () => {
    expect(md('line one\nline two\n\nsecond')).toBe('<p>line one<br>line two</p><p>second</p>')
    expect(md('a\r\nb\r\n\r\nc')).toBe('<p>a<br>b</p><p>c</p>')
    expect(md('\n\n  padded  \n\n')).toBe('<p>padded</p>')
    expect(md('')).toBe('')
  })

  it('renders hyphen, asterisk and numbered lists', () => {
    expect(md('- one\n- **two**')).toBe('<ul><li>one</li><li><strong>two</strong></li></ul>')
    expect(md('* one\n* two')).toBe('<ul><li>one</li><li>two</li></ul>')
    expect(md('1. one\n2. two')).toBe('<ol><li>one</li><li>two</li></ol>')
    expect(md('3. three\n4. four')).toBe('<ol start="3"><li>three</li><li>four</li></ol>')
  })

  it('starts a list right after a paragraph line', () => {
    expect(md('Options:\n- tea\n- coffee\nEnjoy')).toBe(
      '<p>Options:</p><ul><li>tea</li><li>coffee<br>Enjoy</li></ul>',
    )
    expect(md('We have:\n1. tea\n2. coffee')).toBe(
      '<p>We have:</p><ol><li>tea</li><li>coffee</li></ol>',
    )
    expect(md('Since\n2024. we bake')).toBe('<p>Since<br>2024. we bake</p>')
  })

  it('keeps a list together across blank lines and ends it with a paragraph', () => {
    expect(md('1. one\n\n2. two\n\nAfter')).toBe('<ol><li>one</li><li>two</li></ol><p>After</p>')
    expect(md('- one\n\n  more of one')).toBe('<ul><li>one<br>more of one</li></ul>')
  })

  it('switches list types', () => {
    expect(md('- a\n1. b')).toBe('<ul><li>a</li></ul><ol><li>b</li></ol>')
  })

  it('does not take bold or a rule for a list marker', () => {
    expect(md('**Burger** is good')).toBe('<p><strong>Burger</strong> is good</p>')
    expect(md('-not a list')).toBe('<p>-not a list</p>')
    expect(md('*em* text')).toBe('<p><em>em</em> text</p>')
  })

  it('handles long and pathological input quickly', () => {
    const inputs = [
      '*a '.repeat(20_000),
      '['.repeat(20_000),
      `${'`'.repeat(5_000)}x${'`'.repeat(4_999)}`,
      '_'.repeat(30_000),
      `[a](${'('.repeat(10_000)}`,
      `${'** '.repeat(10_000)}**`,
    ]
    const started = performance.now()
    for (const input of inputs) md(input)
    expect(performance.now() - started).toBeLessThan(2000)
  })
})

describe('personaMarkdownToText', () => {
  it('drops formatting', () => {
    expect(text('Try the **Burger**, *really* ~~not~~ `now`')).toBe(
      'Try the Burger, really not now',
    )
    expect(text('***x*** and snake_case')).toBe('x and snake_case')
  })

  it('writes links as label (url) unless the label is the URL', () => {
    expect(text('[Burger](https://x.test/b)')).toBe('Burger (https://x.test/b)')
    expect(text('[https://x.test](https://x.test)')).toBe('https://x.test')
    expect(text('See https://x.test.')).toBe('See https://x.test.')
    expect(text('[Mail us](mailto:a@x.test) or [a@x.test](mailto:a@x.test)')).toBe(
      'Mail us (a@x.test) or a@x.test',
    )
  })

  it('keeps only the label of a refused link', () => {
    expect(text('[x](javascript:alert(1))')).toBe('x')
  })

  it('keeps lists, paragraphs and line breaks', () => {
    expect(text('Menu:\n- tea\n- coffee\n\n3. a\n4. b\n\nline\nbreak')).toBe(
      'Menu:\n\n- tea\n- coffee\n\n3. a\n4. b\n\nline\nbreak',
    )
  })

  it('does not escape HTML and keeps unknown syntax', () => {
    expect(text('# Hi <b> & "you"')).toBe('# Hi <b> & "you"')
    expect(text('\\*literal\\*')).toBe('*literal*')
  })
})
