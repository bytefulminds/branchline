import axe from "axe-core";
import { expect } from "vitest";

/**
 * Run axe-core on the whole document and fail with a readable list of violations.
 * Contrast and target size need real layout, so they are reviewed by hand
 * (docs/accessibility.md).
 */
export async function audit(label: string) {
  const result = await axe.run(document.body, {
    rules: {
      // Need real layout and colors; reviewed by hand (docs/accessibility.md).
      "color-contrast": { enabled: false },
      "target-size": { enabled: false },
    },
    resultTypes: ["violations"],
  });
  const problems = result.violations.map(
    (v) =>
      `${label}: ${v.id} (${v.impact}) ${v.help}\n` +
      v.nodes.map((n) => `    ${n.target.join(" ")}: ${n.failureSummary}`).join("\n"),
  );
  expect(problems, problems.join("\n")).toEqual([]);
}
