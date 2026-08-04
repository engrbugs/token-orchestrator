# Privacy Policy

Token Orchestrator is local-first. It processes AI-tool usage logs on the device and does not send analytics or telemetry to the project maintainer. The project does not operate a hosted data-collection service.

## Network features

Token Orchestrator makes network requests only for documented or user-enabled features:

- Packaged builds check GitHub Releases for updates.
- Exchange-rate and service-status views fetch their public data sources.
- Enabled AI Tool Limits integrations contact the corresponding provider. Credentials are sent only to that provider.
- Discord Rich Presence sends the selected activity details to Discord when explicitly enabled.
- The desktop widget does not upload usage data to a Token Orchestrator service.

These requests are processed under the privacy policy of the service receiving them, including the [GitHub Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement) for update checks and the [Discord Privacy Policy](https://discord.com/privacy) for Rich Presence. Review the applicable provider's privacy policy before enabling a provider-backed integration.

The legacy command-line hub and agent remain in the repository for compatibility,
but the desktop widget no longer starts or connects to them.
