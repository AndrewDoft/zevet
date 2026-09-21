"use client";

/**
 * Provider marks for the labs and runtimes behind zevet's agents and models —
 * the same job logos.tsx does for claude and codex, one level further down
 * the stack: opencode fronts a dozen providers, so THIS file is what tells
 * one contributor build from another.
 *
 * Source: github.com/homarr-labs/dashboard-icons (Apache License 2.0),
 * fetched 2026-09-20 and 2026-09-21. Marks covered: opencode, DeepSeek, Qwen,
 * Kimi (Moonshot AI), Mistral, MiniMax, Ollama, Meta, Nvidia, Google,
 * poolside, Cohere.
 *
 * Cohere's is NOT from that set - dashboard-icons has no Cohere mark at any
 * spelling (checked live 2026-09-21), so Andrew supplied it from Cohere's own
 * brand assets.
 *
 * ONE FREE MODEL FAMILY STILL HAS NO MARK, deliberately: there is no Thinking
 * Machines icon anywhere upstream, so the `openrouter/thinkingmachines/
 * inkling*` pair falls back to the mark of the CLI actually running them.
 * That is the rule this file was written around - a wrong logo is worse than
 * none. Add it the moment a real one exists.
 */

import { useId, type ComponentProps, type ReactNode } from "react";

export type LogoProps = ComponentProps<"svg">;

/* ---------------------------------------------------------------------------
 * OpencodeLogo — opencode.svg / opencode-dark.svg
 *
 * opencode.svg ships two colour pairs, not one: #CFCECD / #211E1E for light
 * paper (opencode.svg and the byte-identical opencode-light.svg), and
 * #4B4646 / #F1ECEC for dark (opencode-dark.svg) — every other mark in this
 * file needs only one file because its brand colours read fine on both of
 * masora's papers, but opencode's near-black #211E1E disappears into
 * masora's dark paper (--paper: #24252c under :root[data-theme="dark"] in
 * styles/masora.css). Rather than exporting two components and making every
 * call site pick, both colour sets are embedded here and toggled with the
 * exact selector the rest of the board already uses for theme
 * (:root[data-theme="dark"], set on <html> by lib/board.ts's
 * document.documentElement.setAttribute("data-theme", g.theme)), so one
 * <OpencodeLogo /> is correct everywhere.
 * ------------------------------------------------------------------------- */

function OpencodeLogo(props: LogoProps) {
  const id = useId();
  const mask = `${id}-mask`;
  const clip = `${id}-clip`;
  const light = `${id}-light`;
  const dark = `${id}-dark`;
  return (
    <svg viewBox="0 0 240 300" xmlns="http://www.w3.org/2000/svg" fill="none" aria-hidden="true" {...props}>
      <style>{`#${light}{display:inline}#${dark}{display:none}:root[data-theme="dark"] #${light}{display:none}:root[data-theme="dark"] #${dark}{display:inline}`}</style>
      <g clipPath={`url(#${clip})`}>
        {/* The mask's own defining path is luminance data, not a brand colour
            — it has to stay literally white no matter what. An inline
            `style` beats a class-based CSS rule for specificity (the same
            fact ClaudeLogo's comment below relies on), so it stays immune
            when a teammate hue tints every plain `fill` attribute in this
            file via `[&_path]:fill-current` (brand.tsx's AgentLogo). */}
        <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="240" height="300" style={{ maskType: "luminance" }}>
          <path d="M240 0H0V300H240V0Z" style={{ fill: "#fff" }} />
        </mask>
        <g mask={`url(#${mask})`}>
          <g id={light}>
            <path d="M180 240H60V120H180V240Z" fill="#CFCECD" />
            <path d="M180 60H60V240H180V60ZM240 300H0V0H240V300Z" fill="#211E1E" />
          </g>
          <g id={dark}>
            <path d="M180 240H60V120H180V240Z" fill="#4B4646" />
            <path d="M180 60H60V240H180V60ZM240 300H0V0H240V300Z" fill="#F1ECEC" />
          </g>
        </g>
      </g>
      <defs>
        <clipPath id={clip}>
          <rect width="240" height="300" style={{ fill: "#fff" }} />
        </clipPath>
      </defs>
    </svg>
  );
}

/* ---------------------------------------------------------------------------
 * DeepSeekLogo — deepseek.svg. One path, one flat fill, no defs: nothing to
 * scope. `[&_path]:fill-current` tints it cleanly.
 * ------------------------------------------------------------------------- */

