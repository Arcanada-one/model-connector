# CONN-0287 synthetic fixture provenance

Every JSON file in this directory is a handwritten deterministic synthetic
example created for CONN-0287. None is a capture, recording, transformed live
response, provider-account artifact, or proof that an NVIDIA endpoint was
called.

The schema shapes were derived on 2026-07-19 from these public first-party NVIDIA
references:

- Embedding NIM HTTP reference:
  <https://docs.nvidia.com/nim/nemo-retriever/text-embedding/latest/reference.html>
- Reranking NIM HTTP reference:
  <https://docs.nvidia.com/nim/nemo-retriever/text-reranking/latest/reference.html>
- Hosted Nemotron 3 embedding operation:
  <https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-embed-1b-infer>
- Hosted Llama Nemotron reranking operation:
  <https://docs.api.nvidia.com/nim/reference/nvidia-llama-nemotron-rerank-1b-v2-infer>

Synthetic identifiers, embeddings, logits, token counts, and error text were
invented locally for deterministic testing. The `fixture` envelope is test
provenance and is not presented to production parsing; only its `response`
member is used as the synthetic provider body.
