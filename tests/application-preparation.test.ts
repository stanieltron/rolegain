import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import type { ApplicationDraft } from "../src/contracts/job-search.js";
import {
  APPLICATION_OPEN_CONTROL_NAME,
  applicationFieldSetLooksCredible,
  auditApplicationFieldMapping,
  applicationControlSelector,
  canonicalFieldKey,
  extractLogicalApplicationForm,
  isGenericWorkplaceLocation,
  observeRenderedApplicationForm,
  preserveStructuralCanonicalKey,
} from "../src/03-match/02-application-inspection/index.js";
import { applicationIsPreparedForVerification } from "../src/backend/control-flow/service.js";

function application(
  overrides: Partial<ApplicationDraft> = {},
): ApplicationDraft {
  return {
    id: "app-test",
    jobId: "job-test",
    status: "needs_input",
    coverLetter: "",
    coverLetterChat: [],
    formFields: [
      {
        id: "email-1",
        externalName: "email",
        label: "Email",
        type: "email",
        value: "candidate@example.test",
        required: true,
        source: "profile",
        confidence: 100,
      },
    ],
    missingQuestions: [],
    adapter: "generic",
    liveFormValidated: true,
    formSchema: {
      observedQuestionCount: 1,
      mappedQuestionCount: 1,
      fingerprint: "schema-test",
      issues: [],
      verifiedByAgent: true,
    },
    updatedAt: "2026-07-15T00:00:00.000Z",
    ...overrides,
  };
}

