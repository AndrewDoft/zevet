type Fetch = (url: string, init: RequestInit) => Promise<Response>;
type Ident = { provider: string; login: string };
type Person = { login: string; key?: string; identities?: Ident[]; aliases?: string[] };

export function linkAccount(
  provider: "github" | "google" | "microsoft",
  opts: {
    fetchImpl: Fetch;
    sleep?: (ms: number) => Promise<void>;
    open?: (url: string) => void;
    onWaiting?: (w: { code?: string; url?: string }) => void;
    cancelled?: () => boolean;
    now?: () => number;
  },
): Promise<{ ok: boolean; login?: string; merged?: boolean; error?: string; cancelled?: boolean }>;
export function unlinkAccount(fetchImpl: Fetch, i: Ident): Promise<{ ok: boolean; error?: string }>;
export function combinePeople(fetchImpl: Fetch, a: { into: string; from: string }): Promise<{ ok: boolean; merged?: boolean; error?: string }>;
export function renamePerson(fetchImpl: Fetch, a: { login?: string; name: string }): Promise<{ ok: boolean; error?: string }>;
export function identityLabel(i: Ident): string;

/** Pairs of people that look like the same human, as `[from, into]` tuples. */
export function likelySame(people: Person[]): Array<[Person, Person]>;