function DeepSeekLogo(props: LogoProps) {
  return (
    <svg viewBox="0 0 377.1 277.86" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" {...props}>
      <path fill="#4d6bfe" d="M373.15,23.32c-4-1.95-5.72,1.77-8.06,3.66-.79.62-1.47,1.43-2.14,2.14-5.85,6.26-12.67,10.36-21.57,9.86-13.04-.71-24.16,3.38-33.99,13.37-2.09-12.31-9.04-19.66-19.6-24.38-5.54-2.45-11.13-4.9-14.99-10.23-2.71-3.78-3.44-8-4.81-12.16-.85-2.51-1.72-5.09-4.6-5.52-3.13-.5-4.36,2.14-5.58,4.34-4.93,8.99-6.82,18.92-6.65,28.97.43,22.58,9.97,40.56,28.89,53.37,2.16,1.46,2.71,2.95,2.03,5.09-1.29,4.4-2.82,8.68-4.19,13.09-.85,2.82-2.14,3.44-5.15,2.2-10.39-4.34-19.37-10.76-27.29-18.55-13.46-13.02-25.63-27.41-40.81-38.67-3.57-2.64-7.12-5.09-10.81-7.41-15.49-15.07,2.03-27.45,6.08-28.9,4.25-1.52,1.47-6.79-12.23-6.73-13.69.06-26.24,4.65-42.21,10.76-2.34.93-4.79,1.61-7.32,2.14-14.5-2.73-29.55-3.35-45.29-1.58-29.62,3.32-53.28,17.34-70.68,41.28C1.29,88.2-3.63,120.88,2.39,155c6.33,35.91,24.64,65.68,52.8,88.94,29.18,24.1,62.8,35.91,101.15,33.65,23.29-1.33,49.23-4.46,78.48-29.24,7.38,3.66,15.12,5.12,27.97,6.23,9.89.93,19.41-.5,26.79-2.02,11.55-2.45,10.75-13.15,6.58-15.13-33.87-15.78-26.44-9.36-33.2-14.54,17.21-20.41,43.15-41.59,53.3-110.19.79-5.46.11-8.87,0-13.3-.06-2.67.54-3.72,3.61-4.03,8.48-.96,16.72-3.29,24.28-7.47,21.94-12,30.78-31.69,32.87-55.33.31-3.6-.06-7.35-3.86-9.24ZM181.96,235.97c-32.83-25.83-48.74-34.33-55.31-33.96-6.14.34-5.04,7.38-3.69,11.97,1.41,4.53,3.26,7.66,5.85,11.63,1.78,2.64,3.01,6.57-1.78,9.49-10.57,6.58-28.95-2.2-29.82-2.64-21.38-12.59-39.26-29.24-51.87-52.01-12.16-21.92-19.23-45.43-20.39-70.52-.31-6.08,1.47-8.22,7.49-9.3,7.92-1.46,16.11-1.77,24.03-.62,33.49,4.9,62.01,19.91,85.9,43.63,13.65,13.55,23.97,29.71,34.61,45.49,11.3,16.78,23.48,32.75,38.97,45.84,5.46,4.59,9.83,8.09,14,10.67-12.59,1.4-33.62,1.71-47.99-9.68ZM197.69,134.65c0-2.7,2.15-4.84,4.87-4.84.6,0,1.16.12,1.66.31.67.25,1.29.62,1.77,1.18.87.84,1.36,2.08,1.36,3.35,0,2.7-2.15,4.84-4.85,4.84s-4.81-2.14-4.81-4.84ZM246.55,159.77c-3.13,1.27-6.26,2.39-9.27,2.51-4.67.22-9.77-1.68-12.55-4-4.3-3.6-7.36-5.61-8.67-11.94-.54-2.7-.23-6.85.25-9.24,1.12-5.15-.12-8.44-3.74-11.44-2.96-2.45-6.7-3.1-10.82-3.1-1.54,0-2.95-.68-4-1.24-1.72-.87-3.13-3.01-1.78-5.64.43-.84,2.53-2.92,3.02-3.29,5.58-3.19,12.03-2.14,18,.25,5.54,2.26,9.71,6.42,15.72,12.28,6.16,7.1,7.26,9.09,10.76,14.39,2.76,4.19,5.29,8.47,7.01,13.37,1.04,3.04-.31,5.55-3.94,7.1Z" />
    </svg>
  );
}

/* ---------------------------------------------------------------------------
 * QwenLogo — qwen.svg
 *
 * Two radial gradients (paint0_radial / paint1_radial, identical stops)
 * scoped with useId(). The middle path is not a hole cut from the gradient
 * shape — it is a plain white path painted on top to fake one, which means
 * it is exactly as vulnerable to tinting as any other path here. It is kept
 * on an inline `style` rather than a `fill` attribute so `[&_path]:fill-current`
 * cannot turn it the same hue as the rest of the mark and erase the gap.
 * ------------------------------------------------------------------------- */

function QwenLogo(props: LogoProps) {
  const id = useId();
  const grad0 = `${id}-0`;
  const grad1 = `${id}-1`;
  return (
    <svg viewBox="27.55 17.52 147.28 145.51" xmlns="http://www.w3.org/2000/svg" fill="none" aria-hidden="true" {...props}>
      <path d="M174.82 108.75L155.38 75L165.64 57.75C166.46 56.31 166.46 54.53 165.64 53.09L155.38 35.84C154.86 34.91 153.87 34.33 152.78 34.33H114.88L106.14 19.03C105.62 18.1 104.63 17.52 103.54 17.52H83.3C82.21 17.52 81.22 18.1 80.7 19.03L61.26 52.77H41.02C39.93 52.77 38.94 53.35 38.42 54.28L28.16 71.53C27.34 72.97 27.34 74.75 28.16 76.19L45.52 107.5L36.78 122.8C35.96 124.24 35.96 126.02 36.78 127.46L47.04 144.71C47.56 145.64 48.55 146.22 49.64 146.22H87.54L96.28 161.52C96.8 162.45 97.79 163.03 98.88 163.03H119.12C120.21 163.03 121.2 162.45 121.72 161.52L141.16 127.78H158.52C159.61 127.78 160.6 127.2 161.12 126.27L171.38 109.02C172.2 107.58 172.2 105.8 171.38 104.36L174.82 108.75Z" fill={`url(#${grad0})`} />
      <path d="M119.12 163.03H98.88L87.54 144.71H49.64L61.26 126.39H80.7L38.42 55.29H61.26L83.3 19.03L93.56 37.35L83.3 55.29H161.58L151.32 72.54L170.76 106.28H151.32L141.16 88.34L101.18 163.03H119.12Z" style={{ fill: "#fff" }} />
      <path d="M127.86 79.83H76.14L101.18 122.11L127.86 79.83Z" fill={`url(#${grad1})`} />
      <defs>
        <radialGradient id={grad0} cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(100 100) rotate(90) scale(100)">
          <stop stopColor="#665CEE" />
          <stop offset="1" stopColor="#332E91" />
        </radialGradient>
        <radialGradient id={grad1} cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(100 100) rotate(90) scale(100)">
          <stop stopColor="#665CEE" />
          <stop offset="1" stopColor="#332E91" />
        </radialGradient>
      </defs>
    </svg>
  );
}

/* ---------------------------------------------------------------------------
 * KimiLogo — kimi-ai.svg (Moonshot AI). A dark rounded tile with a white
 * glyph and a blue accent on top, converted from the source's numbered CSS
 * classes (.fil3/.fil4/.fil5) to plain fill attributes.
 * ------------------------------------------------------------------------- */

