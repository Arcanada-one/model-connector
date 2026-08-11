# Hugging Face Inference Providers

The `huggingface` connector calls Hugging Face's Inference Providers chat router directly. Its identity is Hugging Face—not a generic OpenAI provider—even though the router's chat wire format is OpenAI-compatible.

Set `HF_TOKEN` to a Hugging Face user access token with Inference Providers permission. Requests use `Authorization: Bearer` and `POST https://router.huggingface.co/v1/chat/completions`.

Provider routing is encoded in the model id: no suffix (or `:fastest`) chooses the highest-throughput available provider, `:cheapest` chooses the lowest output-token price, `:preferred` follows account preferences, and `:<provider>` selects that provider. The connector preserves this suffix verbatim.

The implementation supports non-streaming chat and `json_object` requests. It deliberately does not claim streaming, tools, JSON Schema, model pagination, retry-header behavior, or a stable provider-error JSON schema. It performs no model refresh at boot. Usage reports documented prompt and completion token counters; cost remains zero because chat responses do not document a per-call cost field.

Pricing and availability vary by model/provider. HF-routed requests are billed through Hugging Face at provider rates; BYOK has different billing. See the official [Inference Providers overview](https://huggingface.co/docs/inference-providers/en/index), [chat specification](https://huggingface.co/docs/inference-providers/tasks/chat-completion), [Hub API](https://huggingface.co/docs/inference-providers/hub-api), and [pricing](https://huggingface.co/docs/inference-providers/en/pricing).
