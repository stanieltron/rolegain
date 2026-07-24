# Stage 01b — Supplemental evidence

[Back to Evidence Acquisition](../README.md) ·
[Reader implementation](./read-source.ts) · [Add/dedupe implementation](./add-evidence.ts)

This directory contains deterministic acquisition and text-extraction code used
before model analysis. It is not an LLM stage.

`read-source.ts` handles:

- uploaded PDF, DOC, DOCX, TXT, Markdown, RTF, HTML, and JSON documents;
- base64 decoding and the 15 MB upload bound;
- PDF and Word text extraction;
- public webpage acquisition and rendered-site traversal;
- GitHub profile and repository acquisition;
- text cleanup, encoding repair, and the 400,000-character extracted-text
  bound;
- one SHA-256 over normalized extracted text.

`add-evidence.ts` compares that hash with active supplemental sources, skips
duplicate content, adds new content, stores an uploaded original when present,
and marks candidate evidence for rebuilding. No source version, MIME type,
parser version, access policy, or retrieval metadata is added to the candidate
source record.

CV upload uses `readUploadedDocument()` only. Its active source record remains
minimal as documented in [CV replacement](../cv/README.md).

`profile-links.ts` stages LinkedIn, GitHub, and website fields as supplemental
evidence. Their actual URL acquisition uses the same `read-source.ts` reader.

All public network destinations pass the shared SSRF boundary in
`src/infrastructure/public-http.ts`. Acquisition does not call an LLM; later
reader calls receive only the extracted text.