function KimiLogo(props: LogoProps) {
  return (
    <svg viewBox="2589.93 529.3 4225.03 4225.03" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" {...props}>
      {/* The tile is the background, not part of the wordmark — tinting only
          rewrites `path` fills (brand.tsx), so a tinted Kimi keeps this fixed
          dark square with the glyph and accent recoloured on top of it
          rather than turning into one flat hue. See the report: this is the
          one mark that only tints PARTIALLY. */}
      <rect x="2589.93" y="529.3" width="4225.03" height="4225.03" rx="304.59" ry="304.59" fill="#2B2A29" />
      <path fill="#fff" d="M4354.82 2395.15l-641.29 0 0 -1043.67 -518.69 0 0 2700.35 518.69 0 0 -1137.99 930.5 0c99.31,0 187.16,-42.51 257.02,-104.49 29.17,-25.87 43.76,-42.09 67.45,-77.16l27.62 -44.68 0 1364.32 521.84 0 0 -1128.55c0,-275.9 -193.35,-483.68 -441.87,-523.22 -53.14,-8.46 -250.95,-4.91 -318.89,-4.91 25.23,-21.93 133.44,-28.86 263.21,-208.33 8.03,-11.11 13.21,-21.99 19.88,-33.56 23.63,-40.99 81.8,-173.93 101.34,-219.31l114.36 -256.58c27.34,-56.91 56.36,-131.98 81.76,-182.31 6.16,-12.22 11.49,-25.16 16.69,-36.74 8.37,-18.63 46,-98.65 47.21,-113.12l-578.42 0c-10.76,20.34 -18.77,42.96 -29.35,64.97 -5.26,10.95 -10.16,23.06 -14.21,32.93l-390.21 889.24c-8.43,18.76 -23.03,62.81 -34.64,62.81z" />
      <path fill="#0179FF" d="M5624.83 1533.81c0,162.36 81.74,224.33 81.74,242.06 0,23.25 -11.97,27.5 -32.81,55.21 -11.61,15.44 -24.68,29.28 -33.21,45.39l81.58 -3.31c11.75,-0.97 10.98,-2.67 25.21,-3.08l81.85 -3.04c13.69,-0.7 11.45,-2.49 25.14,-3.15 93.1,-4.5 197.72,-15.93 261.76,-77.75 118.61,-114.51 125.67,-360.29 17.22,-468.46 -45.13,-45.01 -112.6,-81.03 -178.4,-82.52 -17.05,-0.39 -19.63,-3.34 -34.58,-3.34 -29.74,0 -98.29,11.16 -125.81,22.15 -34.4,13.73 -66.41,32.15 -91.97,58.92 -40.84,42.79 -77.72,137.66 -77.72,220.92z" />
    </svg>
  );
}

/* ---------------------------------------------------------------------------
 * MinimaxLogo — minimax.svg. One path; the source sets `fill` on the <svg>
 * root and lets it inherit, this puts it directly on the path instead so the
 * tint rule (which targets `path`, not `svg`) can see it.
 * ------------------------------------------------------------------------- */

function MinimaxLogo(props: LogoProps) {
  return (
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" {...props}>
      <path fill="#E73562" d="M11.43 3.92a.86.86 0 1 0-1.718 0v14.236a1.999 1.999 0 0 1-3.997 0V9.022a.86.86 0 1 0-1.718 0v3.87a1.999 1.999 0 0 1-3.997 0V11.49a.57.57 0 0 1 1.139 0v1.404a.86.86 0 0 0 1.719 0V9.022a1.999 1.999 0 0 1 3.997 0v9.134a.86.86 0 0 0 1.719 0V3.92a1.998 1.998 0 1 1 3.996 0v11.788a.57.57 0 1 1-1.139 0zm10.572 3.105a2 2 0 0 0-1.999 1.997v7.63a.86.86 0 0 1-1.718 0V3.923a1.999 1.999 0 0 0-3.997 0v16.16a.86.86 0 0 1-1.719 0V18.08a.57.57 0 1 0-1.138 0v2a1.998 1.998 0 0 0 3.996 0V3.92a.86.86 0 0 1 1.719 0v12.73a1.999 1.999 0 0 0 3.996 0V9.023a.86.86 0 1 1 1.72 0v6.686a.57.57 0 0 0 1.138 0V9.022a2 2 0 0 0-1.998-1.997" />
    </svg>
  );
}

/* ---------------------------------------------------------------------------
 * MistralLogo — mistral-ai.svg. Five flat-coloured paths standing in for a
 * gradient bar (no actual <linearGradient> — the source quantises it into
 * bands). Tinting flattens all five to one hue: the "M" silhouette stays
 * legible, the five-colour bar does not survive. See the report.
 * ------------------------------------------------------------------------- */

function MistralLogo(props: LogoProps) {
  return (
    <svg viewBox="0 0 397.46 281.64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" {...props}>
      <path fill="#fc8304" fillRule="evenodd" d="M340.814 84.181 C 340.814 99.640,340.848 105.964,340.890 98.234 C 340.932 90.505,340.932 77.857,340.890 70.127 C 340.848 62.398,340.814 68.722,340.814 84.181 M170.339 112.147 C 170.069 112.321,149.330 112.422,113.206 112.425 L 56.497 112.429 56.497 140.494 L 56.497 168.558 106.285 168.691 C 157.316 168.827,261.045 168.838,312.147 168.714 L 340.819 168.644 340.746 140.537 L 340.673 112.429 283.771 112.429 C 246.141 112.429,226.810 112.334,226.695 112.147 C 226.459 111.765,170.929 111.765,170.339 112.147 " />
      <path fill="#fc4c04" fillRule="evenodd" d="M340.814 140.395 C 340.814 155.855,340.848 162.179,340.890 154.449 C 340.932 146.720,340.932 134.071,340.890 126.342 C 340.848 118.612,340.814 124.936,340.814 140.395 M56.566 196.679 L 56.638 224.718 84.605 224.795 C 99.986 224.838,112.857 224.803,113.208 224.719 L 113.845 224.565 113.773 196.675 L 113.701 168.785 85.097 168.713 L 56.494 168.641 56.566 196.679 M169.962 168.832 C 169.555 169.240,169.748 224.485,170.158 224.826 C 170.438 225.058,178.144 225.125,198.759 225.072 L 226.977 225.000 227.049 196.822 L 227.121 168.644 198.636 168.644 C 182.969 168.644,170.066 168.729,169.962 168.832 M283.464 168.997 C 283.389 169.191,283.362 181.808,283.402 197.034 L 283.475 224.718 312.006 224.718 L 340.537 224.718 340.678 196.681 L 340.819 168.644 312.209 168.644 C 289.580 168.644,283.570 168.718,283.464 168.997 " />
      <path fill="#fcb404" fillRule="evenodd" d="M340.814 27.966 C 340.814 43.425,340.848 49.749,340.890 42.020 C 340.932 34.290,340.932 21.642,340.890 13.912 C 340.848 6.183,340.814 12.507,340.814 27.966 M113.702 55.930 C 113.586 56.118,103.890 56.215,85.012 56.215 L 56.497 56.215 56.497 84.322 L 56.497 112.429 113.112 112.429 C 144.251 112.429,169.929 112.352,170.175 112.258 C 170.630 112.083,170.900 57.271,170.452 56.102 C 170.246 55.566,114.032 55.396,113.702 55.930 M226.869 56.033 C 226.637 56.314,226.570 63.946,226.623 84.353 L 226.695 112.288 283.757 112.359 L 340.819 112.431 340.746 84.323 L 340.673 56.215 312.161 56.215 C 293.458 56.215,283.589 56.118,283.475 55.932 C 283.178 55.452,227.269 55.552,226.869 56.033 " />
      <path fill="#fcdb04" fillRule="evenodd" d="M56.497 28.109 L 56.497 56.217 85.099 56.145 L 113.701 56.073 113.773 28.037 L 113.845 0.000 85.171 0.000 L 56.497 0.000 56.497 28.109 M283.403 28.037 L 283.475 56.073 312.147 56.145 L 340.819 56.217 340.746 28.109 L 340.673 0.000 312.002 -0.000 L 283.331 -0.000 283.403 28.037 M226.407 84.181 C 226.407 99.484,226.441 105.745,226.483 98.093 C 226.525 90.441,226.525 77.920,226.483 70.268 C 226.441 62.617,226.407 68.877,226.407 84.181 " />
      <path fill="#e40404" fillRule="evenodd" d="M340.677 196.751 L 340.537 224.718 284.084 224.613 C 238.408 224.529,227.501 224.578,226.951 224.873 L 226.271 225.237 226.271 253.099 C 226.271 274.392,226.351 281.040,226.610 281.299 C 226.872 281.562,246.271 281.638,312.203 281.638 L 397.458 281.638 397.458 253.107 L 397.458 224.576 369.210 224.576 L 340.963 224.576 340.891 196.681 L 340.818 168.785 340.677 196.751 M0.000 253.155 L 0.000 281.639 85.240 281.568 L 170.480 281.497 170.552 253.420 C 170.599 235.209,170.526 225.225,170.345 225.007 C 170.129 224.748,150.516 224.670,85.033 224.670 L 0.000 224.670 0.000 253.155 " />
    </svg>
  );
}

