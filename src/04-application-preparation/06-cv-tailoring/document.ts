import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from "docx";

/** Render the model's constrained Markdown into a conventional editable DOCX. */
export async function renderTailoredCvDocx(content: string): Promise<Buffer> {
  const paragraphs: Paragraph[] = [];
  for (const rawLine of content.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      paragraphs.push(new Paragraph({ text: "", spacing: { after: 80 } }));
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      paragraphs.push(
        new Paragraph({
          text: stripMarkdown(heading[2]),
          heading:
            heading[1].length === 1
              ? HeadingLevel.TITLE
              : heading[1].length === 2
                ? HeadingLevel.HEADING_1
                : HeadingLevel.HEADING_2,
          alignment:
            heading[1].length === 1
              ? AlignmentType.CENTER
              : AlignmentType.LEFT,
          spacing: { before: 180, after: 80 },
        }),
      );
      continue;
    }
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (bullet) {
      paragraphs.push(
        new Paragraph({
          children: [new TextRun(stripMarkdown(bullet[1]))],
          bullet: { level: 0 },
          spacing: { after: 60 },
        }),
      );
      continue;
    }
    paragraphs.push(
      new Paragraph({
        children: [new TextRun(stripMarkdown(line))],
        spacing: { after: 80, line: 260 },
      }),
    );
  }
  const document = new Document({
    creator: "RolegAIn",
    description: "Application-specific CV generated from candidate evidence",
    sections: [
      {
        properties: {
          page: {
            margin: { top: 720, right: 720, bottom: 720, left: 720 },
          },
        },
        children: paragraphs,
      },
    ],
    styles: {
      default: {
        document: {
          run: { font: "Aptos", size: 21 },
          paragraph: { spacing: { after: 80 } },
        },
      },
    },
  });
  return Buffer.from(await Packer.toBuffer(document));
}

function stripMarkdown(value: string) {
  return value
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .trim();
}
