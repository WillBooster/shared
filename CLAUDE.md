## Project Information

- Name: willbooster-shared
- Description: undefined
- Package Manager: yarn

## General Instructions

- After making code changes, run `yarn check-for-ai` to perform type checking and linting.
- Once you have checked your changes, commit them to the current branch using the `--no-verify` option. Make sure to add a new line at the end of your commit message with: `Co-authored-by: WillBooster (Claude Code) <agent@willbooster.com>`.
- When your work is fully complete, run `yarn check-all-for-ai` to execute all tests (note: this may take up to 30 minutes).
  - To run e2e tests, you ALWAYS MUST run `yarn check-all-for-ai` since `check-all-for-ai` does some preparation work for e2e tests.

## Coding Style

- When adding new functions or classes, define them below any functions or classes that call them to maintain clear call order.
- Use `project.env` instead of `process.env` on `wb` package.
