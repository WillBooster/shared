# @willbooster/shared-lib

`recoverJson(response)` extracts JSON candidates from text and Markdown without runtime dependencies. It repairs common syntax errors and recovers partial strings and containers. Each candidate includes its parsed `value`, serialized `json`, original `start`/`end` offsets, and `repairs` with original UTF-16 offsets. The range includes consumed source, such as removed scalar trailing comments; use `json` or `value`, not the source slice, for parsing.

```ts
import { recoverJson } from '@willbooster/shared-lib';

const recovered = recoverJson(response);
// Show recovered candidates to an operator, including their repair annotations.
// Before automated action, validate your schema and check the conditions below.
```

`requiresConfirmation` marks incomplete or ambiguous repairs, including duplicate keys. A false value does not establish that an answer is correct or that the provider finished: callers must also check provider termination, extraction errors, multiple candidates, and their domain schema. Recovery never translates domain values or supplies missing evidence. Missing values are represented by JSON `null` with an incomplete repair annotation.

Unknown escape sequences and stray quotes inside unquoted keys retain their literal characters and require confirmation. Scalar extraction may omit same-line prose prefixes; a scalar retained with trailing non-comment content requires confirmation. Malformed numeric/keyword atoms such as `42.` or `true;` retain their spelling as uncertain strings, rather than guessing a number or boolean. Trailing supported comments are removed with provenance.

Markdown boundaries delimit partial answers. Literal fence lines inside a string are retained across those boundaries only when the extended document otherwise needs no repair except escaping raw control characters; that interpretation also requires confirmation. After a rejected document, extraction resumes only at an established lexical container boundary or a new Markdown region; it does not promote nested members of an unbalanced rejected document into standalone answers.

Inputs above one million UTF-16 code units and nesting above 128 levels produce errors. At most 32 candidates/errors are returned. JSONP, MongoDB constructors, and arbitrary JavaScript expressions are outside this API's scope. Upstream implementation and test attribution is included in `NOTICE`.
