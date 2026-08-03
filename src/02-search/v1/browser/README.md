# Browser tools

[Back to Search](../README.md) ·
[Application Inspection](../../../03-match/02-application-inspection/README.md)

This directory contains deterministic browser tooling used by the search and
match flows. These
files are not LLM calls and therefore do not belong under `calls/`.

`application-form-autofill.js` runs inside the proxied employer page displayed
by the UI. It requests the already inspected and prepared application from the
local API, maps those saved values onto the live controls, attaches the selected
CV, and reports fill counts through DOM data attributes. It never submits the
form; final review and submission remain user actions.

Headless acquisition, bounded LLM-guided navigation, form observation, and
schema verification are orchestrated by search and match stages.
