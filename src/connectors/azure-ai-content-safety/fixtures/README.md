# CONN-0289 synthetic fixture provenance

Every JSON provider response in this directory was handwritten on 2026-07-20 from the response shapes in Microsoft’s `2024-09-01` Analyze Text and Analyze Image REST references. They are deterministic synthetic examples, not Azure captures. No provider SDK, API, account, credential, endpoint, or live/paid request was used.

The transparent 50×50 PNG input embedded in the spec is synthetic local test data, not a provider response. Its documented deterministic recipe is:

`sharp({create:{width:50,height:50,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).png({compressionLevel:9,adaptiveFiltering:false})`

Fixture content deliberately uses only synthetic identifiers and text. The error fixture includes fake sensitive-looking values solely to prove bounded redaction.
