# @willbooster/shared-lib

`recoverJson(response)` extracts JSON candidates from text and Markdown without runtime dependencies. It repairs common syntax errors and recovers partial strings and containers. Each candidate includes its parsed `value`, serialized `json`, original `start`/`end` offsets, and `repairs` with original UTF-16 offsets.

```ts
import { recoverJson } from '@willbooster/shared-lib';

const recovered = recoverJson(response);
// Show recovered candidates to an operator, including their repair annotations.
// Before automated action, validate your schema and check the conditions below.
```

`requiresConfirmation` marks incomplete or ambiguous repairs, including duplicate keys. A false value does not establish that an answer is correct or that the provider finished: callers must also check provider termination, extraction errors, multiple candidates, and their domain schema. Recovery never translates domain values or supplies missing evidence. Missing values are represented by JSON `null` with an incomplete repair annotation.

Inputs above one million UTF-16 code units and nesting above 128 levels produce errors. At most 32 candidates/errors are returned. JSONP, MongoDB constructors, and arbitrary JavaScript expressions are outside this API's scope. Upstream implementation and test attribution is included in `NOTICE`.
