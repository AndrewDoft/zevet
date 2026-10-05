/**
 * Settings → Account & Team: one person, many sign-ins.
 *
 * Lists the accounts linked to you, lets you link another (its OWN OAuth
 * sign-in proves it — see lib/identity.mjs) or unlink one, and gives the owner
 * the "combine" action for people the hub cannot prove are one human ("andrew"
 * and "@AndrewDoft").
 */
import { useEffect, useRef, useState } from "react";
import { GithubMark, GoogleMark } from "./logos";
import { combinePeople, identityLabel, likelySame, linkAccount, renamePerson, unlinkAccount } from "../lib/identity.mjs";
import { useBoard } from "../lib/board";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

const BTN = "sbtn";

type Ident = { provider: string; login: string };

/** Suggested pairs the owner dismissed, so each is offered once. */
const DISMISSED_KEY = "zevet.combine.dismissed";
function readDismissed(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(DISMISSED_KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function writeDismissed(v: string[]) {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(v));
  } catch {
    // Private window or blocked storage: the suggestion just comes back.
  }
}

function LinkButton({ provider, onDone }: { provider: "github" | "google"; onDone: () => void }) {
  const [state, setState] = useState<
    | { phase: "idle" }
    | { phase: "waiting"; code?: string; url?: string }
    | { phase: "done"; login: string; merged: boolean }
    | { phase: "fail"; message: string }
  >({ phase: "idle" });
  const stop = useRef(false);
  useEffect(() => () => void (stop.current = true), []);
  const name = provider === "github" ? "GitHub" : "Google";

  function click() {
    if (state.phase === "waiting") {
      stop.current = true;
      setState({ phase: "idle" });
      return;
    }
    stop.current = false;
    setState({ phase: "waiting" });
    void linkAccount(provider, {
      fetchImpl: (u: string, i: RequestInit) => fetch(u, i),
      open: (url: string) => window.open(url, "_blank", "noopener,noreferrer"),
      onWaiting: (w: { code?: string; url?: string }) => !stop.current && setState({ phase: "waiting", ...w }),
      cancelled: () => stop.current,
    }).then((r: { ok: boolean; login?: string; merged?: boolean; error?: string; cancelled?: boolean }) => {
      if (stop.current) return;
      if (r.ok) {
        setState({ phase: "done", login: r.login || "", merged: Boolean(r.merged) });
        onDone();
      } else setState({ phase: "fail", message: r.error || "Linking failed." });
    });
  }

  return (
    <div className="srow">
      <button className={BTN} type="button" onClick={click}>
        {state.phase === "waiting" ? "Cancel" : <>{provider === "github" ? <GithubMark /> : <GoogleMark />} Link {name}</>}
      </button>
      <span className="v">
        {state.phase === "waiting"
          ? state.code
            ? `Approve on GitHub: ${state.code}`
            : "Finish in your browser…"
          : state.phase === "done"
            ? `Linked ${state.login}${state.merged ? " — that was a separate person, now combined." : "."}`
            : state.phase === "fail"
              ? state.message
              : ""}
        {state.phase === "waiting" && state.url ? (
          <>
            {" "}
            <button className={BTN} type="button" onClick={() => window.open(state.url, "_blank", "noopener,noreferrer")}>
              Open link
            </button>
          </>
        ) : null}
      </span>
    </div>
  );
}

