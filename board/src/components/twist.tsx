import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";

/**
 * The file tree's own twisty.
 *
 * ⚠️ ONE COPY, DELIBERATELY. The Agents rail, the file tree and the settings
 * sheet all open and close things, and Andrew asked for the same chevron in
 * each ("take the filetree dropdown thing") — three local copies is three
 * chances for one of them to drift a pixel or a shade away from the others.
 */
export function Twist({ open }: { open: boolean }) {
  return open ? (
    <ChevronDownIcon className="text-foreground/25 size-3 shrink-0" />
  ) : (
    <ChevronRightIcon className="text-foreground/25 size-3 shrink-0" />
  );
}
