export const recommendation =
  "We recommend introducing a guided checklist for new teams so that they can get a useful result before they are asked to configure the entire workspace. The checklist should focus on creating one project, inviting one teammate, and completing one shared task. Advanced settings can wait until the team has a reason to use them."
export const conciseRecommendation =
  "Help new teams get a useful result with three steps: create a project, invite a teammate, and complete a shared task. Introduce advanced settings when they become relevant."
export const documentHtml =
  "<h1>Make the first week count</h1><p>A focused onboarding experience for teams that want to start working, not spend their first day configuring software.</p><h2>Recommendation</h2><p>" +
  recommendation +
  "</p><h2>What changes</h2><ul><li><p>Replace the setup wizard with a short, persistent checklist.</p></li><li><p>Let teams start with a realistic sample project.</p></li><li><p>Keep optional integrations out of the first-run path.</p></li></ul><h2>How we’ll know</h2><p>Measure the share of new teams that complete a shared task in their first week. Pair that with time to first result and the number of setup-related support requests.</p><h2>Rollout</h2><p>Start with a small group of new workspaces. Review their first-week experience before expanding the rollout. Keep the current setup flow available during the pilot.</p>"
export const documentText = documentHtml.replace(/<[^>]*>/g, "")
export const longDocumentHtml =
  documentHtml +
  Array.from(
    { length: 16 },
    (_, i) =>
      "<h2>Pilot checkpoint " +
      (i + 1) +
      "</h2><p>Review the first-week experience with the product team. Capture obstacles, compare the time to first shared result, and adjust the checklist before expanding the rollout.</p>",
  ).join("")
