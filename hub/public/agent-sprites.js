/* zevet agent sprites — the little figures that ride the line an agent is editing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THESE ARE FOR
 *
 * The board already gives every teammate a colour (--who-0..n). One figure per
 * active agent, drawn in its owner's colour and carrying the tool its agent is
 * currently using, is the whole idea: you glance at a file and you can see that
 * Kai's agent is reading at line 40 while yours is writing at line 12.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY PIXEL ART DRAWN AS RECTANGLES, and not an image
 *
 *   • It takes the teammate's colour. Every body pixel is `currentColor`, so one
 *     sprite serves every participant and the colour comes from the CSS that
 *     already assigns it. A PNG per person per tool is a combinatorial mess and
 *     a second place for the palette to drift.
 *   • The hub serves static files with no build step and no image pipeline.
 *   • At the size these are drawn a vector illustration turns to mud and a
 *     bitmap needs @2x. A pixel grid is crisp at any integer scale by
 *     construction, and `shape-rendering: crispEdges` keeps it that way.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DRAWING IS FROM A REFERENCE ANDREW SUPPLIED (2026-09-18): a round dark
 * body, two square light eyes, two stubby legs, and an OUTLINED tool held out
 * to the right. The first version here had no legs and filled tools; the legs
 * are most of the character and the outlines are why a tool reads as a tool at
 * this size rather than as a blob. The tool vocabulary is his too — book,
 * document, wrench, speech bubble, angle brackets — and it turned out to map
 * better onto what zevet actually receives than the set it replaced, because
 * zevet has a `prompt` event and now has a speech bubble to draw for it.
 *
 * ⚠️ THESE ARE ORIGINAL. They follow the reference's spirit and are drawn from
 * scratch here; they are not a rendering of Anthropic's Claude mascot or anyone
 * else's character. zevet watches Claude Code AND Codex — a board that drew one
 * vendor's character for both would be wrong twice over, once about whose agent
 * it is and once about whose artwork it is.
 *
 * ⚠️ NOT VERIFIED: nobody has seen these on a real board next to real events.
 * The grids are eyeballed against a render, and that is all.
 */
