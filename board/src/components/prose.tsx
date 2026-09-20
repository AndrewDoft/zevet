import { inlineParts } from "../lib/prose.mjs";

export function Prose({ text }: { text: string | null | undefined }) {
  const parts = inlineParts(text);
  return (
    <>
      {parts.map((p, i) => {
        if (p.kind === "b") return <b key={i}>{p.text}</b>;
        if (p.kind === "code") return <code key={i}>{p.text}</code>;
        return <span key={i}>{p.text}</span>;
      })}
    </>
  );
}