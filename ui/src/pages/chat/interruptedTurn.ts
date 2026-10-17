interface InterruptibleMessage {
  role: string;
  content: string;
  interrupted?: boolean;
  stopped?: boolean;
}

export function interruptedTurnNotice(message: InterruptibleMessage): string | null {
  if (message.role !== "assistant" || message.interrupted !== true) return null;
  if (message.content.trim()) return null;
  return message.stopped === true ? "Stopped before finishing" : "Interrupted before finishing";
}