/* ---------------------------------------------------------------------------
 * OllamaLogo — ollama.svg. Five paths, one flat black fill each (the source
 * is already monochrome) inside a clipPath scoped with useId().
 * ------------------------------------------------------------------------- */

function OllamaLogo(props: LogoProps) {
  const id = useId();
  const clip = `${id}-clip`;
  return (
    <svg viewBox="294 159 1405.09 1857.06" xmlns="http://www.w3.org/2000/svg" fill="none" aria-hidden="true" {...props}>
      <g clipPath={`url(#${clip})`}>
        <path fill="black" d="M599.877 159.522C582.544 162.322 561.744 171.388 547.077 182.588C502.677 216.322 468.277 287.922 453.744 377.122C448.277 410.855 444.544 457.655 444.544 493.388C444.544 535.522 449.477 589.388 456.544 626.589C458.144 634.855 458.944 642.188 458.277 642.722C457.744 643.255 451.211 648.588 443.877 654.455C418.811 674.455 390.144 705.255 370.411 733.388C332.544 787.122 308.011 848.188 297.744 914.322C293.744 940.455 292.677 993.255 295.877 1019.39C302.944 1079.66 321.077 1130.59 352.144 1177.26L362.277 1192.32L359.344 1197.26C338.544 1232.19 320.811 1282.72 312.544 1331.26C306.011 1369.66 305.211 1379.92 305.211 1431.39C305.211 1483.26 305.877 1493.52 312.011 1529.39C319.344 1572.32 334.277 1617.79 350.944 1648.06C356.411 1657.92 369.744 1678.46 371.344 1679.52C371.877 1679.79 370.277 1684.72 367.744 1690.46C348.544 1732.46 332.144 1788.32 325.344 1835.39C320.544 1867.66 319.877 1878.06 319.877 1912.06C319.877 1955.39 322.277 1976.46 331.344 2010.99L332.677 2016.06H389.744H446.944L443.211 2008.99C420.144 1966.32 418.011 1887.12 437.877 1808.06C446.944 1771.52 457.211 1744.72 476.411 1707.79L487.877 1685.39V1671.66C487.877 1658.86 487.611 1657.39 483.477 1648.99C480.277 1642.59 476.011 1637.12 468.411 1629.66C455.477 1617.12 446.144 1603.92 438.677 1587.66C405.877 1516.46 399.477 1410.72 422.544 1320.59C432.144 1282.99 448.011 1249.52 464.677 1231.26C476.011 1218.72 481.877 1204.72 481.877 1190.19C481.877 1175.12 476.544 1162.72 464.544 1149.79C430.144 1112.99 408.944 1068.19 401.344 1016.06C390.544 941.788 410.144 860.855 454.677 796.722C498.277 733.788 559.477 693.388 627.877 682.589C643.211 680.055 671.877 680.455 687.877 683.388C705.344 686.455 716.277 685.522 727.477 680.188C741.344 673.655 748.277 665.522 756.411 646.855C763.611 630.188 769.211 621.122 784.277 602.322C802.411 579.788 819.877 564.455 847.877 545.922C879.877 524.988 916.277 509.788 952.544 502.455C965.744 499.788 971.877 499.388 996.544 499.388C1021.21 499.388 1027.34 499.788 1040.54 502.455C1093.74 513.255 1146.54 540.722 1188.68 579.655C1197.74 588.055 1219.48 614.988 1226.41 626.188C1229.08 630.588 1233.74 639.922 1236.68 646.855C1244.81 665.522 1251.74 673.655 1265.61 680.188C1276.41 685.388 1287.74 686.455 1304.54 683.655C1331.08 679.122 1351.48 679.522 1377.48 684.855C1466.01 702.722 1543.08 775.655 1577.21 873.388C1606.94 959.122 1598.54 1048.86 1554.28 1117.39C1546.81 1128.99 1539.34 1138.32 1528.54 1149.79C1505.21 1174.72 1505.21 1205.66 1528.41 1231.26C1566.54 1272.99 1590.41 1375.66 1583.21 1466.19C1578.41 1525.92 1563.08 1579.39 1542.01 1609.66C1538.28 1614.99 1530.54 1624.06 1524.68 1629.66C1517.08 1637.12 1512.81 1642.59 1509.61 1648.99C1505.48 1657.39 1505.21 1658.86 1505.21 1671.66V1685.39L1516.68 1707.79C1535.88 1744.72 1546.14 1771.52 1555.21 1808.06C1574.81 1886.06 1573.08 1963.66 1550.68 2007.79C1548.81 2011.52 1547.21 2014.99 1547.21 2015.39C1547.21 2015.79 1572.68 2016.06 1603.88 2016.06H1660.41L1661.88 2010.32C1662.68 2007.26 1664.01 2002.59 1664.68 1999.92C1666.14 1994.06 1669.08 1976.72 1671.48 1960.06C1673.74 1943.26 1673.74 1881.39 1671.48 1862.72C1662.94 1794.99 1648.68 1741.26 1625.34 1690.46C1622.81 1684.72 1621.21 1679.79 1621.74 1679.52C1622.41 1679.12 1626.14 1673.79 1630.14 1667.79C1659.21 1623.79 1677.08 1568.46 1686.14 1495.39C1688.54 1475.26 1688.54 1388.72 1686.14 1369.39C1679.74 1319.52 1672.01 1285.66 1659.21 1251.39C1653.88 1237.12 1639.74 1206.99 1633.74 1197.26L1630.81 1192.32L1640.94 1177.26C1672.01 1130.59 1690.14 1079.66 1697.21 1019.39C1700.41 993.255 1699.34 940.455 1695.34 914.322C1684.94 848.055 1660.54 787.255 1622.68 733.388C1602.94 705.255 1574.28 674.455 1549.21 654.455C1541.88 648.588 1535.34 643.255 1534.81 642.722C1534.14 642.188 1534.94 634.855 1536.54 626.589C1552.68 542.455 1552.14 437.522 1535.21 355.522C1520.54 284.055 1493.88 227.255 1459.48 194.455C1432.01 168.322 1404.01 157.122 1370.41 159.255C1293.34 163.788 1231.21 252.455 1206.68 392.188C1202.68 414.722 1199.21 441.122 1199.21 448.322C1199.21 451.122 1198.68 453.388 1198.01 453.388C1197.34 453.388 1192.14 450.722 1186.54 447.388C1127.08 412.188 1060.94 393.388 996.544 393.388C932.144 393.388 866.011 412.188 806.544 447.388C800.944 450.722 795.744 453.388 795.077 453.388C794.411 453.388 793.877 451.122 793.877 448.322C793.877 440.855 790.277 413.655 786.411 392.188C764.144 266.722 713.077 183.655 645.211 162.722C635.877 159.922 609.344 158.055 599.877 159.522ZM622.544 268.055C641.744 283.255 663.077 326.722 675.344 375.388C677.611 384.188 680.011 394.322 680.677 398.055C681.211 401.655 682.677 409.788 683.877 416.055C689.077 444.322 691.477 474.855 691.744 512.055L691.877 548.722L682.677 562.322L673.477 576.055H652.011C626.944 576.055 602.011 579.255 578.144 585.655C569.611 587.788 561.344 589.922 559.744 590.322C557.211 590.855 556.811 590.055 555.344 579.122C547.477 519.788 547.877 454.055 556.544 399.388C566.144 338.455 588.544 283.255 610.411 266.988C615.611 263.122 616.544 263.255 622.544 268.055ZM1382.81 267.122C1396.01 276.855 1410.54 302.722 1421.34 335.788C1443.08 401.922 1449.21 492.722 1437.74 579.122C1436.28 590.055 1435.88 590.855 1433.34 590.322C1431.74 589.922 1423.48 587.788 1414.94 585.655C1391.08 579.255 1366.14 576.055 1341.08 576.055H1319.61L1310.41 562.322L1301.21 548.722L1301.34 512.055C1301.61 460.322 1306.41 419.922 1317.88 374.988C1330.01 326.722 1351.48 283.255 1370.54 268.055C1376.54 263.255 1377.48 263.122 1382.81 267.122Z" />
        <path fill="black" d="M975.877 938.189C946.944 940.989 939.077 942.055 925.21 944.855C902.677 949.522 872.544 959.922 851.61 970.189C778.81 1005.79 728.677 1065.12 713.344 1133.79C710.277 1147.39 709.877 1151.92 709.877 1174.86C709.877 1197.52 710.277 1202.46 713.21 1215.39C733.61 1305.12 816.277 1371.39 923.21 1383.52C946.41 1386.06 1046.68 1386.06 1069.88 1383.52C1155.74 1373.79 1229.61 1327.26 1262.81 1261.92C1271.61 1244.46 1275.88 1233.12 1279.88 1215.39C1282.81 1202.46 1283.21 1197.52 1283.21 1174.86C1283.21 1151.92 1282.81 1147.39 1279.74 1133.79C1257.48 1034.06 1160.68 955.522 1042.01 940.589C1026.54 938.722 986.01 937.122 975.877 938.189ZM1025.74 1010.72C1065.34 1014.99 1105.21 1029.12 1137.21 1050.46C1154.41 1061.92 1178.68 1085.92 1189.08 1101.66C1201.88 1121.12 1209.21 1140.99 1212.54 1165.12C1214.01 1176.19 1213.21 1184.59 1209.21 1202.46C1202.94 1229.12 1183.48 1256.99 1157.21 1276.46C1144.94 1285.39 1119.48 1298.32 1103.88 1303.39C1074.28 1312.86 1054.94 1314.59 985.877 1314.06C940.81 1313.66 932.81 1313.26 919.877 1310.86C875.744 1302.59 840.81 1284.99 815.477 1258.19C794.944 1236.59 785.61 1216.86 780.544 1184.99C778.277 1170.19 782.544 1145.66 791.21 1124.99C801.744 1099.79 828.944 1068.46 855.877 1050.46C887.077 1029.66 928.144 1014.86 965.877 1010.86C980.41 1009.26 1011.21 1009.26 1025.74 1010.72Z" />
        <path fill="black" d="M945.61 1108.06C935.477 1113.52 928.41 1127.39 930.543 1137.66C932.943 1148.72 942.677 1159.92 957.877 1169.12C966.01 1174.06 966.543 1174.72 966.943 1179.66C967.21 1182.59 966.143 1190.99 964.677 1198.46C963.077 1205.79 961.877 1213.52 961.877 1215.66C962.01 1221.39 967.343 1230.72 972.943 1235.26C977.877 1239.26 978.81 1239.39 992.677 1239.79C1005.34 1240.19 1008.01 1239.92 1013.08 1237.52C1026.14 1231.12 1029.48 1219.39 1024.68 1196.86C1020.68 1178.06 1021.48 1175.12 1031.48 1169.39C1042.01 1163.26 1053.21 1152.46 1056.54 1145.12C1062.94 1131.12 1057.08 1115.26 1042.94 1107.92C1039.48 1106.19 1035.21 1105.39 1028.94 1105.39C1019.21 1105.39 1012.94 1107.66 1001.48 1114.99L994.943 1119.12L990.81 1116.59C973.877 1106.59 970.81 1105.39 960.543 1105.52C953.21 1105.52 949.21 1106.19 945.61 1108.06Z" />
        <path fill="black" d="M621.878 953.255C598.278 960.722 580.678 978.055 571.611 1002.72C567.211 1014.46 565.078 1032.99 566.945 1042.99C571.345 1066.86 590.945 1088.59 613.211 1094.59C641.211 1101.92 662.145 1097.12 680.678 1078.72C691.478 1068.19 697.345 1058.99 703.211 1044.06C707.478 1033.52 707.745 1031.66 707.745 1016.72L707.878 1000.72L702.278 989.255C693.345 971.122 677.211 957.655 658.545 952.722C648.011 950.055 631.078 950.189 621.878 953.255Z" />
        <path fill="black" d="M1334.01 952.855C1315.74 957.789 1299.48 971.389 1290.81 989.255L1285.21 1000.72L1285.34 1016.72C1285.34 1031.66 1285.61 1033.52 1289.88 1044.06C1295.74 1058.99 1301.61 1068.19 1312.41 1078.72C1330.94 1097.12 1351.88 1101.92 1379.88 1094.59C1396.01 1090.32 1412.14 1076.72 1419.88 1060.86C1426.54 1047.39 1428.14 1037.66 1426.01 1022.32C1421.08 987.255 1400.54 961.789 1370.01 952.855C1361.08 950.189 1343.74 950.189 1334.01 952.855Z" />
      </g>
      <defs>
        <clipPath id={clip}>
          <rect width="5849.33" height="2016" fill="transparent" />
        </clipPath>
      </defs>
    </svg>
  );
}

