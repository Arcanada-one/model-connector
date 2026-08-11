# Amazon Bedrock connector

The `bedrock` connector calls the non-streaming Amazon Bedrock Runtime Converse API at the regional HTTPS endpoint `https://bedrock-runtime.{region}.amazonaws.com`.

## Configuration

```dotenv
BEDROCK_REGION=us-east-1
BEDROCK_MODELS=amazon.nova-lite-v1:0,anthropic.claude-3-5-sonnet-20241022-v2:0
```

`BEDROCK_MODELS` is the deterministic catalog for this connector. Entries are trimmed and de-duplicated in their configured order. The connector does not call a model-list API.

## Identity boundary

The connector does not accept or discover AWS credentials. Its host must override the exported `BEDROCK_SIGNER` Nest token with an asynchronous signer matching this contract:

```ts
type BedrockSigner = (request: {
  method: 'POST';
  url: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<{
  method: 'POST';
  url: string;
  headers: Record<string, string>;
  body: string;
}>;
```

The signer receives the complete serialized request. Model Connector sends exactly the URL, method, headers, and body returned by the signer, because changing them afterward would invalidate SigV4. Without an injected signer, execution fails closed; there is no AWS SDK credential fallback.

## Request mapping

- A text `prompt` becomes a user message with a text content block.
- `systemPrompt` becomes a Bedrock system text block.
- `extra.max_tokens`, `temperature`, `top_p`, and string-array `stop` map to Converse `inferenceConfig`.
- The raw model ID is percent-encoded once as a single segment in `/model/{modelId}/converse`.

Successful Converse text blocks and token usage are mapped to the standard Model Connector response. AWS validation, access, missing-model, throttling, timeout, and server failures are normalized to existing connector error types.

## Limitations

- Text prompts only.
- No runtime model discovery or pricing lookup.
- No credential loading or live identity probe.
- `ConverseStream` is not implemented; capabilities report `supportsStreaming: false`.

Transport tests use a fake signer and mocked fetch only. They do not require AWS credentials or network access.
