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
