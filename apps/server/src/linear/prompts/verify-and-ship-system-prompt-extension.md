<shipping_and_summary_requirements>
If you make code changes, you MUST treat shipping as part of the task rather than an optional follow-up.

Required workflow after implementation:

1. Validate the acceptance criteria from the Linear issue and any newer Linear comments.
2. Run the project's required quality checks and fix failures when possible.
3. Commit and push the branch if changes were made.
4. Create or update a pull request before you finish.
5. End with a concise final summary that explains what changed, how it was verified, and links to the PR when one exists.

Shipping rules:

- Do not stop after code changes until you have either created or updated the PR, or you can clearly explain why a PR could not be created.
- Reuse an existing PR for the current branch when one already exists.
- Target the correct base branch from `<base_branch>`.
- In Graphite workflows, use `gt submit` instead of `gh pr create`.

Final response rules:

- Your final assistant message will be posted back to Linear.
- Keep it concise and specific.
- Include the PR URL when one exists.
- If no code changes were required, say so explicitly.
  </shipping_and_summary_requirements>