/* ---------------------------------------------------------------------------
 * MetaLogo — meta.svg. Two of the three fills are `url(#a)` / `url(#b)`
 * gradients whose ids are literally "a" and "b" in the source — the shortest
 * possible ids, and the most likely to collide with a second Meta mark on
 * the page or with any other inlined SVG that happens to reuse a one-letter
 * id. useId() scopes both. The source also set all three fills via a
 * `style="fill:..."` attribute rather than a `fill` attribute; that survives
 * unchanged into a React `style` prop, but an inline style beats a
 * class-based CSS rule for specificity (see OpencodeLogo above), which would
 * make `[&_path]:fill-current` powerless to tint it — so these are moved to
 * plain `fill` attributes instead, which the tint rule can see.
 * ------------------------------------------------------------------------- */

function MetaLogo(props: LogoProps) {
  const id = useId();
  const gradA = `${id}-a`;
  const gradB = `${id}-b`;
  return (
    <svg viewBox="0 0 1567 1041" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" {...props}>
      <defs>
        <linearGradient id={gradA} x1="332.6" x2="1411" y1="637.7" y2="692.2" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#0064e1" />
          <stop offset=".4" stopColor="#0064e1" />
          <stop offset=".8" stopColor="#0073ee" />
          <stop offset="1" stopColor="#0082fb" />
        </linearGradient>
        <linearGradient id={gradB} x1="245.4" x2="245.4" y1="757.6" y2="359.7" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#0082fb" />
          <stop offset="1" stopColor="#0064e0" />
        </linearGradient>
      </defs>
      <path fill="#0081fb" d="M169.5 686.5c0 59.9 13.1 105.8 30.3 133.6 22.5 36.4 56 51.8 90.2 51.8 44.2 0 84.5-10.9 162.3-118.6C514.6 667.1 588 546 637.4 470l83.7-128.6c58.1-89.3 125.3-188.6 202.5-255.9C986.5 30.5 1054.5 0 1122.8 0c114.8 0 224.1 66.5 307.7 191.4 91.6 136.7 136 308.8 136 486.5 0 105.6-20.8 183.2-56.2 244.6-34.2 59.3-100.8 118.5-213 118.5V871.9c96 0 120-88.3 120-189.3 0-144-33.6-303.8-107.5-418-52.4-81-120.4-130.5-195.2-130.5-80.8 0-145.9 61.1-219.1 169.9-38.9 57.8-78.8 128.3-123.6 207.8l-49.4 87.5c-99.1 175.9-124.2 216-173.8 282.1C461.9 997.1 387.7 1041 290 1041c-115.8 0-189.1-50.2-234.4-125.8C18.5 853.5.3 772.6.3 680.5z" />
      <path fill={`url(#${gradA})`} d="M133.7 203.3C211.3 83.7 323.2 0 451.6 0 525.9 0 599.8 22 677 85.1c84.4 68.9 174.4 182.5 286.7 369.6l40.2 67.1c97.2 162 152.5 245.3 184.8 284.6 41.6 50.5 70.8 65.5 108.6 65.5 96 0 120-88.3 120-189.3l149.2-4.7c0 105.6-20.8 183.2-56.2 244.6-34.2 59.3-100.8 118.5-213 118.5-69.7 0-131.5-15.2-199.8-79.6C1045 911.9 983.6 824 936.4 744.9L796 510.1c-70.5-117.8-135.2-205.6-172.6-245.4-40.2-42.8-92-94.5-174.5-94.5-66.9 0-123.6 46.9-171.1 118.7z" />
      <path fill={`url(#${gradB})`} d="M448.9 170.2c-66.9 0-123.6 46.9-171.1 118.7-67.2 101.4-108.3 252.5-108.3 397.6 0 59.9 13.1 105.8 30.3 133.6L55.6 915.2C18.5 853.5.3 772.6.3 680.5c0-167.6 46-342.3 133.4-477.2C211.3 83.7 323.2 0 451.6 0z" />
    </svg>
  );
}

