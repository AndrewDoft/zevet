/* zevet agent sprites — the little figures that ride the line an agent is editing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THESE ARE FOR
 *
 * The board already gives every teammate a colour (--who-0..n). One figure per
 * active agent, drawn in its owner's colour and carrying the tool its agent is
 * currently using, is the whole idea: you glance at a file and you can see that
 * Kai's agent is erasing something at line 40 while yours is writing at line 12.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY PIXEL ART DRAWN AS RECTANGLES, and not an image
 *
 *   • It takes the teammate's colour. Every body pixel is `currentColor`, so one
 *     sprite serves every participant and the colour comes from the CSS that
 *     already assigns it. A PNG per person per tool is a combinatorial mess and
 *     a second place for the palette to drift.
 *   • The hub serves static files with no build step and no image pipeline.
 *   • At the size these are drawn (16-20px) a vector illustration turns to mud
 *     and a bitmap needs @2x. A pixel grid is crisp at any integer scale by
 *     construction, and `shape-rendering: crispEdges` keeps it that way.
 *
 * ⚠️ THESE ARE ORIGINAL AND DELIBERATELY GENERIC. They are little agent
 * figures, not a rendering of Anthropic's Claude mascot or anyone else's
 * character. zevet watches Claude Code AND Codex — a board that drew somebody's
 * brand character for both would be wrong twice over, once about whose agent it
 * is and once about whose artwork it is.
 *
 * ⚠️ NOT VERIFIED: nobody has seen these on a real board next to real events.
 * They are drawn from the grids below and eyeballed in isolation.
 */
