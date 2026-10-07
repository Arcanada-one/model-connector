# DeepSeek thinking options

The `deepseek` execute adapter forwards an explicit mode on the requested model:

```json
{
  "connector": "deepseek",
  "model": "deepseek-flash",
  "prompt": "Return a number",
  "extra": { "thinking": { "type": "disabled" }, "temperature": 0 }
}
```

`extra.thinking` accepts exactly `{ "type": "enabled" }` or
`{ "type": "disabled" }`. Unknown fields, other types and null refuse before
outbound transport. Omitting thinking preserves the existing provider default.
The adapter does not change model aliases, prices, prompts or sampling defaults.
Numeric temperature zero is preserved. Extra fields are never spread into the body.

When thinking is enabled or omitted, `extra.reasoning_effort` accepts `low`, `high`
or `max`. The shared MC `effort` maps explicitly: `low` to `low`, `medium` to `high`,
and `high` to `high`. Providing both effort fields requires them to agree after
this mapping. Disabled thinking with either effort field refuses as
`validation_error` with no retry. The universal DTO validates these options only
for DeepSeek. Once the service resolves a provider, it validates DeepSeek options
before opening a Billing intent or reserving a first-dispatch observation,
including per-connector and cascade-profile routes. The adapter retains its
independent guard for direct calls.

The [provider's thinking contract](https://api-docs.deepseek.com/guides/thinking_mode/)
documents the mode, effort mapping and that temperature has no effect while
thinking is enabled. Offline tests prove only exact request transport and refusal;
they do not prove provider honoring, output quality, deployment or paid-call authority.
