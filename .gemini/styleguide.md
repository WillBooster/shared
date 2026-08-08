Review in English based on the following coding standards.

## Coding Style

- Use camelCase file names for JavaScript/TypeScript (PascalCase for React components).
- Simplify code as much as possible to eliminate redundancy.
- Design modules and directories with high cohesion and low coupling; split large modules when needed.
- Place calling functions above the functions they call (top-down order); place variable and type declarations above their usage.
- Write comments and JSDoc only for hard-to-understand code: explain "why" in comments and "what" in JSDoc.
- If lint errors or warnings cannot be fixed, use ignore comments with reasons (e.g., `// oxlint-disable-next-line <rule> -- <reason>`).
- Prefer `undefined` over `null` unless required by APIs or libraries.
- Build prompts as a single template literal instead of `join()` on a pre-computable array of strings.
- Assume all environment variables are defined; if validation is needed, `assert` at startup to fail fast.
- Assume local tools such as `git`, `gh`, and `ghq` are installed and authenticated.
- Ensure compatibility only with macOS and Linux; do not include Windows-specific code.
- Use `project.env` instead of `process.env` in the `wb` package.
- Always drop any Windows support.
- `wbfy` targets WillBooster / WillBoosterLab repositories; others are best-effort.
- Simplify implementation to the extreme:
  - Whenever a problem can be solved either by code or by an operational rule (a constraint on developers or target repositories), choose the rule.
  - Handle an edge case only after confirming it actually occurs on real machines or in WillBooster / WillBoosterLab repositories (e.g., a symlinked `.npmrc`); otherwise omit the code.
- `wbfy` re-configures its own previous output: support exactly one canonical format per file, and on deviating input, fail fast, overwrite with canonical output, or skip it with a warning — never partially accommodate it. Never add fallback, auto-detection, compatibility, or migration code for hand-written, legacy, or third-party files; fix such files manually in the target repository instead.
- `docs/expected-repository-rules.md` lists the rules `wbfy` and `wb` expect of target repositories; update it in the same change when adding or relying on a new expectation.
