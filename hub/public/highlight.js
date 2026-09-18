/*
 * zevet — syntax highlighting for the file-viewer pane.
 *
 * WHY THIS EXISTS AT ALL, rather than `npm i prismjs`:
 * zevet ships one self-contained HTML board with zero runtime dependencies.
 * That is a deliberate constraint, not an oversight — the board has to open
 * from a single file on a laptop with no network and no build step. So the
 * highlighter is a few hundred lines of regex we own, not a library we track.
 *
 * WHAT IT IS: a well-ordered tokenizer, one combined regex per language (per
 * "mode", where a language needs more than one — HTML's inside-a-tag vs text,
 * CSS's selector vs declaration block). It is NOT a parser and does not try to
 * be. Everything it gets wrong is a consequence of that, and every case I know
 * it gets wrong is named in a comment beside the rule that gets it wrong.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE SECURITY MODEL, which is the whole point of the file's structure
 * ────────────────────────────────────────────────────────────────────────────
 * The output of highlight() is inserted with innerHTML, and the input is source
 * code read off a teammate's disk. That input WILL contain `<script>`, because
 * people view HTML files. So the invariant is:
 *
 *   Every character of the input reaches the output only via escapeHtml().
 *
 * That is enforced structurally, not by discipline. The tokenizer never builds
 * output strings — it returns [start, end, kind] triples into the ORIGINAL
 * string. There is exactly one place (render()) that turns those into HTML, and
 * it does `escapeHtml(code.slice(start, end))` with no branches. A rule cannot
 * emit text; it can only label a range. So there is no code path by which a `<`
 * from the input becomes a `<` in the output, no matter how wrong a rule is or
 * how malformed the file is. The `kind` is also validated against /^[a-z]+$/
 * before it goes into the class attribute, since kinds are the only other thing
 * that reaches the output.
 *
 * The round-trip test in test/highlight.test.mjs is the proof of this: strip
 * every tag from the output, un-escape the entities, and you must get the input
 * back byte for byte. That single assertion catches dropped characters,
 * duplicated characters, reordered characters AND unescaped characters at once.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * TOTALITY: it must not throw and must not hang
 * ────────────────────────────────────────────────────────────────────────────
 * A file viewer that throws on a weird file is a file viewer that shows a blank
 * pane. So:
 *   - highlight() wraps everything in try/catch and falls back to the fully
 *     escaped plain text. A bug in a rule degrades colour, never content.
 *   - the scan loop is bounded by an explicit step cap, and every iteration is
 *     proven to advance `pos` by at least one character (the zero-width-match
 *     branch exists for exactly this). A rule that matches empty cannot spin.
 *   - every "consume until X" rule has a terminated form AND an unterminated
 *     fallback, so an unclosed string or block comment is coloured to the end
 *     of the line/file instead of falling through to something pathological.
 *   - all the repeat-groups are written unrolled and disjoint —
 *     `"[^"\\\n]*(?:\\[\s\S][^"\\\n]*)*"` rather than `"(?:[^"\\]|\\.)*"` — so
 *     there is no alternation ambiguity for the engine to backtrack over. This
 *     is what keeps a 200KB line of quotes linear instead of exponential.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.zevetHighlight = factory();
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  /* ───────────────────────────── escaping ───────────────────────────── */

  var ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

  /**
   * The one and only path from input text to output text.
   *
   * All five of & < > " ' are escaped, not just the three that close a tag:
   * the output is sometimes spliced into contexts we do not control (a title
   * attribute, a copy-to-clipboard buffer), and escaping the quotes costs
   * nothing. `'` uses the numeric `&#39;` because `&apos;` is not defined in
   * HTML4 and some consumers still choke on it.
   */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ESCAPES[c];
    });
  }

  /* ─────────────────────── language identification ──────────────────── */

  // ts/tsx map onto "js" on purpose: the token shapes are the same and the JS
  // keyword list below carries the TypeScript-only words. The cost is that
  // `type`, `string`, `number` etc. colour as keywords in plain .js files too.
  // That is the trade I picked — a false keyword is cosmetic, a missing one
  // looks broken in the language people actually read here (TS).
  var EXTENSIONS = {
    js: "js", jsx: "js", mjs: "js", cjs: "js", ts: "js", tsx: "js", mts: "js", cts: "js",
    json: "json", jsonc: "json",
    css: "css",
    html: "html", htm: "html",
    md: "md", markdown: "md",
    py: "py", pyi: "py",
    sh: "sh", bash: "sh", zsh: "sh",
    toml: "toml",
    yaml: "yaml", yml: "yaml",
    rs: "rs",
    go: "go"
  };

  /**
   * "src/hub/server.mjs" -> "js". Unknown, extensionless, or not-a-string -> "plain".
   *
   * Dotfiles (".gitignore", ".env") deliberately return "plain": the leading dot
   * is not an extension, and guessing a language from a bare name is how you end
   * up highlighting ".env" as TOML and leaking a false sense of structure.
   */
  function languageFor(filename) {
    if (typeof filename !== "string") return "plain";
    var base = filename.replace(/\\/g, "/").split("/").pop() || "";
    var dot = base.lastIndexOf(".");
    if (dot <= 0) return "plain"; // no dot, or a leading-dot filename
    return EXTENSIONS[base.slice(dot + 1).toLowerCase()] || "plain";
  }

  /* ──────────────────────────── the grammars ────────────────────────────
   *
   * A rule is { re, kind } plus an optional mode transition:
   *   push: "m"  – enter mode m, remembering the current one
   *   pop: true  – return to the mode we pushed from
   *   go: "m"    – switch to m without touching the stack
   *
   * Order inside a mode IS the grammar. The combined regex tries alternatives
   * left to right at each position, so "terminated string" must precede
   * "unterminated string", comments must precede the punctuation that would
   * otherwise eat their opening slash, and keywords must precede the
   * identifier rule that would otherwise swallow them.
   *
   * HARD CONSTRAINT on every `re` below: no capturing groups. Use (?:...).
   * The combiner wraps each rule in its own capturing group and identifies the
   * winner by group index; a stray group inside a rule would shift every index
   * after it. compileMode() asserts this at build time rather than letting it
   * corrupt colours silently.
   */

  // Shared string shapes, written unrolled so they cannot backtrack.
  var DQ = /"[^"\\\n]*(?:\\[\s\S][^"\\\n]*)*"/;
  var SQ = /'[^'\\\n]*(?:\\[\s\S][^'\\\n]*)*'/;
  var BACKTICK = /`[^`\\]*(?:\\[\s\S][^`\\]*)*`/;

  // The fallbacks. An unterminated quote runs to end of line, an unterminated
  // template/comment to end of file. Without these the opening delimiter would
  // fall through to the punctuation rule and the rest of the line would be
  // tokenised as code, which looks like the highlighter "lost" the file.
  var DQ_OPEN = /"[^\n]*/;
  var SQ_OPEN = /'[^\n]*/;

  var GRAMMARS = {};

  /* ── JavaScript / TypeScript ──────────────────────────────────────────
   *
   * KNOWN WRONG, and it is the ambiguity everyone hits: `/` is treated as
   * DIVISION, never as the start of a regex literal. Telling the two apart
   * requires knowing whether the previous token can end an expression, which
   * requires a parser. I erred on the division side because the failure is
   * quieter: a regex literal's contents get tokenised as ordinary code (ugly
   * but contained), whereas erring the other way would let a stray `/` in
   * `a / b ... c / d` swallow half a line into a fake string. `//` and `/*`
   * still win, because the comment rules come first — so a regex containing a
   * literal `//` (e.g. /http:\/\//) is the one place division-bias still loses
   * the rest of the line to a comment. Rare enough to accept, named here so
   * nobody re-derives it from scratch.
   *
   * Also known wrong: a template literal is one `str` token including its
   * ${...} expressions — no nesting.
   */
  GRAMMARS.js = {
    start: "main",
    modes: {
      main: [
        { re: /\/\/[^\n]*/, kind: "com" },
        { re: /\/\*[\s\S]*?\*\//, kind: "com" },
        { re: /\/\*[\s\S]*/, kind: "com" }, // unterminated block comment
        { re: BACKTICK, kind: "str" },
        { re: DQ, kind: "str" },
        { re: SQ, kind: "str" },
        { re: /`[\s\S]*/, kind: "str" }, // unterminated template: to EOF
        { re: DQ_OPEN, kind: "str" },
        { re: SQ_OPEN, kind: "str" },
        { re: /\b0[xX][0-9a-fA-F_]+n?\b|\b0[bB][01_]+n?\b|\b0[oO][0-7_]+n?\b/, kind: "num" },
        { re: /\b\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?n?\b|\.\d[\d_]*(?:[eE][+-]?\d+)?\b/, kind: "num" },
        {
          re: /\b(?:abstract|any|as|asserts|async|await|bigint|boolean|break|case|catch|class|const|constructor|continue|debugger|declare|default|delete|do|else|enum|export|extends|false|finally|for|from|function|get|global|if|implements|import|in|infer|instanceof|interface|is|keyof|let|namespace|never|new|null|number|object|of|override|package|private|protected|public|readonly|require|return|satisfies|set|static|string|super|switch|symbol|this|throw|true|try|type|typeof|undefined|unique|unknown|var|void|while|with|yield)\b/,
          kind: "kw"
        },
        { re: /[A-Za-z_$][\w$]*(?=\s*\()/, kind: "fn" },
        // Identifiers are consumed WHOLE as plain, deliberately. Without this,
        // the scanner would re-try every rule at every position inside a name
        // and `$const` or `_if` could match the keyword rule on a `\b` that
        // sits between `$` and a letter.
        { re: /[A-Za-z_$][\w$]*/, kind: "plain" },
        { re: /[{}()[\];,.:?!<>=+\-*/%&|^~]+/, kind: "punc" }
      ]
    }
  };

  /* ── JSON ─────────────────────────────────────────────────────────────
   * A key is a string followed by a colon; that lookahead is the entire
   * difference between `attr` and `str` here, and it is enough because JSON
   * has no other place a string can precede a colon.
   */
  GRAMMARS.json = {
    start: "main",
    modes: {
      main: [
        { re: /"[^"\\\n]*(?:\\[\s\S][^"\\\n]*)*"(?=\s*:)/, kind: "attr" },
        { re: DQ, kind: "str" },
        { re: DQ_OPEN, kind: "str" },
        { re: /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/, kind: "num" },
        { re: /\b(?:true|false|null)\b/, kind: "kw" },
        // JSON has no comments, but .jsonc and hand-edited config files do, and
        // showing a `//` line as a comment beats showing it as broken syntax.
        { re: /\/\/[^\n]*/, kind: "com" },
        { re: /\/\*[\s\S]*?\*\/|\/\*[\s\S]*/, kind: "com" },
        { re: /[{}[\],:]/, kind: "punc" },
        { re: /[A-Za-z_][\w$]*/, kind: "plain" }
      ]
    }
  };

  /* ── CSS ──────────────────────────────────────────────────────────────
   * Two modes, because `#fff` and `:hover` mean opposite things either side of
   * a brace. In selector position `#x` is an id and `:x` is a pseudo-class; in
   * declaration position `#fff` is a colour and `:` is the name/value
   * separator. A single mode gets one of those two wrong always. Nested blocks
   * (@media, CSS nesting) work because the brace rules push/pop a stack.
   *
   * KNOWN WRONG: an id selector made only of hex letters (#abc, #def) reads as
   * a colour, because at selector depth... actually no — at selector depth the
   * colour rule is not present at all, so #abc is an id there and a colour
   * inside a block. The residual wrongness is a nested rule's selector (.a in
   * `@media { .a {} }`), which is scanned in block mode and comes out plain.
   */
  GRAMMARS.css = {
    start: "sel",
    modes: {
      sel: [
        { re: /\/\*[\s\S]*?\*\/|\/\*[\s\S]*/, kind: "com" },
        { re: DQ, kind: "str" },
        { re: SQ, kind: "str" },
        { re: DQ_OPEN, kind: "str" },
        { re: /\{/, kind: "punc", push: "blk" },
        { re: /@[-\w]+/, kind: "kw" },
        { re: /\[[^\]\n]*\]/, kind: "attr" }, // [type="text"]
        { re: /[-a-zA-Z_][-\w]*(?=[ \t]*:)/, kind: "attr" }, // @media (min-width: …)
        { re: /\.[-\w]+/, kind: "tag" },
        { re: /#[-\w]+/, kind: "tag" },
        { re: /::?[a-zA-Z][-\w]*/, kind: "tag" }, // :hover, ::before
        { re: /\d+(?:\.\d+)?(?:%|[a-zA-Z]{1,5})?/, kind: "num" },
        { re: /[a-zA-Z][-\w]*/, kind: "tag" }, // element selectors
        { re: /[,>+~*():;]/, kind: "punc" },
        { re: /\}/, kind: "punc", pop: true } // stray close: recover, don't wedge
      ],
      blk: [
        { re: /\/\*[\s\S]*?\*\/|\/\*[\s\S]*/, kind: "com" },
        { re: DQ, kind: "str" },
        { re: SQ, kind: "str" },
        { re: DQ_OPEN, kind: "str" },
        { re: /\}/, kind: "punc", pop: true },
        { re: /\{/, kind: "punc", push: "blk" },
        { re: /!important\b/, kind: "kw" },
        { re: /@[-\w]+/, kind: "kw" },
        { re: /#[0-9a-fA-F]{3,8}\b/, kind: "num" },
        { re: /--[-\w]+/, kind: "attr" }, // custom properties
        { re: /[-a-zA-Z_][-\w]*(?=[ \t]*:)/, kind: "attr" },
        { re: /[-a-zA-Z_][-\w]*(?=\()/, kind: "fn" }, // rgb(, var(, calc(
        { re: /[+-]?(?:\d+\.?\d*|\.\d+)(?:%|[a-zA-Z]{1,5})?/, kind: "num" },
        { re: /[a-zA-Z][-\w]*/, kind: "plain" },
        { re: /[;:,()[\]/*]/, kind: "punc" }
      ]
    }
  };

  /* ── HTML ─────────────────────────────────────────────────────────────
   * Also two modes: text vs inside-a-tag. Attribute names only mean anything
   * between `<` and `>`, and text content must never be scanned for them.
   *
   * DELIBERATE NON-FEATURE: the contents of <script> and <style> are NOT
   * highlighted as JS/CSS. They are text, and `</script>` inside them closes
   * the element as far as this tokeniser is concerned. Since everything is
   * escaped on the way out, the worst case is uncoloured JavaScript — and it
   * keeps the most dangerous input (a page with an inline script) on the
   * simplest path.
   */
  GRAMMARS.html = {
    start: "text",
    modes: {
      text: [
        { re: /<!--[\s\S]*?-->/, kind: "com" },
        { re: /<!--[\s\S]*/, kind: "com" },
        { re: /<![^>\n]*>?/, kind: "kw" }, // <!DOCTYPE html>
        { re: /<\/?[a-zA-Z][-\w:.]*/, kind: "tag", push: "intag" },
        { re: /&#?[a-zA-Z0-9]+;/, kind: "num" }, // entities in the SOURCE text
        { re: /</, kind: "punc" } // a bare < in prose
      ],
      intag: [
        { re: DQ, kind: "str" },
        { re: SQ, kind: "str" },
        { re: /"[^">]*|'[^'>]*/, kind: "str" }, // unterminated: stop at the tag end
        { re: /\/?>/, kind: "tag", pop: true },
        { re: /=/, kind: "punc" },
        { re: /[^\s=>/"']+/, kind: "attr" },
        { re: /\//, kind: "punc" }
      ]
    }
  };

  /* ── Markdown ─────────────────────────────────────────────────────────
   * Line-anchored rules, so the combined regex is compiled with the `m` flag
   * (it always is — see compileMode).
   *
   * DELIBERATE OMISSION: _underscore italics_ are not highlighted. snake_case
   * identifiers are everywhere in the prose this board shows, and
   * `foo_bar_baz` would light up its middle as emphasis. __Double__ underscore
   * is unambiguous enough to keep. Asterisk emphasis is kept in both forms.
   * A link is one `str` token, text and URL together — splitting them needs a
   * capture group, which the combiner forbids.
   */
  GRAMMARS.md = {
    start: "main",
    modes: {
      main: [
        { re: /^[ \t]*(?:```|~~~)[\s\S]*?^[ \t]*(?:```|~~~)[^\n]*/, kind: "str" },
        { re: /^[ \t]*(?:```|~~~)[\s\S]*/, kind: "str" }, // unterminated fence
        { re: /^[ \t]*#{1,6}[^\n]*/, kind: "kw" },
        { re: /^[ \t]*(?:-{3,}|\*{3,}|_{3,}|={2,})[ \t]*$/, kind: "punc" },
        { re: /^[ \t]*>+/, kind: "com" },
        { re: /^[ \t]*[-*+](?=[ \t])/, kind: "punc" },
        { re: /^[ \t]*\d+\.(?=[ \t])/, kind: "num" },
        { re: /<https?:[^>\s]*>/, kind: "str" },
        { re: /<\/?[a-zA-Z][-\w]*[^>\n]*>/, kind: "tag" },
        { re: /`+[^`\n]*`+/, kind: "str" },
        { re: /!?\[[^\]\n]*\]\([^)\n]*\)/, kind: "str" },
        { re: /\*\*[^*\n]+\*\*|__[^_\n]+__/, kind: "attr" },
        { re: /\*[^*\n]+\*/, kind: "attr" },
        { re: /[A-Za-z0-9]+/, kind: "plain" } // consume words whole: fewer spans
      ]
    }
  };

  /* ── Python ───────────────────────────────────────────────────────────
   * Triple-quoted strings must precede single-quoted ones or `"""x"""` reads as
   * an empty string followed by an identifier. String prefixes (f, r, b, rb…)
   * are part of the string token. An f-string's {expressions} are not
   * tokenised — same call as JS template literals.
   */
  GRAMMARS.py = {
    start: "main",
    modes: {
      main: [
        { re: /#[^\n]*/, kind: "com" },
        { re: /[rRbBuUfF]{0,2}"""[\s\S]*?"""|[rRbBuUfF]{0,2}'''[\s\S]*?'''/, kind: "str" },
        { re: /[rRbBuUfF]{0,2}(?:"""|''')[\s\S]*/, kind: "str" }, // unterminated
        { re: /[rRbBuUfF]{0,2}"[^"\\\n]*(?:\\[\s\S][^"\\\n]*)*"/, kind: "str" },
        { re: /[rRbBuUfF]{0,2}'[^'\\\n]*(?:\\[\s\S][^'\\\n]*)*'/, kind: "str" },
        { re: DQ_OPEN, kind: "str" },
        { re: SQ_OPEN, kind: "str" },
        { re: /^[ \t]*@[A-Za-z_][\w.]*/, kind: "attr" }, // decorators
        {
          re: /\b(?:False|None|True|and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|match|nonlocal|not|or|pass|raise|return|self|try|while|with|yield)\b/,
          kind: "kw"
          // `self` is not a Python keyword. It is in this list because in a
          // file viewer the useful thing is "this word is structural", and
          // every reader of Python code reads self that way.
        },
        { re: /\b0[xX][0-9a-fA-F_]+\b|\b0[bB][01_]+\b|\b0[oO][0-7_]+\b/, kind: "num" },
        { re: /\b\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?[jJ]?\b|\.\d[\d_]*\b/, kind: "num" },
        { re: /[A-Za-z_]\w*(?=\s*\()/, kind: "fn" },
        { re: /[A-Za-z_]\w*/, kind: "plain" },
        { re: /[{}()[\];,.:?!<>=+\-*/%&|^~@]+/, kind: "punc" }
      ]
    }
  };

  /* ── Shell ────────────────────────────────────────────────────────────
   * KNOWN WRONG: heredocs are not understood. `<<EOF … EOF` is tokenised as
   * ordinary shell, so a heredoc full of prose gets speckled. Doing it right
   * needs a back-reference to the delimiter, which needs a capture group,
   * which the combiner forbids — and getting it half-right (guessing EOF)
   * would be worse than a known limitation.
   *
   * Single quotes in shell take no escapes at all, so `'…'` is matched with a
   * dumber rule than the shared SQ: inside single quotes a backslash is just a
   * backslash.
   */
  var SH_KEYWORDS = "if|then|elif|else|fi|for|while|until|do|done|case|esac|in|function|return|local|export|readonly|declare|unset|shift|source|eval|exec|trap|set|break|continue|select|time";
  GRAMMARS.sh = {
    start: "main",
    modes: {
      main: [
        { re: /^#![^\n]*/, kind: "com" }, // shebang
        { re: /(?:^|[ \t])#[^\n]*/, kind: "com" },
        { re: /'[^'\n]*'/, kind: "str" },
        { re: DQ, kind: "str" },
        { re: DQ_OPEN, kind: "str" },
        { re: SQ_OPEN, kind: "str" },
        { re: /\$\{[^}\n]*\}|\$[A-Za-z_]\w*|\$[@*#?$!0-9-]/, kind: "attr" },
        { re: new RegExp("\\b(?:" + SH_KEYWORDS + ")\\b"), kind: "kw" },
        { re: /[A-Za-z_]\w*(?=\s*\(\s*\))/, kind: "fn" }, // name() { … }
        // The first word of a command line is the command. The rule eats the
        // indentation too — invisible, and it keeps the anchor honest. The
        // negative lookahead stops `  if` being called a command name.
        {
          re: new RegExp("^[ \\t]*(?!(?:" + SH_KEYWORDS + ")\\b)[a-zA-Z_][-\\w]*(?=[ \\t]|$)", ""),
          kind: "fn"
        },
        { re: /(?:^|[ \t])--?[A-Za-z][-\w]*/, kind: "attr" }, // flags
        { re: /\b\d+\b/, kind: "num" },
        { re: /[A-Za-z_][-\w]*/, kind: "plain" },
        { re: /[{}()[\];,.:?!<>=+\-*/%&|^~]+/, kind: "punc" }
      ]
    }
  };

  /* ── TOML ─────────────────────────────────────────────────────────────
   * A `#` is only a comment when it starts a line or follows whitespace; the
   * preceding space is swallowed into the comment token, which is invisible and
   * saves a lookbehind. Dates are matched before numbers or `2026-09-18` reads
   * as three numbers and two minus signs.
   */
  GRAMMARS.toml = {
    start: "main",
    modes: {
      main: [
        { re: /(?:^|[ \t])#[^\n]*/, kind: "com" },
        { re: /^[ \t]*\[\[?[^\]\n]*\]\]?/, kind: "tag" },
        { re: /^[ \t]*[A-Za-z0-9_\-."']+(?=[ \t]*=)/, kind: "attr" },
        { re: /"""[\s\S]*?"""|'''[\s\S]*?'''/, kind: "str" },
        { re: /(?:"""|''')[\s\S]*/, kind: "str" },
        { re: DQ, kind: "str" },
        { re: /'[^'\n]*'/, kind: "str" },
        { re: DQ_OPEN, kind: "str" },
        { re: /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?/, kind: "num" },
        { re: /\b(?:true|false)\b/, kind: "kw" },
        { re: /[+-]?(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?|inf|nan)\b/, kind: "num" },
        { re: /[A-Za-z_][\w-]*/, kind: "plain" },
        { re: /[=[\]{},.]/, kind: "punc" }
      ]
    }
  };

  /* ── YAML ─────────────────────────────────────────────────────────────
   * The key rule is the load-bearing one and it is a lookahead, not a parse:
   * "start of line, optional list dashes, a scalar, then a colon followed by
   * space or end of line". That last clause is what keeps `http://x` from
   * being read as the key `http`.
   */
  GRAMMARS.yaml = {
    start: "main",
    modes: {
      main: [
        { re: /(?:^|[ \t])#[^\n]*/, kind: "com" },
        { re: /^(?:---|\.\.\.)[ \t]*$/, kind: "punc" },
        { re: /^[ \t]*(?:-[ \t]+)*(?:"[^"\n]*"|'[^'\n]*'|[A-Za-z_][\w.\- ]*?)(?=[ \t]*:(?:[ \t]|$))/, kind: "attr" },
        { re: DQ, kind: "str" },
        { re: /'[^'\n]*'/, kind: "str" },
        { re: DQ_OPEN, kind: "str" },
        { re: /[&*][A-Za-z0-9_-]+/, kind: "attr" }, // anchors and aliases
        { re: /!!?[A-Za-z0-9_\-:/.]*/, kind: "kw" }, // !!str, !Ref
        { re: /\b(?:true|false|null|True|False|Null|TRUE|FALSE|NULL|yes|no|on|off|Yes|No|On|Off)\b|~/, kind: "kw" },
        { re: /[+-]?(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/, kind: "num" },
        { re: /[A-Za-z_][\w.-]*/, kind: "plain" },
        { re: /[:,[\]{}>|?-]/, kind: "punc" }
      ]
    }
  };

  /* ── Rust ─────────────────────────────────────────────────────────────
   * `'` is the one genuinely ambiguous character: 'a' is a char literal and 'a
   * is a lifetime. Char literals are matched first (they are the more specific
   * shape — they close), so `'a'` is a string and `'a` is a lifetime. That is
   * the correct precedence and it costs nothing.
   *
   * KNOWN WRONG: raw strings ignore the hash count — r#"…"# is terminated by
   * the first `"#` regardless of how many hashes opened it, because counting
   * needs a back-reference. And nested block comments — legal in Rust,
   * unlike C — end at the first close marker.
   */
  GRAMMARS.rs = {
    start: "main",
    modes: {
      main: [
        { re: /\/\/[^\n]*/, kind: "com" },
        { re: /\/\*[\s\S]*?\*\/|\/\*[\s\S]*/, kind: "com" },
        { re: /#!?\[[^\]\n]*\]/, kind: "attr" }, // #[derive(…)]
        { re: /r#+"[\s\S]*?"#+|r"[^"\n]*"/, kind: "str" },
        { re: /b?"[^"\\\n]*(?:\\[\s\S][^"\\\n]*)*"/, kind: "str" },
        { re: DQ_OPEN, kind: "str" },
        { re: /b?'(?:\\[\s\S]|[^'\\\n])'/, kind: "str" }, // char literal
        { re: /'[A-Za-z_]\w*/, kind: "attr" }, // lifetime
        {
          re: /\b(?:as|async|await|break|const|continue|crate|dyn|else|enum|extern|false|fn|for|if|impl|in|let|loop|match|mod|move|mut|pub|ref|return|self|Self|static|struct|super|trait|true|type|unsafe|use|where|while|yield)\b/,
          kind: "kw"
        },
        { re: /\b\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?(?:[iuf](?:8|16|32|64|128|size))?\b|\b0[xXbBoO][0-9a-fA-F_]+\b/, kind: "num" },
        { re: /[A-Za-z_]\w*!/, kind: "fn" }, // macro invocation
        { re: /[A-Za-z_]\w*(?=\s*[(<])/, kind: "fn" },
        { re: /\b[A-Z][A-Za-z0-9_]*\b/, kind: "tag" }, // types, by convention
        { re: /[A-Za-z_]\w*/, kind: "plain" },
        { re: /[{}()[\];,.:?!<>=+\-*/%&|^~#@]+/, kind: "punc" }
      ]
    }
  };

  /* ── Go ───────────────────────────────────────────────────────────────
   * Backtick raw strings can contain newlines and take no escapes, so they get
   * their own rule ahead of the interpreted-string one.
   */
  GRAMMARS.go = {
    start: "main",
    modes: {
      main: [
        { re: /\/\/[^\n]*/, kind: "com" },
        { re: /\/\*[\s\S]*?\*\/|\/\*[\s\S]*/, kind: "com" },
        { re: /`[^`]*`|`[\s\S]*/, kind: "str" },
        { re: DQ, kind: "str" },
        { re: /'(?:\\[\s\S]|[^'\\\n])'/, kind: "str" },
        { re: DQ_OPEN, kind: "str" },
        {
          re: /\b(?:append|bool|break|byte|cap|case|chan|close|complex|const|continue|copy|default|defer|delete|else|error|fallthrough|false|float32|float64|for|func|go|goto|if|import|int|int16|int32|int64|int8|interface|iota|len|make|map|new|nil|package|panic|print|println|range|recover|return|rune|select|string|struct|switch|true|type|uint|uint16|uint32|uint64|uint8|uintptr|var)\b/,
          kind: "kw"
        },
        { re: /\b0[xXbBoO][0-9a-fA-F_]+\b|\b\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?i?\b/, kind: "num" },
        { re: /[A-Za-z_]\w*(?=\s*\()/, kind: "fn" },
        { re: /[A-Za-z_]\w*/, kind: "plain" },
        { re: /[{}()[\];,.:?!<>=+\-*/%&|^~]+/, kind: "punc" }
      ]
    }
  };

  // "plain" is a real entry, not a missing one: an unknown file type still has
  // to render, it just renders as one span.
  GRAMMARS.plain = { start: "main", modes: { main: [] } };

  /* ──────────────────────────── the scanner ─────────────────────────── */

  var compiledCache = {}; // "lang:mode" -> RegExp

  /**
   * Builds one alternation regex for a mode, each rule in its own capture group.
   *
   * Flags are always "gm": `g` because the scan drives lastIndex by hand, `m`
   * because several grammars anchor rules to line starts. Compiling with `m`
   * everywhere is safe — no rule below uses `^`/`$` to mean file boundaries.
   *
   * The capture-group assertion is not paranoia about the future; it is the
   * only way a stray `(` in a rule can be caught, since the symptom otherwise
   * is "some other language's colours quietly shift by one kind".
   */
  function compileMode(lang, mode) {
    var key = lang + ":" + mode;
    if (compiledCache[key]) return compiledCache[key];
    var rules = GRAMMARS[lang].modes[mode];
    var parts = [];
    for (var i = 0; i < rules.length; i++) {
      var src = rules[i].re.source;
      // Count capture groups by making the pattern match the empty string: the
      // length of the result array is 1 + the number of groups.
      var groups = new RegExp(src + "|").exec("").length - 1;
      if (groups !== 0) {
        throw new Error("rule " + i + " of " + key + " has " + groups + " capture group(s); use (?:…)");
      }
      parts.push("(" + src + ")");
    }
    var re = new RegExp(parts.join("|"), "gm");
    compiledCache[key] = re;
    return re;
  }

  /**
   * Returns [start, end, kind] triples that tile the input exactly: contiguous,
   * non-overlapping, covering [0, code.length). The renderer depends on that
   * tiling for the round-trip property, so every branch here either advances
   * `pos` to the end of what it emitted or emits the remainder and stops.
   */
  function tokenize(code, lang) {
    var grammar = GRAMMARS[lang] || GRAMMARS.plain;
    var len = code.length;
    var out = [];
    var pos = 0;
    var mode = grammar.start;
    var stack = [];
    var steps = 0;
    // Every iteration consumes at least one character, so len+2 iterations is
    // already impossible. The 4x is slack for mode churn; the point of the cap
    // is that a future rule which somehow fails to advance ends the loop
    // instead of freezing the tab.
    var maxSteps = len * 4 + 1024;

    if (grammar.modes[mode].length === 0) {
      if (len > 0) out.push([0, len, "plain"]);
      return out;
    }

    while (pos < len) {
      if (++steps > maxSteps) {
        out.push([pos, len, "plain"]); // bail out honestly: uncoloured, complete
        return out;
      }
      var rules = grammar.modes[mode];
      var re = compileMode(lang, mode);
      re.lastIndex = pos;
      var m = re.exec(code);
      if (m === null) {
        out.push([pos, len, "plain"]);
        return out;
      }
      if (m.index > pos) out.push([pos, m.index, "plain"]); // the gap between matches
      if (m[0].length === 0) {
        // A rule matched empty. Emit one character so the loop cannot stall,
        // and do not take the rule's mode transition — it did not consume
        // anything, so acting on it could ping-pong forever.
        out.push([m.index, m.index + 1, "plain"]);
        pos = m.index + 1;
        continue;
      }
      var which = -1;
      for (var i = 1; i < m.length; i++) {
        if (m[i] !== undefined) {
          which = i - 1;
          break;
        }
      }
      var rule = which >= 0 ? rules[which] : null;
      var end = m.index + m[0].length;
      out.push([m.index, end, (rule && rule.kind) || "plain"]);
      pos = end;
      if (rule) {
        if (rule.push) {
          if (stack.length < 64) stack.push(mode); // bounded: `{{{{{…` is input too
          mode = rule.push;
        } else if (rule.pop) {
          mode = stack.length ? stack.pop() : grammar.start;
        } else if (rule.go) {
          mode = rule.go;
        }
      }
    }
    return out;
  }

  var SAFE_KIND = /^[a-z]+$/;

  /**
   * The only place input text becomes output text.
   *
   * Two rules, both absolute: the text is escapeHtml(slice) with no branch, and
   * the kind is checked against a whitelist pattern before it lands in the
   * class attribute. Keep it that way — every property this module claims is a
   * property of these six lines.
   */
  function render(code, tokens) {
    var parts = [];
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      var kind = SAFE_KIND.test(t[2]) ? t[2] : "plain";
      parts.push('<span class="tok-' + kind + '">' + escapeHtml(code.slice(t[0], t[1])) + "</span>");
    }
    return parts.join("");
  }

  // Past this, tokenising is not worth the pause: the pane is showing a file
  // nobody is reading line by line anyway. It renders, escaped, uncoloured.
  // (200KB — the size the tests exercise — is two orders of magnitude under it.)
  var MAX_INPUT = 1000000;

  /**
   * highlight(code, lang) -> HTML string. Total: for any input, returns a
   * string. If anything at all goes wrong internally, the fallback is the
   * fully escaped source in a single plain span — the file still reads, it just
   * loses its colours. A viewer that shows the file uncoloured is a bug; a
   * viewer that shows an exception is not a viewer.
   */
  function highlight(code, lang) {
    var text;
    try {
      text = typeof code === "string" ? code : code === null || code === undefined ? "" : String(code);
    } catch (e) {
      return ""; // a toString() that throws is the caller's problem, not the pane's
    }
    if (text.length === 0) return "";
    if (text.length > MAX_INPUT) return '<span class="tok-plain">' + escapeHtml(text) + "</span>";
    try {
      var id = typeof lang === "string" && GRAMMARS[lang] ? lang : "plain";
      return render(text, tokenize(text, id));
    } catch (e) {
      // Deliberately swallowed, and deliberately narrow: the alternative is a
      // blank pane. It is not silent — the reason is logged where a browser
      // console will show it, and the degraded state (uncoloured text) is
      // visible to the person looking at the file.
      if (typeof console !== "undefined" && console && console.warn) {
        console.warn("zevetHighlight: falling back to plain text for lang=" + lang, e);
      }
      return '<span class="tok-plain">' + escapeHtml(text) + "</span>";
    }
  }

  return { highlight: highlight, languageFor: languageFor };
});
