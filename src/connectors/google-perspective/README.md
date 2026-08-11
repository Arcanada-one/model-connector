# Google Perspective API dormant contract

This directory is the isolated CONN-0291 / AU-034 contract adapter for Google
Perspective API. It is intentionally unregistered and has no module, barrel
export, default HTTP client, environment lookup, credential discovery, retry,
redirect, endpoint override, or production activation path.

Lifecycle evidence accessed 2026-07-20 states that Perspective is sunsetting,
new usage and quota requests closed after February 2026, and service remains
active only through December 31, 2026. The connector therefore describes
existing authorized access only and rejects execution from 2027-01-01 UTC. That
guard is a connector safety boundary, not a provider protocol response.

The adapter models only:

```text
POST https://commentanalyzer.googleapis.com/v1alpha1/comments:analyze?key=...
```

`SuggestCommentScore` is excluded because it contributes correction scores as
training data rather than performing AU-034 text-safety inference. TOXICITY is
the only current-proven attribute frozen here. Caller languages are rejected
because the current authoritative supported-language catalogue could not be
recovered; omission retains documented provider auto-detection.

Construction requires an explicit API key, injected transport, and injected
clock. Tests use only an in-memory transport. Injecting a real transport would
be a separate prohibited integration action and is not evidence of safe or
current provider callability.

`doNotStore: true` is the default. Sending false or omitting the field requires
the explicit `allowProviderStorage` construction opt-in. Google documents that
omission/false may permit storage of comment/context for debugging. The flag is
not represented as zero processing, zero logging, metadata deletion, residency,
retention-duration, or compliance proof.

Scores retain their documented type and numeric value. They are perceived-impact
model outputs, not objective truth, a character judgment, or an automated
moderation decision. Span offsets are preserved as optional paired UTF-16 ranges
with exclusive end.

All request/response depth, width, string, array, serialized-byte, timeout, and
response-byte ceilings in this directory are connector-local defensive limits.
They are not Perspective quotas or provider limits. Errors never return the API
key, URL/query, comment/context, identifiers, provider message/details/body, or
transport cause.

First-party sources:

- https://www.perspectiveapi.com/
- https://developers.google.com/codelabs/setup-perspective-api
- https://raw.githubusercontent.com/googleapis/google-api-go-client/main/commentanalyzer/v1alpha1/commentanalyzer-api.json
- https://googleapis.dev/dotnet/Google.Apis.CommentAnalyzer.v1alpha1/latest/api/Google.Apis.CommentAnalyzer.v1alpha1.Data.AnalyzeCommentRequest.html
- https://github.com/conversationai/perspectiveapi/blob/main/model-cards/English/toxicity.md
