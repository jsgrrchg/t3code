const MARKDOWN_REVIEWABLE_BLOCK_TAGS = new Set([
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "p",
  "pre",
  "table",
]);

export type MarkdownHastNode = {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  position?: {
    start?: { line?: number };
    end?: { line?: number };
  };
  children?: MarkdownHastNode[];
};

/** Tags the outermost useful rendered blocks with their Markdown source lines. */
export function rehypeTagMarkdownSourceBlocks() {
  return (tree: MarkdownHastNode) => {
    const visit = (node: MarkdownHastNode) => {
      const startLine = node.position?.start?.line;
      const endLine = node.position?.end?.line;
      if (
        node.type === "element" &&
        typeof node.tagName === "string" &&
        MARKDOWN_REVIEWABLE_BLOCK_TAGS.has(node.tagName) &&
        typeof startLine === "number" &&
        typeof endLine === "number"
      ) {
        node.properties = {
          ...node.properties,
          dataMarkdownSourceStart: startLine,
          dataMarkdownSourceEnd: endLine,
        };
        // A list item or blockquote owns its nested paragraphs as one review
        // target. This prevents stacked comment actions for the same content.
        return;
      }
      node.children?.forEach(visit);
    };

    visit(tree);
  };
}
