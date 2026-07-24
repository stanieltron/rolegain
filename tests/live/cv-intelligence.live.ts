import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CodexCandidateAnalyzer } from "../../src/01-evidence-ingestion/evidence-ingestion.js";
import { CodexExecClient } from "../../src/codex-runtime/client.js";
import { JobSearchService } from "../../src/backend/control-flow/service.js";

const root = await mkdtemp(path.join(tmpdir(), "rolegain-live-cv-"));
const codex = new CodexExecClient();
try {
  const service = new JobSearchService(root, new CodexCandidateAnalyzer(codex, process.cwd()));
  await service.initialize();
  await service.updateProfile({
    name: "Nina Novak",
    email: "nina.novak@example.test",
    location: "Bratislava, Slovakia",
  });
  await service.addSource({
    kind: "cv",
    name: "nina-novak-cv.txt",
    content: `Nina Novak
nina.novak@example.test | +421 900 111 222 | Bratislava, Slovakia

SENIOR SOFTWARE ENGINEER
Eight years building TypeScript and Node.js platforms for developer teams.

EXPERIENCE
Platform Engineer, Northstar Systems, 2021-present
- Built a multi-tenant TypeScript workflow service processing 600,000 jobs monthly.
- Reduced failed deployments by 35% through automated validation and rollback controls.

Software Engineer, River Labs, 2018-2021
- Developed Node.js APIs and React administration tools.

SKILLS
TypeScript, Node.js, React, PostgreSQL, Docker, distributed systems

EDUCATION
BSc Computer Science, Comenius University, 2018`,
  });
  const workspace = await service.analyzeCandidate();
  console.log(JSON.stringify({
    status: workspace.intelligence.status,
    threadId: workspace.intelligence.threadId,
    headline: workspace.profile.headline,
    skills: workspace.profile.skills,
    sourceInsights: workspace.sources[0].insights.map((item) => item.title),
    finalCvLength: workspace.finalCv.length,
    error: workspace.intelligence.error,
  }, null, 2));
  if (workspace.intelligence.status !== "ready" || !workspace.intelligence.threadId || workspace.sources[0].insights.length === 0 || workspace.finalCv.length < 100) process.exitCode = 1;
} finally {
  await codex.close();
  await rm(root, { recursive: true, force: true });
}
