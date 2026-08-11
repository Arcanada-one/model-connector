# CONN-0291 synthetic Perspective fixtures

These files are handwritten deterministic synthetic JSON created on 2026-07-20
for offline contract tests. They were never captured, replayed, copied, or
derived from a live Google Perspective response. No Perspective endpoint,
account, API key, provider request, or paid service was used.

The invented text, identifiers, language strings, codes, and scores are test
data. They are not evidence of provider output, current callability, supported
languages, moderation policy, quota, reliability, or score quality.

Schema references accessed 2026-07-20 UTC:

- Google-generated discovery schema:
  https://raw.githubusercontent.com/googleapis/google-api-go-client/main/commentanalyzer/v1alpha1/commentanalyzer-api.json
- Google AnalyzeCommentRequest client reference:
  https://googleapis.dev/dotnet/Google.Apis.CommentAnalyzer.v1alpha1/latest/api/Google.Apis.CommentAnalyzer.v1alpha1.Data.AnalyzeCommentRequest.html
- Official TOXICITY model card:
  https://github.com/conversationai/perspectiveapi/blob/main/model-cards/English/toxicity.md

| Fixture | Purpose | SHA-256 |
|---|---|---|
| `analyze-success.synthetic.json` | Exercise documented Analyze response maps, summary score, paired and full-text span scores, echoed client token, and language response fields. | `d324c19ce88db23eccb9af512741fefbff6b0e58f393224d9e553bf497a574ac` |
| `provider-error.synthetic.json` | Exercise bounded Google error-envelope parsing and redaction of a synthetic key, URL, comment, message, and details. | `91e531b3a053bc67e13d106b32523f1f9e88399bc0c5b1371c9e60d716f81c6c` |

Any fixture edit requires updating this table and the hash assertions in
`google-perspective.connector.spec.ts` in the same RED specification commit.
