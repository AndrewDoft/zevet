export function showConversation() {
  return { conversationOpen: true, selectedPath: null };
}

export function showFile(selectedPath) {
  return { conversationOpen: false, selectedPath };
}

export function mainSurface(viewMode, selectedPath, conversationOpen) {
  if (viewMode === "agent") return "conversation";
  return conversationOpen && !selectedPath ? "conversation" : "detail";
}

/* The repo on the rail follows the thread in front. It only moves when the
   thread in front moves to another repo — so picking a folder by hand while a
   thread is open still sticks — and it is left alone for a thread in the repo
   already open. `prevRoot` is the front thread's root last time; `root` now. */
export function repoToFollow(prevRoot, root, localRoot) {
  return root && root !== prevRoot && root !== localRoot ? root : null;
}