describe("application preparation safeguards", () => {
  it("locates numeric and bracketed employer field identifiers safely", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(`
        <input id="4000864004" />
        <select name="question_36806336002[]"><option>Yes</option></select>
      `);
      expect(
        await page.locator(applicationControlSelector("4000864004")).count(),
      ).toBe(1);
      expect(
        await page
          .locator(applicationControlSelector("question_36806336002[]"))
          .count(),
      ).toBe(1);
    } finally {
      await browser.close();
    }
  });

  it("opens direct and outbound employer application controls without treating submit as navigation", () => {
    for (const label of [
      "Apply for this Job",
      "Apply here",
      "I'm interested",
      "Visit job opening page",
      "Go to job page",
      "Apply on employer website",
    ])
      expect(APPLICATION_OPEN_CONTROL_NAME.test(label)).toBe(true);
    expect(APPLICATION_OPEN_CONTROL_NAME.test("Submit application")).toBe(
      false,
    );
    expect(APPLICATION_OPEN_CONTROL_NAME.test("Connect Wallet to Apply")).toBe(
      false,
    );
  });

  it("blocks verification unless a non-empty coherent live form was mapped", () => {
    expect(applicationIsPreparedForVerification(application())).toBe(true);
    expect(
      applicationIsPreparedForVerification(
        application({ liveFormValidated: false }),
      ),
    ).toBe(false);
    expect(
      applicationIsPreparedForVerification(application({ formFields: [] })),
    ).toBe(false);
    const duplicate = application().formFields[0];
    expect(
      applicationIsPreparedForVerification(
        application({ formFields: [duplicate, { ...duplicate }] }),
      ),
    ).toBe(false);
    expect(
      applicationIsPreparedForVerification(
        application({ formSchema: undefined }),
      ),
    ).toBe(false);
    const first = application().formFields[0];
    expect(
      applicationIsPreparedForVerification(
        application({
          formFields: [
            first,
            {
              ...first,
              id: "optional-eeo-2",
              label: "Optional self identification",
              required: false,
            },
          ],
          formSchema: {
            observedQuestionCount: 3,
            mappedQuestionCount: 2,
            fingerprint: "schema-advisory-agent",
            issues: [],
            verifiedByAgent: false,
          },
        }),
      ),
    ).toBe(true);
  });

  it("does not mistake a job-board search box or newsletter email for an application", () => {
    const field = (label: string, inputType = "text") => ({
      label,
      externalName: label.toLowerCase().replace(/\s+/g, "-"),
      tag: "input",
      inputType,
      placeholder: "",
      required: false,
      options: [],
      hasCombobox: false,
      allowsManualEntry: false,
    });
    expect(
      applicationFieldSetLooksCredible([
        field("Search job titles or companies"),
        field("Location search"),
      ]),
    ).toBe(false);
    expect(applicationFieldSetLooksCredible([field("Email", "email")])).toBe(
      false,
    );
    expect(
      applicationFieldSetLooksCredible([
        field("Full name"),
        field("Email", "email"),
      ]),
    ).toBe(true);
    expect(
      applicationFieldSetLooksCredible([field("Upload Resume/CV", "file")]),
    ).toBe(true);
  });

  it("extracts Ashby custom questions once, including required button and checkbox groups", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(`
        <form class="ashby-application-form-container">
          <div data-field-path="visa">
            <div class="ashby-application-form-question-title">Will you require visa sponsorship? *</div>
            <button type="button">Yes</button><button type="button">No</button>
          </div>
          <div data-field-path="source">
            <div class="ashby-application-form-question-title">How did you hear about us? *</div>
            <label><input type="checkbox" value="Website" />Website</label>
            <label><input type="checkbox" value="Other" />Other</label>
          </div>
        </form>
      `);
      const { entries } = await extractLogicalApplicationForm(page);
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({
        externalName: "visa",
        required: true,
        inputType: "radio",
        options: ["Yes", "No"],
      });
      expect(entries[1]).toMatchObject({
        externalName: "source",
        required: true,
        inputType: "checkbox",
        options: ["Website", "Other"],
      });
    } finally {
      await browser.close();
    }
  });

  it("preserves Greenhouse upload labels and recognizes manual cover-letter entry", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(`
        <form class="application-form">
          <div class="form-group"><label for="resume">Resume/CV *</label><input id="resume" name="resume" type="file" required /></div>
          <div class="form-group"><label for="cover">Cover Letter</label><input id="cover" name="cover" type="file" /><button type="button">Enter manually</button></div>
          <div class="form-group"><label for="email">Email *</label><input id="email" name="email" type="email" required /></div>
        </form>
      `);
      const { entries } = await extractLogicalApplicationForm(page);
      expect(entries).toHaveLength(3);
      expect(entries[0]).toMatchObject({
        label: "Resume/CV *",
        inputType: "file",
        required: true,
      });
      expect(entries[1]).toMatchObject({
        label: "Cover Letter",
        inputType: "file",
        allowsManualEntry: true,
      });
    } finally {
      await browser.close();
    }
  });

  it("preserves every rendered LaborX-style anonymous control for the form-reading agent", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(`
        <form class="application-form">
          <div class="form-field with-label">
            <div class="input-label">First Name<div class="required-marker"></div></div>
            <div class="input-container"><input placeholder="Not specified" /></div>
          </div>
          <div class="form-field with-label">
            <div class="input-label">Last Name<div class="required-marker"></div></div>
            <div class="input-container"><input placeholder="Not specified" /></div>
          </div>
          <div class="form-field with-label">
            <div class="input-label">Email<div class="required-marker"></div></div>
            <div class="input-container"><input placeholder="Not specified" /></div>
          </div>
          <div class="form-field with-label">
            <div class="input-label">Resume/CV<div class="required-marker"></div></div>
            <label class="uploaded-bound"><input type="file" name="image" style="display:none" />Drag and drop file here</label>
            <textarea placeholder="Not specified"></textarea>
            <span>or enter manually</span>
          </div>
          <div class="form-field with-label">
            <div class="input-label">How did you hear about this position?<div class="required-marker"></div></div>
            <div class="multiselect" tabindex="0">
              <span class="multiselect__placeholder">Choose</span>
              <span class="multiselect__option">LinkedIn</span>
              <span class="multiselect__option">Referral</span>
            </div>
          </div>
        </form>
      `);
      const controls = await observeRenderedApplicationForm(page);
      expect(controls).toHaveLength(6);
      expect(controls.map((field) => field.browserControlIds?.[0])).toEqual([
        "rolegain-control-1",
        "rolegain-control-2",
        "rolegain-control-3",
        "rolegain-control-4",
        "rolegain-control-5",
        "rolegain-control-6",
      ]);
      expect(controls[0]).toMatchObject({
        label: "First Name",
        placeholder: "Not specified",
        required: true,
      });
      expect(controls[3].nearbyText).toContain("Resume/CV");
      expect(controls[4].nearbyText).toContain("Resume/CV");
      expect(controls[5]).toMatchObject({
        inputType: "select",
        required: true,
        options: ["LinkedIn", "Referral"],
      });
    } finally {
      await browser.close();
    }
  });

  it("blocks required mapping defects without letting optional ATS fields block the form", () => {
    const observed = [
      {
        label: "Visa sponsorship?",
        externalName: "visa",
        tag: "button",
        inputType: "radio",
        placeholder: "",
        required: true,
        options: ["Yes", "No"],
        hasCombobox: false,
        allowsManualEntry: false,
      },
    ];
    expect(auditApplicationFieldMapping(observed, [])).toContain(
      "Visa sponsorship?: required employer question was not mapped uniquely",
    );
    expect(
      auditApplicationFieldMapping(observed, [
        {
          id: "visa-1",
          externalName: "visa",
          label: "Visa sponsorship?",
          type: "select",
          value: "",
          required: false,
          source: "user",
          confidence: 0,
          options: ["Yes", "No"],
        },
      ]),
    ).toContain("Visa sponsorship?: required status was not preserved");
    expect(
      auditApplicationFieldMapping(
        [{ ...observed[0], label: "Optional EEO", externalName: "eeo", required: false }],
        [],
      ),
    ).toEqual([]);
  });

  it("keeps physical location and education components distinct from preferences", () => {
    expect(isGenericWorkplaceLocation("Remote")).toBe(true);
    expect(isGenericWorkplaceLocation("Kosice, Slovakia")).toBe(false);
    expect(canonicalFieldKey("Location (City)*", "candidate-location")).toBe(
      "city",
    );
    expect(
      canonicalFieldKey(
        "What state do you currently reside in?*",
        "question-state",
      ),
    ).toBe("state");
    expect(
      canonicalFieldKey("From which country will you work?", "location"),
    ).toBe("country");
    expect(canonicalFieldKey("Start date year", "start-year--0")).toBe(
      "education_start_year",
    );
    expect(canonicalFieldKey("Notice Period", "notice-period")).toBe(
      "notice_period",
    );
    expect(canonicalFieldKey("Are you Hispanic/Latino?", "ethnicity")).toBe(
      "eeoc_ethnicity",
    );
    expect(
      preserveStructuralCanonicalKey(
        {
          id: "race",
          externalName: "eeo[race]",
          label: "Race",
          type: "select",
          value: "",
          required: false,
          source: "user",
          confidence: 0,
        },
        "eeoc_ethnicity",
      ),
    ).toBe("eeoc_race");
    expect(
      canonicalFieldKey(
        "Race Select ... Hispanic or Latino White (Not Hispanic or Latino)",
        "eeo[race]",
      ),
    ).toBe("eeoc_race");
    expect(
      preserveStructuralCanonicalKey(
        {
          id: "degree",
          externalName: "degree--0",
          canonicalKey: "degree",
          label: "Degree",
          type: "select",
          value: "",
          required: false,
          source: "user",
          confidence: 0,
        },
        "education_end_year",
      ),
    ).toBe("degree");
  });
});
