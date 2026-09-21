# RolegAIn — 20-second product demo

A 1920 × 1080, 30 fps UI recording with editorial captions, cursor movement, compressed processing, and a locally synthesized original soundtrack. The full flow ends with the candidate clicking Apply in a fictional employer form.

## Deliverables

- `output/rolegain-how-it-works-v2.mp4` — H.264 MP4 with AAC stereo music and interface sounds.
- `output/rolegain-how-it-works-v2-silent.mp4` — the same edit without audio.
- `output/poster-v2.jpg` — video poster.
- `output/render-report-v2.json` — timing and recording checks.
- `preview.html` — local playback and download page.

## Story

| Time | Beat |
| --- | --- |
| 0–1.1s | Upload the fictional CV through the real file control. |
| 1.1–2.8s | Explore GitHub; stage an article and certificate; analyze the batch. |
| 2.8–4.65s | Source-backed evidence grows across all four sources. |
| 4.65–7.75s | Discovery grows, excludes incompatible roles, matches and shortlists three jobs. |
| 7.75–9.8s | The cover letter visibly writes itself beside the attached CV in Rolegain. |
| 9.8–11.35s | Show two evidence-based narrative answers and prefilled dropdowns. |
| 11.35–13.1s | Type the only missing answer and open the employer form. |
| 13.1–15.3s | Upload the same demo CV to the employer file control; show the transferred cover letter. |
| 15.3–17.95s | Show the completed custom questions and dropdowns, then click Apply. |
| 17.95–20s | Simulated confirmation and closing message. |

## Isolation and fidelity

The recording entry point imports the production `src/ui/App.tsx` and its styles. `recording.css` applies only to the film: it hides secondary panels, compacts spacing, and crops the view for readability. No production UI or backend files were modified.

`mock-ui.tsx` supplies fictional workspace data and intercepts every API request in memory. The renderer independently blocks all non-local network requests. The CV is a generated demo PDF, repository and article data are synthetic, employer URLs use reserved example domains, and `employer.html` is a local fictional form. Its submit handler only changes the local confirmation screen; it does not submit anything or send email. Evidence counts and match scores are illustrative fixtures, not product performance claims.

## Re-render

Run all commands from the repository root. Requires the repository's installed dependencies, Playwright Chromium and FFmpeg (`brew install ffmpeg` on macOS).

Start the isolated Vite server in one terminal:

```sh
npx vite --config video/rolegain-demo/vite.config.ts
```

Then render in another:

```sh
node video/rolegain-demo/render.mjs
node video/rolegain-demo/soundtrack.mjs
ffmpeg -y -i video/rolegain-demo/output/rolegain-how-it-works-v2-silent.mp4 -i video/rolegain-demo/output/original-score-v2.wav -map 0:v:0 -map 1:a:0 -c:v copy -af loudnorm=I=-22:TP=-2:LRA=7 -ar 48000 -c:a aac -b:a 192k -t 20 -movflags +faststart video/rolegain-demo/output/rolegain-how-it-works-v2.mp4
ffmpeg -y -ss 9.3 -i video/rolegain-demo/output/rolegain-how-it-works-v2.mp4 -frames:v 1 -q:v 2 video/rolegain-demo/output/poster-v2.jpg
```

Preview: http://127.0.0.1:5186/video/rolegain-demo/preview.html

The renderer verifies a 600-frame timeline, visible cursor targets, zero browser errors, zero external requests, the animated cover letter completing, all nine text/select fields matching the internally reviewed application, the PDF file attachment matching the demo CV name and size, and the simulated confirmation. Key shots are saved during rendering for visual inspection. Output media is ignored by Git.

The original exports are retained in `output/v1/`. Revision 2 adds the expanded ten-field application story.