export function IdentityRows({
  identities,
  owner,
  people,
  githubSignIn,
  googleSignIn,
  onChanged,
}: {
  identities: Ident[];
  owner: boolean;
  people: Array<{ key?: string; login: string }>;
  githubSignIn: boolean;
  googleSignIn: boolean;
  onChanged: () => void;
}) {
  const roster = useBoard((s) => s.roster);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const from = useRef<HTMLInputElement>(null);
  const [into, setInto] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  const [who, setWho] = useState("");

  function rename() {
    const n = (nameRef.current && nameRef.current.value.trim()) || "";
    const t = who || (people[0] && (people[0].key || people[0].login)) || "";
    if (!n || !t) return;
    setBusy(true);
    setErr("");
    void renamePerson((u: string, o: RequestInit) => fetch(u, o), { login: t, name: n }).then((r: { ok: boolean; error?: string }) => {
      setBusy(false);
      if (r.ok) {
        if (nameRef.current) nameRef.current.value = "";
        onChanged();
      } else setErr(r.error || "Could not rename them.");
    });
  }

  function unlink(i: Ident) {
    setBusy(true);
    setErr("");
    void unlinkAccount((u: string, o: RequestInit) => fetch(u, o), i).then((r: { ok: boolean; error?: string }) => {
      setBusy(false);
      if (r.ok) onChanged();
      else setErr(r.error || "Could not unlink that.");
    });
  }

  function combine(pair?: { from: string; into: string }) {
    const f = pair ? pair.from : (from.current && from.current.value.trim()) || "";
    const t = pair ? pair.into : into || (people[0] && (people[0].key || people[0].login)) || "";
    if (!f || !t) return;
    setBusy(true);
    setErr("");
    void combinePeople((u: string, o: RequestInit) => fetch(u, o), { into: t, from: f }).then((r: { ok: boolean; error?: string }) => {
      setBusy(false);
      if (r.ok) {
        if (from.current) from.current.value = "";
        onChanged();
      } else setErr(r.error || "Could not combine them.");
    });
  }

  const known = [...new Set([...people.map((p) => p.key || p.login), ...roster.map((r) => r.actor)])];

  /* Andrew had "andrew" and "AndrewDoft" and could not find the combine
     control. The pairs that are plainly one person are offered up front. */
  const [dismissed, setDismissed] = useState(readDismissed);
  const candidates = [
    ...people,
    ...roster.map((r) => r.actor).filter((a) => a && !people.some((p) => (p.key || p.login) === a || p.login === a)).map((a) => ({ login: a })),
  ];
  const suggested = owner
    ? likelySame(candidates)
        .map(([f, t]) => ({ from: f.key || f.login, into: t.key || t.login, label: `${f.login} · ${t.login}` }))
        .filter((s) => !dismissed.includes(`${s.from}>${s.into}`))
    : [];

  return (
    <>
      {suggested.map((sg) => (
        <div className="srow" key={`${sg.from}>${sg.into}`}>
          <span className="k">{sg.label}</span>
          <span className="v">
            <button className={BTN} type="button" disabled={busy} onClick={() => combine(sg)}>
              Combine
            </button>
            <button
              className={BTN}
              type="button"
              aria-label="Not the same person"
              onClick={() => {
                const next = [...dismissed, `${sg.from}>${sg.into}`];
                writeDismissed(next);
                setDismissed(next);
              }}
            >
              ×
            </button>
          </span>
        </div>
      ))}
      {identities.map((i) => (
        <div className="srow" key={`${i.provider}:${i.login}`}>
          <span className="k">{identityLabel(i)}</span>
          <span className="v">
            {identities.length > 1 ? (
              <button className={BTN} type="button" disabled={busy} onClick={() => unlink(i)}>
                Unlink
              </button>
            ) : (
              "Your sign-in"
            )}
          </span>
        </div>
      ))}
      {githubSignIn ? <LinkButton provider="github" onDone={onChanged} /> : null}
      {googleSignIn ? <LinkButton provider="google" onDone={onChanged} /> : null}
      {owner && people.length > 1 ? (
        <form
          className="sinvite"
          onSubmit={(ev) => {
            ev.preventDefault();
            combine();
          }}
        >
          <input
            className="mono"
            ref={from}
            list="zevet-combine-from"
            type="text"
            aria-label="Name to combine"
            placeholder="Combine… (a person or a name on the board)"
            autoComplete="off"
            spellCheck={false}
          />
          <datalist id="zevet-combine-from">
            {known.map((k) => (
              <option key={k} value={k} />
            ))}
          </datalist>
          <Select value={into || people[0].key || people[0].login} onValueChange={(v: string | null) => v && setInto(v)}>
            <SelectTrigger size="sm" className="h-7 shrink-0 rounded-full border-transparent bg-foreground/[0.04] px-2 text-xs" aria-label="Into this person">
              <SelectValue>{() => `into ${(people.find((p) => (p.key || p.login) === (into || people[0].key || people[0].login)) || people[0]).login}`}</SelectValue>
            </SelectTrigger>
            <SelectContent align="start">
              {people.map((p) => (
                <SelectItem key={p.key || p.login} value={p.key || p.login}>
                  into {p.login}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <button className={BTN} type="submit" disabled={busy}>
            Combine
          </button>
        </form>
      ) : null}
      {owner && people.length > 0 ? (
        <form
          className="sinvite"
          onSubmit={(ev) => {
            ev.preventDefault();
            rename();
          }}
        >
          <Select value={who || people[0].key || people[0].login} onValueChange={(v: string | null) => v && setWho(v)}>
            <SelectTrigger size="sm" className="h-7 shrink-0 rounded-full border-transparent bg-foreground/[0.04] px-2 text-xs" aria-label="Person to rename">
              <SelectValue>{() => (people.find((p) => (p.key || p.login) === (who || people[0].key || people[0].login)) || people[0]).login}</SelectValue>
            </SelectTrigger>
            <SelectContent align="start">
              {people.map((p) => (
                <SelectItem key={p.key || p.login} value={p.key || p.login}>
                  {p.login}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <input className="mono" ref={nameRef} type="text" aria-label="New display name" placeholder="New name" maxLength={40} autoComplete="off" spellCheck={false} />
          <button className={BTN} type="submit" disabled={busy}>
            Rename
          </button>
        </form>
      ) : null}
      {err ? <p className="snote" style={{ color: "var(--bad)" }}>{err}</p> : null}
    </>
  );
}