(function (global) {
  "use strict";

  /**
   * The alphabet of the grids below.
   *
   *   #  body      — currentColor, i.e. the teammate's assigned colour
   *   o  eye       — a hole, painted in the surface colour behind the sprite so
   *                  it reads as a cut-out rather than a dark dot. Taken from
   *                  --zevet-sprite-eye, which the board sets to its own
   *                  background; a sprite over a highlighted line therefore
   *                  keeps its eyes the colour of that line, not the page.
   *   t  tool      — currentColor at reduced opacity. The user asked for the
   *                  agent's colour to match its teammate's, so the tool stays
   *                  in the same hue rather than introducing a second one.
   *   .  nothing
   */
  var BODY = "#";
  var EYE = "o";
  var TOOL = "t";

  /**
   * Every grid is 16 wide and 8 tall: a 10-wide figure on the left, a 6-wide
   * column on the right for whatever it is holding. Keeping the body identical
   * across all of them is the point — the figure is the person, the tool is what
   * their agent is doing this second, and only the tool should change when an
   * agent moves from reading to writing.
   */
  var FIGURE = [
    "..######..",
    ".########.",
    "##########",
    "##o####o##",
    "##########",
    "##########",
    ".########.",
    "..######..",
  ];

  /** The right-hand 6 columns, one set per tool. */
  var TOOLS = {
    /** A pencil, held up and angled. Writing or editing. */
    pencil: ["....t.", "...ttt", "..ttt.", ".ttt..", "ttt...", "t.....", "......", "......"],
    /** A block eraser. Deleting. */
    eraser: ["......", ".tttt.", ".tttt.", ".tttt.", ".tttt.", "......", "......", "......"],
    /** A magnifier. Reading, grepping, globbing. */
    lens: [".ttt..", "t...t.", "t...t.", ".t..t.", "..ttt.", "....t.", ".....t", "......"],
    /** A terminal window with a prompt chevron. Running a command. */
    shell: ["tttttt", "t....t", "t.t..t", "t..t.t", "t.t..t", "t....t", "tttttt", "......"],
    /** A sheet with lines. Creating a new file. */
    page: [".ttttt", ".t...t", ".ttttt", ".t...t", ".ttt.t", ".t...t", ".ttttt", "......"],
    /** Nothing in hand. Idle, or a tool we have no drawing for. */
    none: ["......", "......", "......", "......", "......", "......", "......", "......"],
  };

  /**
   * Tool name → which thing the figure is holding.
   *
   * ⚠️ THE KEYS ARE REAL TOOL NAMES OFF THE WIRE, not a guess at a taxonomy.
   * `client/hook.mjs` forwards `p.tool_name` verbatim from Claude Code and
   * Codex, so these are matched case-insensitively against whatever those two
   * actually send. A name nobody has seen falls through to `none`, which is
   * correct behaviour rather than a gap: a figure standing there empty-handed
   * is honest about the fact that we do not know what it is doing, and an
   * invented icon would not be.
   */
  var BY_TOOL = {
    edit: "pencil",
    multiedit: "pencil",
    notebookedit: "pencil",
    // ⚠️ THESE KEYS ARE ALREADY NORMALISED — lower case, with spaces,
    // underscores and hyphens removed — because that is what `toolKind` looks
    // up. Writing them the way the wire spells them (`apply_patch`) makes the
    // entry unreachable and the sprite silently empty-handed.
    applypatch: "pencil",
    strreplaceeditor: "pencil",
    write: "page",
    createfile: "page",
    read: "lens",
    grep: "lens",
    glob: "lens",
    search: "lens",
    webfetch: "lens",
    websearch: "lens",
    bash: "shell",
    shell: "shell",
    run: "shell",
    powershell: "shell",
    exec: "shell",
  };

  /**
   * A delete is not its own tool anywhere — it arrives as an Edit or a Bash `rm`.
   * The eraser is therefore chosen by the CALLER, which can see that a change
   * removed lines, rather than by the tool name, which cannot. `spriteFor` takes
   * an explicit hint for exactly this.
   */
  function toolKind(toolName, hint) {
    if (hint && TOOLS[hint]) return hint;
    if (!toolName) return "none";
    return BY_TOOL[String(toolName).toLowerCase().replace(/[\s_-]/g, "")] || "none";
  }

  var W = 16;
  var H = 8;

  /** Stitch the fixed figure and a tool column into one 16x8 grid. */
  function gridFor(kind) {
    var tool = TOOLS[kind] || TOOLS.none;
    var rows = [];
    for (var y = 0; y < H; y++) rows.push(FIGURE[y] + tool[y]);
    return rows;
  }

  /**
   * Runs of identical pixels on a row become ONE rect rather than one rect per
   * pixel. A 16x8 sprite is 128 cells; drawn naively that is 128 nodes per
   * figure, and a busy board can hold a dozen figures that move every time an
   * event lands. Run-length encoding takes a typical sprite to about 30 rects
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
   *   spriteFor({ tool: "Edit" })            -> a figure with a pencil
   *   spriteFor({ tool: "Bash", hint: "eraser" })
   *
   * The caller sets the colour by setting `color` on the element (or an
   * ancestor); everything here is currentColor. `aria-hidden` because the board
   * states who is doing what in text as well — a screen reader should not have
   * to hear about a drawing of a pencil.
   */
  function spriteFor(opts) {
    var o = opts || {};
    var kind = toolKind(o.tool, o.hint);
    var rows = gridFor(kind);
    return (
      '<svg class="zevet-sprite" viewBox="0 0 ' + W + " " + H + '" width="' + (o.width || 32) +
      '" height="' + (o.height || 16) + '" aria-hidden="true" focusable="false" ' +
      'shape-rendering="crispEdges" data-tool-kind="' + kind + '">' +
      // Body first, then the eyes punched over it, then the tool. Order matters:
      // the eyes are drawn ON the body, not cut out of it, because an SVG mask
      // for two 1px squares is more machinery than painting over them.
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

  global.zevetSprites = { spriteFor: spriteFor, toolKind: toolKind, kinds: kinds };
})(typeof globalThis !== "undefined" ? globalThis : this);