/* ---------------------------------------------------------------------------
 * NvidiaLogo - nvidia.svg. Nemotron, in both its shapes: opencode's own
 * `nemotron-3-ultra-free` contributor build and OpenRouter's
 * `nvidia/nemotron-3-super-120b-a12b`.
 * ------------------------------------------------------------------------- */

function NvidiaLogo(props: LogoProps) {
  return (
    <svg viewBox="0 86.6 512 338.8" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" {...props}>
      <path
        style={{ fill: "#77b900" }}
        d="M52.3 232.5s46.3-68.3 138.7-75.4v-24.8C88.7 140.5 0 227.2 0 227.2s50.2 145.2 191 158.4v-26.3C87.7 346.3 52.3 232.5 52.3 232.5M191 307v24.1C112.9 317.2 91.3 236 91.3 236s37.5-41.5 99.8-48.3v26.5h-.1c-32.7-3.9-58.2 26.6-58.2 26.6S147 292.2 191 307m0-220.4v45.7c3-.2 6-.4 9-.5 116.4-3.9 192.2 95.5 192.2 95.5s-87.1 105.9-177.8 105.9c-8.3 0-16.1-.8-23.4-2.1v28.3c6.3.8 12.7 1.3 19.5 1.3 84.4 0 145.5-43.1 204.6-94.2 9.8 7.9 49.9 27 58.2 35.3-56.2 47.1-187.3 85-261.5 85-7.2 0-14-.4-20.8-1.1v39.7h321V86.6zm0 101.1v-30.6c3-.2 6-.4 9-.5 83.7-2.6 138.6 71.9 138.6 71.9s-59.3 82.4-122.9 82.4c-9.2 0-17.4-1.5-24.7-4v-92.8c32.6 3.9 39.1 18.3 58.7 51l43.6-36.7s-31.8-41.7-85.4-41.7c-5.8 0-11.4.4-16.9 1"
      />
    </svg>
  );
}