(function (global) {
  "use strict";

  /**
   * The alphabet of the grids below.
   *
   *   #  body      — currentColor, i.e. the teammate's assigned colour
   *   o  eye       — a hole, painted in the surface colour behind the sprite so
   *                  it reads as a cut-out rather than a light dot. Taken from
   *                  --zevet-sprite-eye, which the board sets to its own
   *                  background; a sprite over a highlighted line therefore
   *                  keeps its eyes the colour of that line, not the page.
   *   t  tool      — currentColor at reduced opacity. Andrew asked for the
   *                  agent's colour to match its teammate's, so the tool stays
   *                  in the same hue rather than introducing a second one. The
   *                  reference draws tools in grey; this is the same idea with
   *                  the hue kept, which matters more here than there because
   *                  here the hue is carrying identity.
   *   .  nothing
   */
  var BODY = "#";
  var EYE = "o";
  var TOOL = "t";

  var W = 22;
  var H = 10;
  var BODY_COLS = 12;

  /**
   * The figure: 12 columns of body and legs, identical in every sprite.
   *
   * It is the constant on purpose. The figure is the PERSON; the tool is what
   * their agent is doing this second. If a figure changed between tools, a
   * board with four people on it would look like eight.
   */
  var FIGURE = [
    // Eight rows of body, then two of legs. The body is a rounded OVAL -- the
    // widths step 8, 10, 12, 12, 12, 12, 10, 8. An earlier version stepped
    // 6, 10, 12 and pinched the head at both ends, which at a glance read as a
    // creature with ears. Rounder is not a nicety here; it is what makes the
    // two light squares read as eyes in a face rather than as gaps in a shape.
    "..########..",
    ".##########.",
    "############",
    // And the eyes sit a third of the way down, not against the top edge, for
    // the same reason.
    "###oo##oo###",
    "###oo##oo###",
    "############",
    ".##########.",
    "..########..",
    "...#....#...",
    "..##....##..",
  ];

  /**
   * The right-hand 10 columns, one set per tool, drawn as OUTLINES.
   *
   * Outlines rather than filled shapes because at this size a filled rectangle
   * is a rectangle whatever it is meant to be — the first version's "page" and
   * "eraser" were indistinguishable, which is how the reference's approach
   * proved itself.
   */
  var TOOLS = {
    /** Magnifier: reading around, searching, globbing. */
    lens: [
      "...tttt...",
      "..t....t..",
      ".t......t.",
      ".t......t.",
      "..t....t..",
      "...tttt...",
      "..tt......",
      ".tt.......",
      "tt........",
      "..........",
    ],
    /** Pencil, tip down toward the hand. Editing existing text. */
    pencil: [
      "........tt",
      ".......tt.",
      "......tt..",
      ".....tt...",
      "....tt....",
      "...tt.....",
      "..tt......",
      ".tt.......",
      "t.........",
      "..........",
    ],
    /** An eraser, held at an angle. Removing. Nothing on the wire says
     *  "delete", so this one is only ever chosen by an explicit hint.
     *
     *  ⚠️ IT IS A PARALLELOGRAM ON PURPOSE. It was an upright rectangle with a
     *  band across it, and at board size that is the same handful of pixels as
     *  `doc` -- two rectangles side by side in a roster told you nothing. The
     *  slant is the only thing distinguishing them at 20px, so do not
     *  straighten it. */
    eraser: [
      "..........",
      ".....tttt.",
      "....t...t.",
      "...t...t..",
      "..t...t...",
      "..tttt....",
      "..........",
      "..........",
      "..........",
      "..........",
    ],
    /** An open book. Reading a file properly, as opposed to searching. */
    book: [
      "..........",
      ".ttttttttt",
      ".t...t...t",
      ".t...t...t",
      ".t...t...t",
      ".t...t...t",
      ".ttttttttt",
      "..........",
      "..........",
      "..........",
    ],
    /** A sheet with ruled lines. Writing a new file. */
    doc: [
      "..tttttt..",
      "..t....t..",
      "..t.tt.t..",
      "..t....t..",
      "..t.tt.t..",
      "..t....t..",
      "..tttttt..",
      "..........",
      "..........",
      "..........",
    ],
    /** A spanner. Running a command. */
    wrench: [
      "...t..t...",
      "...t..t...",
      "...tttt...",
      "....tt....",
      "....tt....",
      "....tt....",
      "...tttt...",
      "..........",
      "..........",
      "..........",
    ],
    /** A speech bubble. zevet's `prompt` event — somebody just asked for
     *  something, and this is the only sprite that is about a person rather
     *  than about a tool. */
    bubble: [
      "tttttttttt",
      "t........t",
      "t.t.t.t..t",
      "t........t",
      "tttttttttt",
      "..tt......",
      ".tt.......",
      "..........",
      "..........",
      "..........",
    ],
    /** Angle brackets. A generic "working on code" with no better answer. */
    code: [
      "..........",
      "...t...t..",
      "..t.....t.",
      ".t.......t",
      "..t.....t.",
      "...t...t..",
      "..........",
      "..........",
      "..........",
      "..........",
    ],
    /** Empty-handed. Idle, turn over, or a tool we have no drawing for. */
    none: [
      "..........",
      "..........",
      "..........",
      "..........",
      "..........",
      "..........",
      "..........",
      "..........",
      "..........",
      "..........",
    ],
  };

  /**
   * Tool name → what the figure is holding.
   *
   * ⚠️ THE KEYS ARE ALREADY NORMALISED — lower case, with spaces, underscores
   * and hyphens removed — because that is what `toolKind` looks up. Writing one
   * the way the wire spells it (`apply_patch`) makes the entry unreachable and
   * the sprite silently empty-handed. That exact bug was caught by the test
   * below rather than by reading.
   *
   * ⚠️ THE NAMES ARE REAL ONES OFF THE WIRE. `client/hook.mjs` forwards
   * `p.tool_name` verbatim from Claude Code and Codex, so these are matched
   * against whatever those two actually send. A name nobody has seen falls
   * through to `none`, which is correct rather than a gap: a figure standing
   * there empty-handed is honest about not knowing, and an invented icon is not.
   */
  var BY_TOOL = {
    read: "book",
    notebookread: "book",
    grep: "lens",
    glob: "lens",
    search: "lens",
    websearch: "lens",
    webfetch: "lens",
    ls: "lens",
    edit: "pencil",
    multiedit: "pencil",
    notebookedit: "pencil",
    applypatch: "pencil",
    strreplaceeditor: "pencil",
    update: "pencil",
    write: "doc",
    createfile: "doc",
    bash: "wrench",
    shell: "wrench",
    run: "wrench",
    powershell: "wrench",
    exec: "wrench",
    task: "code",
    agent: "code",
  };

  /**
   * zevet's own event kinds, which are not tools at all. `prompt` is the one
   * that matters: it is a person typing, and it gets the speech bubble.
   */
  var BY_KIND = {
    prompt: "bubble",
    turn_end: "none",
  };

  /**
   * A delete is not its own tool anywhere — it arrives as an Edit, or as a Bash
   * `rm`. The eraser is therefore chosen by the CALLER, which can see that a
   * change removed lines, rather than by the tool name, which cannot. Hence the
   * hint, and hence the hint winning.
   */
  function toolKind(toolName, hint, kind) {
    if (hint && TOOLS[hint]) return hint;
    if (kind && BY_KIND[kind]) return BY_KIND[kind];
    if (!toolName) return kind && BY_KIND[kind] ? BY_KIND[kind] : "none";
    return BY_TOOL[String(toolName).toLowerCase().replace(/[\s_-]/g, "")] || "none";
  }

  /** Stitch the fixed figure and a tool column into one 22x10 grid. */
  function gridFor(kind) {
    var tool = TOOLS[kind] || TOOLS.none;
    var rows = [];
    for (var y = 0; y < H; y++) rows.push(FIGURE[y] + tool[y]);
    return rows;
  }

  /**
   * Runs of identical pixels on a row become ONE rect rather than one rect per
   * pixel. A 22x10 sprite is 220 cells; drawn naively that is 220 nodes per
   * figure, and a busy board can hold a dozen figures that move every time an
   * event lands. Run-length encoding takes a typical sprite to about 40 rects
   * and costs six lines.
   */
  function rectsFor(rows, ch) {
    var out = "";
    for (var y = 0; y < rows.length; y++) {
      var row = rows[y];
      var x = 0;
      while (x < row.length) {
        if (row[x] !== ch) {
          x++;
          continue;
        }
        var start = x;
        while (x < row.length && row[x] === ch) x++;
        out += '<rect x="' + start + '" y="' + y + '" width="' + (x - start) + '" height="1"/>';
      }
    }
    return out;
  }

  /**
   * An SVG string for one agent.
   *
   *   spriteFor({ tool: "Edit" })                  a figure with a pencil
   *   spriteFor({ kind: "prompt" })                a figure with a speech bubble
   *   spriteFor({ tool: "Edit", hint: "eraser" })  the caller saw lines go
   *
   * The caller sets the colour by setting `color` on the element or an
   * ancestor; everything here is currentColor. `aria-hidden` because the board
   * says who is doing what in text as well, and a screen reader should not have
   * to hear about a drawing of a pencil.
   */
  function spriteFor(opts) {
    var o = opts || {};
    var kind = toolKind(o.tool, o.hint, o.kind);
    var rows = gridFor(kind);
    return (
      '<svg class="zevet-sprite" viewBox="0 0 ' + W + " " + H + '" width="' + (o.width || 44) +
      '" height="' + (o.height || 20) + '" aria-hidden="true" focusable="false" ' +
      'shape-rendering="crispEdges" data-tool-kind="' + kind + '">' +
      // Body first, then the eyes painted over it, then the tool. An SVG mask
      // for two 2x2 squares is more machinery than painting over them.
      '<g fill="currentColor">' + rectsFor(rows, BODY) + "</g>" +
      '<g fill="var(--zevet-sprite-eye, #eae7e2)">' + rectsFor(rows, EYE) + "</g>" +
      '<g fill="currentColor" opacity="0.55">' + rectsFor(rows, TOOL) + "</g>" +
      "</svg>"
    );
  }

  /** The tool kinds, so the board can render a legend without guessing. */
  function kinds() {
    return Object.keys(TOOLS);
  }

  global.zevetSprites = {
    spriteFor: spriteFor,
    toolKind: toolKind,
    kinds: kinds,
    WIDTH: W,
    HEIGHT: H,
    BODY_COLS: BODY_COLS,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
