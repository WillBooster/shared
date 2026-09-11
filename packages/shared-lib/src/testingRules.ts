/**
 * When to write a test and what a test may assert, as markdown bullets for an agent's instructions.
 * Stated once here and rendered by the generated agent instructions and the testing skill so the
 * two cannot drift apart.
 */
export const TEST_WRITING_RULES = `- Write a test only when explicitly requested, or when a behavior is likely to regress and no existing automatic check (type checking, linting, an existing test or CI check) would catch the breakage. Never add a test that merely restates a mapping from conditions to constant outputs (it fails only on intentional edits) or that only confirms an external fact (a library's behavior, whether a version fixes an issue); verify those once manually.
- Test externally observable behavior (e.g., emitted files, CLI output, rendered results) at the system boundary, not implementation details: do not mirror production logic, assert that a branch is taken, or feed hand-assembled internal objects to internal functions.
- Prefer actual API calls over mocks, unless actual calls are impractical, have unintended side effects, or mocks are explicitly requested.
- Ensure tests are idempotent and independent (e.g., reset persistent data) so they can run repeatedly or in parallel.
- Avoid fixed waits in E2E tests; wait for conditions instead.`;
