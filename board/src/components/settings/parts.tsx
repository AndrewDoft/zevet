/** The Settings page's layout pieces, shared by settings.tsx and the panels beside it. */
import { createContext, type ReactNode } from "react";

/** True under SettingsPage: sections draw open, with a heading, not as a collapsed row. */
export const InPage = createContext(false);

export function PageSection({ title, summary, id, children }: { title: string; summary?: ReactNode; id?: string; children?: ReactNode }) {
  return (
    <section className="spage-sec" id={id}>
      <header className="spage-sec-head">
        <h3>{title}</h3>
        {summary ? <span className="spage-sum">{summary}</span> : null}
      </header>
      {children ? <div className="spage-body">{children}</div> : null}
    </section>
  );
}
