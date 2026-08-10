import { describe, expect, it } from "vite-plus/test";

import { type MarkdownHastNode, rehypeTagMarkdownSourceBlocks } from "./markdown-source-blocks";

function element(
  tagName: string,
  startLine: number,
  endLine: number,
  children: MarkdownHastNode[] = [],
): MarkdownHastNode {
  return {
    type: "element",
    tagName,
    position: { start: { line: startLine }, end: { line: endLine } },
    children,
  };
}

describe("rehypeTagMarkdownSourceBlocks", () => {
  it("tags reviewable blocks with their source line range", () => {
    const paragraph = element("p", 2, 4);
    const code = element("pre", 6, 9);
    const tree: MarkdownHastNode = { type: "root", children: [paragraph, code] };

    rehypeTagMarkdownSourceBlocks()(tree);

    expect(paragraph.properties).toMatchObject({
      dataMarkdownSourceStart: 2,
      dataMarkdownSourceEnd: 4,
    });
    expect(code.properties).toMatchObject({
      dataMarkdownSourceStart: 6,
      dataMarkdownSourceEnd: 9,
    });
  });

  it("uses an outer list item or blockquote instead of duplicate nested targets", () => {
    const listParagraph = element("p", 3, 3);
    const listItem = element("li", 2, 3, [listParagraph]);
    const quoteParagraph = element("p", 6, 7);
    const quote = element("blockquote", 5, 7, [quoteParagraph]);
    const tree: MarkdownHastNode = { type: "root", children: [listItem, quote] };

    rehypeTagMarkdownSourceBlocks()(tree);

    expect(listItem.properties).toMatchObject({
      dataMarkdownSourceStart: 2,
      dataMarkdownSourceEnd: 3,
    });
    expect(listParagraph.properties).toBeUndefined();
    expect(quote.properties).toMatchObject({
      dataMarkdownSourceStart: 5,
      dataMarkdownSourceEnd: 7,
    });
    expect(quoteParagraph.properties).toBeUndefined();
  });

  it("ignores inline and positionless nodes", () => {
    const inline = element("strong", 1, 1);
    const positionless: MarkdownHastNode = { type: "element", tagName: "p" };
    const tree: MarkdownHastNode = { type: "root", children: [inline, positionless] };

    rehypeTagMarkdownSourceBlocks()(tree);

    expect(inline.properties).toBeUndefined();
    expect(positionless.properties).toBeUndefined();
  });
});
