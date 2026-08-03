(() => {
  const api = "http://127.0.0.1:4317/api/job-search/employer-form";
  const employerUrl = () =>
    window.__ROLEGAIN_ORIGINAL_URL__ || location.href;
  const nativeFetch = window.fetch.bind(window);

  window.fetch = (input, init) => {
    const value =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    try {
      const target = new URL(value, location.href);
      if (
        /^ashbyhq-infra-prd-main-app-uploaded-files-[a-z0-9-]+\.s3(?:\.dualstack)?\.[a-z0-9-]+\.amazonaws\.com$/i.test(
          target.hostname,
        )
      )
        return nativeFetch(
          `${location.origin}/__job_apply_go_remote_fetch?url=${encodeURIComponent(target.toString())}`,
          init,
        );
    } catch {}
    return nativeFetch(input, init);
  };

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", prepareAutofill, { once: true });
  else void prepareAutofill();

  async function prepareAutofill() {
    const payload = await fetch(
      `${api}/autofill?url=${encodeURIComponent(employerUrl())}`,
    )
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null);
    if (!payload?.fields) return;
    await waitForEmployerForm(payload.fields);
    let filled = 0;
    const failures = [];
    for (const field of payload.fields) {
      if (!field.value || field.type === "file") continue;
      if (await fillField(field)) filled += 1;
      else failures.push(field.label || field.externalName || field.id);
    }
    if (payload.cv && await attachCv(payload.cv)) filled += 1;
    else if (payload.fields.some((field) => field.canonicalKey === "cv"))
      failures.push("Resume/CV");
    document.documentElement.dataset.rolegainFilled = String(filled);
    document.documentElement.dataset.rolegainFillFailures = JSON.stringify(failures);
  }

  async function waitForEmployerForm(fields) {
    const deadline = Date.now() + 15000;
    const externalNames = fields
      .map((field) => field.externalName)
      .filter(Boolean);
    while (Date.now() < deadline) {
      const found = externalNames.length
        ? externalNames.some((name) =>
            document.querySelector(
              `[data-field-path="${CSS.escape(name)}"]`,
            ),
          )
        : document.querySelector("form input, form textarea, form select");
      if (found) return;
      await delay(100);
    }
  }

  async function fillField(field) {
    let direct = findControl(field);
    let entry =
      direct?.closest(
        '[data-field-path], fieldset, .form-group, .field, [class*="question"], [class*="field"]',
      ) ||
      (field.externalName
        ? document.querySelector(
            `[data-field-path="${CSS.escape(field.externalName)}"]`,
          )
        : null);
    let root = entry || direct?.parentElement || document;
    const expected = normalize(field.value);

    if (field.canonicalKey === "cover_letter") {
      const manual = [...root.querySelectorAll("button")].find((button) =>
        /enter manually/i.test(button.textContent || ""),
      );
      if (manual && !root.querySelector("textarea")) {
        manual.click();
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline && !root.querySelector("textarea"))
          await delay(100);
        direct = findControl(field);
        entry =
          direct?.closest(
            '[data-field-path], fieldset, .form-group, .field, [class*="question"], [class*="field"]',
          ) || entry;
        root = entry || direct?.parentElement || root;
      }
    }

    const radios = [...root.querySelectorAll('input[type="radio"]')];
    const radio = radios.find((input) => {
      const label = input.id
        ? root.querySelector(`label[for="${CSS.escape(input.id)}"]`)
        : input.closest("label");
      return normalize(label?.textContent || input.value) === expected;
    });
    if (radio) {
      radio.click();
      radio.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }

    if (field.type === "select") {
      const checkboxes = [...root.querySelectorAll('input[type="checkbox"]')];
      if (checkboxes.length) {
        const wanted = String(field.value)
          .split(/\s*(?:,|;|\|)\s*/)
          .map(normalize)
          .filter(Boolean);
        let matched = 0;
        for (const input of checkboxes) {
          const label = input.id
            ? root.querySelector(`label[for="${CSS.escape(input.id)}"]`)
            : input.closest("label");
          const option = normalize(label?.textContent || input.value);
          const shouldCheck = wanted.some(
            (value) => option === value || option.includes(value) || value.includes(option),
          );
          if (input.checked !== shouldCheck) input.click();
          if (shouldCheck) matched += 1;
        }
        if (matched > 0) return true;
      }
    }

    const select = direct?.matches("select") ? direct : root.querySelector("select");
    if (select) {
      const option = [...select.options].find(
        (item) => normalize(item.textContent || item.value) === expected,
      );
      if (!option) return false;
      setNativeValue(select, option.value);
      return true;
    }

    const combobox = direct?.matches('[role="combobox"]')
      ? direct
      : root.querySelector('[role="combobox"]');
    if (combobox && await fillCombobox(combobox, root, field.value)) return true;

    if (field.type === "select") {
      const button = [...root.querySelectorAll("button")].find(
        (item) => normalize(item.textContent) === expected,
      );
      if (button) {
        button.click();
        return true;
      }
    }

    const control =
      (direct?.matches(
        'textarea, input:not([type="radio"]):not([type="file"]), select',
      )
        ? direct
        : null) ||
      root.querySelector(
        'textarea, input:not([type="radio"]):not([type="file"]), select',
      );
    if (!control) return false;
    if (field.type === "checkbox" || control.type === "checkbox") {
      const checked = /^(yes|true|1)$/i.test(field.value);
      if (control.checked !== checked) control.click();
      control.dispatchEvent(new Event("change", { bubbles: true }));
    } else setNativeValue(control, field.value);
    return verifyFilledValue(field, root, control);
  }

  function verifyFilledValue(field, root, control) {
    const expected = normalize(field.value);
    if (control?.type === "checkbox")
      return control.checked === /^(yes|true|1)$/i.test(field.value);
    if (control?.tagName === "SELECT") {
      const selected = control.options[control.selectedIndex];
      return normalize(selected?.textContent || control.value) === expected;
    }
    if ("value" in control) return normalize(control.value) === expected;
    const checked = root.querySelector(
      'input[type="radio"]:checked, input[type="checkbox"]:checked',
    );
    return Boolean(checked);
  }

  function findControl(field) {
    const external = String(field.externalName || "").trim();
    if (external) {
      const byDataPath = document.querySelector(
        `[data-field-path="${CSS.escape(external)}"] input, [data-field-path="${CSS.escape(external)}"] textarea, [data-field-path="${CSS.escape(external)}"] select, [data-field-path="${CSS.escape(external)}"] [role="combobox"]`,
      );
      if (byDataPath) return byDataPath;
      const byName = document.querySelector(
        `[name="${CSS.escape(external)}"]`,
      );
      if (byName) return byName;
      const byId = document.getElementById(external);
      if (byId?.matches("input, textarea, select, [role=combobox]")) return byId;
    }
    const expected = normalize(field.label || external);
    return [...document.querySelectorAll("input, textarea, select, [role=combobox]")].find(
      (control) => normalize(controlLabel(control)) === expected,
    );
  }

  function controlLabel(control) {
    const explicit = control.id
      ? document.querySelector(`label[for="${CSS.escape(control.id)}"]`)
      : null;
    const labelledBy = String(control.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent || "")
      .join(" ");
    return (
      explicit?.textContent ||
      control.closest("label")?.textContent ||
      control.closest("fieldset")?.querySelector("legend")?.textContent ||
      labelledBy ||
      control.getAttribute("aria-label") ||
      control.getAttribute("placeholder") ||
      control.getAttribute("name") ||
      ""
    );
  }

  async function fillCombobox(combobox, root, value) {
    combobox.click();
    if ("value" in combobox) setNativeValue(combobox, value);
    const expected = normalize(value);
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      await delay(200);
      const options = [
        ...document.querySelectorAll('[role="option"]'),
        ...root.querySelectorAll('[role="menuitem"]'),
      ];
      const exact = options.find(
        (option) => normalize(option.textContent) === expected,
      );
      const close = options.find((option) => {
        const candidate = normalize(option.textContent);
        return candidate.includes(expected) || expected.includes(candidate);
      });
      const selected = exact || close;
      if (selected) {
        selected.click();
        await delay(100);
        return true;
      }
    }
    if ("value" in combobox) {
      combobox.dispatchEvent(new Event("blur", { bubbles: true }));
      return Boolean(combobox.value);
    }
    return false;
  }

  async function attachCv(cv) {
    const input = document.querySelector(
      'input[type="file"][required], input[type="file"]#_systemfield_resume, input[type="file"][name*="resume" i], input[type="file"][name*="cv" i]',
    );
    if (!input) return false;
    const response = await fetch(`http://127.0.0.1:4317${cv.url}`).catch(
      () => null,
    );
    if (!response?.ok) return false;
    const file = new File([await response.blob()], cv.name, {
      type: response.headers.get("content-type") || "application/pdf",
    });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function normalize(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function setNativeValue(control, value) {
    const prototype =
      control instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : control instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    setter?.call(control, value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
  }
})();