/* ---------------------------------------------------------------------------
 * GoogleLogo - google.svg. Gemma is Google's open-weights family, so the
 * house mark is the honest one; google-gemini.svg belongs to a different
 * model line and is not what OpenRouter is serving here.
 * ------------------------------------------------------------------------- */

function GoogleLogo(props: LogoProps) {
  return (
    <svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" {...props}>
      <path style={{ fill: "#4285f4" }} d="M501.8 261.8c0-18.2-1.6-35.6-4.7-52.4H256v99.1h137.8c-6.1 31.9-24.2 58.9-51.4 77V450h83.1c48.3-44.6 76.3-110.2 76.3-188.2" />
      <path style={{ fill: "#34a853" }} d="M256 512c69.1 0 127.1-22.8 169.4-61.9l-83.1-64.5c-22.8 15.4-51.9 24.7-86.3 24.7-66.6 0-123.1-44.9-143.4-105.4H27.5V371C69.6 454.5 155.9 512 256 512" />
      <path style={{ fill: "#fbbc05" }} d="M112.6 304.6c-5.1-15.4-8.1-31.7-8.1-48.6s3-33.3 8.1-48.6v-66.1H27.5C10 175.7 0 214.6 0 256s10 80.3 27.5 114.7L93.8 319c0 .1 18.8-14.4 18.8-14.4" />
      <path style={{ fill: "#ea4335" }} d="M256 101.9c37.7 0 71.2 13 98 38.2l73.3-73.3C382.8 25.4 325.1 0 256 0 155.9 0 69.6 57.5 27.5 141.3l85.2 66.1c20.2-60.5 76.7-105.5 143.3-105.5" />
    </svg>
  );
}

/* ---------------------------------------------------------------------------
 * PoolsideLogo - poolside-ai.svg. The Laguna models.
 * ------------------------------------------------------------------------- */

function PoolsideLogo(props: LogoProps) {
  return (
    <svg viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" {...props}>
      <path
        fill="#4137FF"
        d="M35.959 121.526C24.0818 115.732 14.4341 106.579 8.05066 95.0574C1.81473 83.7992 -0.879432 71.1 0.251828 58.3309C0.507952 55.4694 3.02886 53.3568 5.89156 53.6095C8.7489 53.864 10.8649 56.3873 10.6123 59.2505C9.66451 69.946 11.9251 80.5867 17.1503 90.021C21.6488 98.1439 28.092 104.861 35.9564 109.677L60.417 59.5137C50.8426 56.3249 42.8678 57.713 42.1501 57.8524C42.0448 57.8767 41.943 57.8938 41.8395 57.9145C39.4554 58.3137 37.1494 57.0107 36.2211 54.8443C34.94 52.4524 31.0936 46.6059 26.4383 44.3349C21.7831 42.0638 14.6085 42.7964 12.2989 43.2986C10.3515 43.7238 8.32488 42.9977 7.09485 41.4319C5.86482 39.866 5.62905 37.7304 6.50215 35.9399C21.9599 4.22118 60.3479 -8.99859 92.0614 6.47266C123.775 21.9439 136.981 60.3025 121.55 92.012C121.534 92.0443 121.518 92.0767 121.501 92.1126C106.016 123.796 67.6581 136.99 35.959 121.526ZM69.7599 64.0716L45.3011 114.231C69.9874 123.453 98.0784 113.207 110.924 89.9213C109.118 87.1266 105.95 83.1199 102.283 81.3311C97.5455 79.0197 90.6037 79.7768 88.2189 80.2779C87.8263 80.3712 87.435 80.4162 87.0416 80.4201C86.3368 80.4235 85.6217 80.2838 84.9355 79.9846C84.2241 79.6732 83.5808 79.2036 83.0615 78.5986C82.7647 78.2491 82.5194 77.8669 82.3222 77.4591C82.1689 77.1529 78.3756 69.7924 69.7563 64.0698L69.7599 64.0716ZM30.9948 34.9814C34.9779 36.9245 38.2192 40.0146 40.6431 42.9284C48.1391 31.4618 58.3119 22.8009 66.1701 17.2168C69.0902 15.1432 72.1137 13.2045 75.0253 11.5316C54.5716 7.23693 33.135 15.3431 20.7056 32.4098C23.9955 32.635 27.6265 33.3382 30.9948 34.9814ZM98.566 23.0203C99.0407 26.3451 99.3765 29.9182 99.5389 33.5001C99.9773 43.105 99.422 56.4087 95.0351 69.3476C98.694 69.4457 102.949 70.0927 106.842 71.9919C110.318 73.6878 113.232 76.2533 115.526 78.8142C121.381 58.4737 114.576 36.5278 98.5643 23.0239L98.566 23.0203ZM69.7958 52.1345C76.989 55.6436 82.1885 60.3121 85.7127 64.3368C91.4457 45.7079 88.9465 24.8611 86.8596 17.1403C79.4921 20.2488 61.5261 31.1118 50.3829 47.1013C55.7288 47.3994 62.6061 48.627 69.7958 52.1345Z"
      />
    </svg>
  );
}

/* ---------------------------------------------------------------------------
 * CohereLogo - north-mini-code. NOT from dashboard-icons: that set has no
 * Cohere mark at any spelling (checked live 2026-09-21), so this one was
 * supplied by Andrew from Cohere's own brand assets, which is why the header
 * above names two sources.
 * ------------------------------------------------------------------------- */

