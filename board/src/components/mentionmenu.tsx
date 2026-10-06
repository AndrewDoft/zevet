/**
 * The `@` menu over the composer: Teammates and Agents, from the live roster.
 * Built on assistant-ui's trigger popover ("Mentions in Chat"); the `/` menu
 * (slashmenu.tsx) is a separate, older mechanism and the two do not meet —
 * `/` is only ever the first character, `@` can be anywhere.
 *
 * Picking inserts a directive into the text (`:user[Kai]{name=kai}`), which
 * lib/mentions.mjs reads back and slashtext.tsx draws as a chip once sent.
 * Code surface only: Chat has nobody to mention.
 */
import { useContext, useMemo, type ReactNode } from "react";
import { ComposerPrimitive, unstable_useMentionAdapter } from "@assistant-ui/react";
import { AtSignIcon, BotIcon, UserIcon } from "lucide-react";
import { selectRoster, useBoard } from "../lib/board";
import { mentionCategories } from "../lib/mentions.mjs";
import { ChatSurface } from "../lib/surface";
import { cn } from "@/lib/utils";

const row =
  "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-start text-sm data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground";

function MentionPopover() {
  const roster = useBoard(selectRoster);
  const agents = useBoard((s) => s.teamAgents);
  const myActor = useBoard((s) => s.myActor);
  const categories = useMemo(() => mentionCategories({ roster, agents, myActor }), [roster, agents, myActor]);
  const mention = unstable_useMentionAdapter({
    categories,
    includeModelContextTools: false,
    iconMap: { user: UserIcon, agent: BotIcon },
    fallbackIcon: AtSignIcon,
  });
  const Icon = (k: string) => (k === "agent" ? BotIcon : UserIcon);

  return (
    <ComposerPrimitive.Unstable_TriggerPopover
      char="@"
      adapter={mention.adapter}
      aria-label="Mention"
      className="bg-popover text-popover-foreground border-foreground/10 absolute bottom-full left-0 z-50 mb-2 max-h-64 w-full max-w-md overflow-y-auto rounded-xl border p-1.5 shadow-lg"
    >
      <ComposerPrimitive.Unstable_TriggerPopover.Directive {...mention.directive} />
      <ComposerPrimitive.Unstable_TriggerPopoverCategories>
        {(cats) =>
          cats.map((c) => (
            <ComposerPrimitive.Unstable_TriggerPopoverCategoryItem key={c.id} categoryId={c.id} className={row}>
              {(() => {
                const I = Icon(c.id);
                return <I className="size-4 opacity-60" aria-hidden="true" />;
              })()}
              {c.label}
            </ComposerPrimitive.Unstable_TriggerPopoverCategoryItem>
          ))
        }
      </ComposerPrimitive.Unstable_TriggerPopoverCategories>
      <ComposerPrimitive.Unstable_TriggerPopoverBack className={cn(row, "text-muted-foreground text-xs")}>
        ‹ Back
      </ComposerPrimitive.Unstable_TriggerPopoverBack>
      <ComposerPrimitive.Unstable_TriggerPopoverItems>
        {(items) =>
          items.map((item, i) => {
            const I = Icon(item.type);
            return (
              <ComposerPrimitive.Unstable_TriggerPopoverItem key={item.id} item={item} index={i} className={row}>
                <I className="size-4 opacity-60" aria-hidden="true" />
                <span className="truncate">{item.label}</span>
                {item.description ? (
                  <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">{item.description}</span>
                ) : null}
              </ComposerPrimitive.Unstable_TriggerPopoverItem>
            );
          })
        }
      </ComposerPrimitive.Unstable_TriggerPopoverItems>
    </ComposerPrimitive.Unstable_TriggerPopover>
  );
}

/** Wraps the composer's contents; the popover is the only thing it adds. */
export function MentionRoot({ children }: { children: ReactNode }) {
  const isChat = useContext(ChatSurface);
  if (isChat) return <>{children}</>;
  return (
    <ComposerPrimitive.Unstable_TriggerPopoverRoot>
      {children}
      <MentionPopover />
    </ComposerPrimitive.Unstable_TriggerPopoverRoot>
  );
}
