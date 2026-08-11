# Bedrock Guardrails offline extension

CONN-0290 implements exactly seven current Amazon Bedrock Guardrails REST contracts: six regional control-plane CRUD/list operations and runtime `ApplyGuardrail`. It is intentionally not registered and does not modify or import the completed Bedrock inference connector.

The client requires explicit region, signer, and transport injections. It has no AWS SDK, credential discovery, metadata-service lookup, endpoint override, redirect handling, retry loop, or default network transport. Both regional DNS planes use the SigV4 signing service name `bedrock`; `ApplyGuardrail` alone uses the `bedrock-runtime.{region}.amazonaws.com` hostname.

The signer receives the immutable request plus region/service/operation metadata and may return signed headers only. The client keeps the exact URL, method, and body it validated. The transport is likewise injected and receives `redirect: 'manual'`.

IAM uses the `bedrock` service prefix. Each operation requires its same-named `bedrock:*` permission. Creating with tags additionally requires `bedrock:TagResource`. Independently applying a guardrail generally requires `bedrock:ApplyGuardrail`; a guardrail configured with Automated Reasoning also requires the separately documented `bedrock:InvokeAutomatedReasoningPolicy` permission for its versioned policy resource. Cross-Region guardrail profiles can impose additional destination-profile permissions. The client does not evaluate IAM policy or claim that one permission set works for every guardrail configuration.

Tests use only handwritten deterministic synthetic responses documented in `fixtures/README.md`. Image inputs are represented only as the documented PNG/JPEG base64-byte form, with local byte, signature, dimension, and count checks. This representation is not a claim of universal image-filter availability across regions, policies, categories, or accounts.