function CohereLogo(props: LogoProps) {
  return (
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" {...props}>
      <path
        fill="#39594D"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M8.128 14.099c.592 0 1.77-.033 3.398-.703 1.897-.781 5.672-2.2 8.395-3.656 1.905-1.018 2.74-2.366 2.74-4.18A4.56 4.56 0 0018.1 1H7.549A6.55 6.55 0 001 7.55c0 3.617 2.745 6.549 7.128 6.549z"
      />
      <path
        fill="#D18EE2"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M9.912 18.61a4.387 4.387 0 012.705-4.052l3.323-1.38c3.361-1.394 7.06 1.076 7.06 4.715a5.104 5.104 0 01-5.105 5.104l-3.597-.001a4.386 4.386 0 01-4.386-4.387z"
      />
      <path fill="#FF7759" d="M4.776 14.962A3.775 3.775 0 001 18.738v.489a3.776 3.776 0 007.551 0v-.49a3.775 3.775 0 00-3.775-3.775z" />
    </svg>
  );
}

/* ---------------------------------------------------------------------------
 * providerFor — resolves a provider mark from either of the two spellings
 * zevet uses: an agent name ("opencode") or an opencode model id
 * ("openrouter/google/gemma-4-31b-it:free", "opencode/nemotron-3-ultra-free"
 * — see lib/models.generated.mjs and lib/constants.ts's MODELS). The id is
 * split on "/" and ":" and every segment is checked against a fixed vendor
 * table, exact match only (no substring matching, so a model whose name
 * happens to contain a vendor word never false-positives).
 *
 * A model shaped "opencode/<name>-free" resolves to opencode itself, not to
 * whichever lab its name echoes (nemotron-3-ultra-free is an opencode
 * contributor build, not Nvidia's) — models.generated.mjs's own comment
 * calls these "opencode's own contributor builds", and the provider segment
 * agrees: "opencode" is the first segment, so the opencode mark is what's
 * honest here.
 *
 * Anything not on the table returns null. A wrong logo is worse than none —
 * that rule is why opencode itself had no mark before this file existed.
 * ------------------------------------------------------------------------- */

const VENDORS: Record<string, { Mark: (props: LogoProps) => ReactNode; name: string }> = {
  opencode: { Mark: OpencodeLogo, name: "opencode" },
  deepseek: { Mark: DeepSeekLogo, name: "DeepSeek" },
  qwen: { Mark: QwenLogo, name: "Qwen" },
  moonshot: { Mark: KimiLogo, name: "Kimi" },
  moonshotai: { Mark: KimiLogo, name: "Kimi" },
  kimi: { Mark: KimiLogo, name: "Kimi" },
  mistral: { Mark: MistralLogo, name: "Mistral" },
  mistralai: { Mark: MistralLogo, name: "Mistral" },
  minimax: { Mark: MinimaxLogo, name: "MiniMax" },
  ollama: { Mark: OllamaLogo, name: "Ollama" },
  meta: { Mark: MetaLogo, name: "Meta" },
  "meta-llama": { Mark: MetaLogo, name: "Meta" },
  nvidia: { Mark: NvidiaLogo, name: "Nvidia" },
  google: { Mark: GoogleLogo, name: "Google" },
  poolside: { Mark: PoolsideLogo, name: "poolside" },
  cohere: { Mark: CohereLogo, name: "Cohere" },
};

/**
 * Model FAMILIES whose id does not name their lab.
 *
 * WHY THIS IS SEPARATE FROM `VENDORS`. The segment scan above resolves
 * `openrouter/nvidia/nemotron-3-super-120b-a12b:free` because the lab is a
 * path segment. opencode's own builds are not written that way: their id is
 * `opencode/<model>-free`, so the only segment that matches anything is
 * "opencode" itself, and every one of them rendered the opencode mark.
 * Andrew: "within opencode add the right logos for the relevant models (i.e.
 * meta logo for muse)".
 *
 * These keys are MODEL-FAMILY names, not vendor words, and they are matched
 * as a PREFIX of the last path segment - so "muse-spark-1.3-contributor-free"
 * resolves and a model that merely contains a lab's name somewhere in the
 * middle still does not. The rule the rest of this file follows holds here
 * too: anything not listed gets no mark rather than a guessed one.
 */
const FAMILIES: Record<string, string> = {
  "muse-spark": "meta",
  nemotron: "nvidia",
  laguna: "poolside",
  gemma: "google",
};

/**
 * The two agent-name vocabularies zevet has, normalised to one.
 *
 *  - A console's `agent` (ConsoleEntry.agent, lib/types.ts): "claude" |
 *    "codex" | "opencode" — what `local:agents` returns and what the
 *    launcher starts (see MODELS in lib/constants.ts).
 *  - A hub event's `agent` (HubEvent.agent), which is what people.tsx reads
 *    as `r.lastEvent.agent`: client/detect.mjs's own ids, "claude-code" |
 *    "codex" | "opencode". codex and opencode already agree with the console
 *    vocabulary; claude does not ("claude-code" vs "claude").
 *
 * Lowercased and merged here so either spelling, from either call site,
 * resolves the same way. The next agent zevet learns to detect will add a
 * third spelling somewhere — check both vocabularies again when it does.
 */
export function normalizeAgentKey(raw: string): string {
  const k = raw.trim().toLowerCase();
  return k === "claude-code" ? "claude" : k;
}

export function providerFor(key: string): { Mark: (props: LogoProps) => ReactNode; name: string } | null {
  const k = normalizeAgentKey(key);
  const segments = k.split(/[/:]/);
  // ⚠️ THE FAMILY IS CHECKED FIRST, and it has to be. An opencode id reads
  // `opencode/muse-spark-1.3-contributor-free`, and "opencode" is a segment
  // that matches VENDORS — so a segment-first scan answered "opencode" for
  // every contributor build and never looked at the model at all. The name of
  // the runtime fronting a model is the LEAST specific thing in that id.
  const tail = segments[segments.length - 1] ?? "";
  for (const [family, vendor] of Object.entries(FAMILIES)) {
    if (tail.startsWith(family)) return VENDORS[vendor] ?? null;
  }
  for (const segment of segments) {
    const hit = VENDORS[segment];
    if (hit) return hit;
  }
  return null;
}

export {
  OpencodeLogo,
  NvidiaLogo,
  GoogleLogo,
  PoolsideLogo,
  CohereLogo,
  DeepSeekLogo,
  QwenLogo,
  KimiLogo,
  MinimaxLogo,
  MistralLogo,
  OllamaLogo,
  MetaLogo,
};
