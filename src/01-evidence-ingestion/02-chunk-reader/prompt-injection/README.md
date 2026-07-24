# Prompt-injection boundary

This component owns the trust boundary between uploaded candidate text and the
reader model. It deliberately does not remove suspicious text: a security CV
may legitimately mention prompts, shells, or injection attacks.

It instead:

1. labels all source content as untrusted data;
2. JSON-serializes the content so it cannot forge prompt delimiters;
3. records deterministic instruction-shaped signals for the coverage verifier;
4. relies on the Codex runtime to terminate forbidden tool use.

Signals are diagnostic evidence, not proof that a document is malicious.
