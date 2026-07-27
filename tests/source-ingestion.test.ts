import { Document, Packer, Paragraph } from "docx";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  isReadableDisclosureLabel,
  normalizeWebUrl,
  readSupplementalEvidence,
  readUploadedDocument,
} from "../src/01-evidence-ingestion/01-evidence-acquisition/additional-evidence/read-source.js";

describe("candidate source ingestion", () => {
  it("recognizes bare portfolio domains as HTTPS URLs", () => {
    expect(normalizeWebUrl("www.stanislavvozarik.com")?.href).toBe(
      "https://www.stanislavvozarik.com/",
    );
    expect(normalizeWebUrl("stanislavvozarik.com/tempest")?.href).toBe(
      "https://stanislavvozarik.com/tempest",
    );
    expect(normalizeWebUrl("Built a protocol website")).toBeUndefined();
  });

  it("extracts readable CV text from PDF and DOCX uploads", async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage().drawText("Nina Novak - Platform Engineer - TypeScript and distributed systems", { x: 40, y: 700, size: 12, font });
    const pdfResult = await readUploadedDocument(Buffer.from(await pdf.save()).toString("base64"), "nina-cv.pdf");
    expect(pdfResult.text).toContain("Nina Novak");
    expect(pdfResult.text).toContain("TypeScript");

    const docx = new Document({ sections: [{ children: [new Paragraph("Nina Novak"), new Paragraph("Built a TypeScript job orchestration platform.")] }] });
    const docxResult = await readUploadedDocument((await Packer.toBuffer(docx)).toString("base64"), "nina-cv.docx");
    expect(docxResult.text).toContain("job orchestration platform");
  });

  it("blocks private-network webpage ingestion", async () => {
    await expect(readSupplementalEvidence({ kind: "webpage", name: "local", url: "http://127.0.0.1/private" })).rejects.toThrow("Private network URLs");
  });

  it("expands only read-only detail disclosures during webpage ingestion", () => {
    expect(
      isReadableDisclosureLabel(
        "Show detailed case study Deep technical sections and implementation notes",
      ),
    ).toBe(true);
    expect(isReadableDisclosureLabel("View more technical details")).toBe(true);
    expect(isReadableDisclosureLabel("Submit and publish details")).toBe(false);
    expect(isReadableDisclosureLabel("Delete more records")).toBe(false);
  });

  it("hashes normalized supplemental text for duplicate prevention", async () => {
    const first = await readSupplementalEvidence({
      kind: "document",
      name: "first.txt",
      content: "Built a reliable platform.\n\nLed production operations.",
    });
    const duplicate = await readSupplementalEvidence({
      kind: "document",
      name: "renamed.txt",
      content: "Built   a reliable platform.\n\n\nLed production operations.",
    });
    expect(first.contentHash).toBe(duplicate.contentHash);
  });
});
