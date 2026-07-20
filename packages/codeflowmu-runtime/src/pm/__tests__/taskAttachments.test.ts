import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  formatTaskAttachmentPromptBlock,
  isImageAttachment,
  mergeAttachmentLists,
  parseAttachmentsFromFrontmatter,
} from "../taskAttachments.ts";

describe("taskAttachments", () => {
  it("parses frontmatter attachments with metadata", () => {
    const list = parseAttachmentsFromFrontmatter({
      attachments: [
        {
          local_path: "fcop/attachments/20260610/shot.png",
          absolute_path: "D:/codeflowmu/fcop/attachments/20260610/shot.png",
          mime: "image/png",
          original_name: "shot.png",
          size: 12345,
          sha256: "abc123",
        },
        {
          local_path: "fcop/attachments/20260610/log.txt",
          mime: "text/plain",
          original_name: "log.txt",
        },
      ],
    });
    assert.equal(list.length, 2);
    assert.equal(list[0]?.original_name, "shot.png");
    assert.equal(list[0]?.sha256, "abc123");
    assert.equal(isImageAttachment(list[0]!), true);
    assert.equal(isImageAttachment(list[1]!), false);
  });

  it("formatTaskAttachmentPromptBlock lists relative and absolute paths", () => {
    const block = formatTaskAttachmentPromptBlock([
      {
        local_path: "fcop/attachments/20260610/a.png",
        absolute_path: "D:/x/fcop/attachments/20260610/a.png",
        mime: "image/png",
        original_name: "a.png",
      },
    ]);
    assert.match(block, /相对路径 fcop\/attachments/);
    assert.match(block, /绝对路径 D:/);
    assert.match(block, /原名 a\.png/);
  });

  it("mergeAttachmentLists dedupes by local_path", () => {
    const merged = mergeAttachmentLists(
      [{ local_path: "fcop/attachments/x.png" }],
      [{ local_path: "fcop/attachments/x.png" }, { local_path: "fcop/attachments/y.pdf" }],
    );
    assert.equal(merged.length, 2);
  });
});
