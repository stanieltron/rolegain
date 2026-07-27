# Evidence knowledge base

This deterministic Stage 04 substep publishes a layered, LLM-readable view of
the canonical evidence run. It adds no new factual authority and makes no model
call.

```text
knowledge/
  START_HERE.md
  index.json
  topics/
    <broad-capability-or-core-technology>.md
  sources/
    <source>.md
```

- `START_HERE.md` is the compact orientation and routing page.
- `index.json` is the machine-readable retrieval index.
- `topics/` contains one route per synthesized, evidence-backed capability.
  Incidental tools and keywords do not become pages, and each topic page is
  bounded to six representative claims. The structure is domain neutral and
  works the same way for any occupation.
- `sources/` retains deep source-reader notes, concise insights, exact
  quotations, unknowns, and inference limits without duplicating the complete
  canonical claim ledger.

The JSON/JSONL ledgers beside `knowledge/` remain authoritative. Knowledge
pages are retrieval and presentation artifacts, and every positive statement
used downstream must still resolve to a canonical claim ID.
