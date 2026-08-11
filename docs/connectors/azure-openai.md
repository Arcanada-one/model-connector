# Azure OpenAI

The `azure-openai` connector targets Microsoft's classic deployment-scoped Chat Completions data-plane API. Configure `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT`, and either `AZURE_OPENAI_API_KEY` or inject an `AzureOpenAiTokenProvider`. `AZURE_OPENAI_API_VERSION` defaults to the GA dated version `2024-10-21`.

Each request uses `/openai/deployments/{deployment}/chat/completions?api-version={date}` with both path and query values URL-encoded. An injected Entra provider is called for every request and sends `Authorization: Bearer`; key authentication sends `api-key`. Configuration may be injected through `AzureOpenAiConnectorOptions` or supplied through the documented environment variables. The authentication modes are mutually exclusive and ambiguous dual configuration fails before any request. The configured deployment is the connector's deterministic model identity; no account-level model discovery call is made.

Primary references: [Azure OpenAI REST API](https://learn.microsoft.com/en-us/azure/foundry/openai/reference) and [Microsoft Entra token provider](https://learn.microsoft.com/en-us/azure/developer/ai/get-started-securing-your-ai-app).
