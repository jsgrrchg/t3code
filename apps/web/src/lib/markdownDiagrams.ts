export function shouldRenderMermaidDiagram(input: {
  readonly language: string;
  readonly enabled: boolean;
  readonly isStreaming: boolean;
}): boolean {
  return input.enabled && !input.isStreaming && input.language.toLowerCase() === "mermaid";
}
