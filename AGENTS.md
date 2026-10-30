# Standalone Meet maintenance

- This repository is a standalone browser app, not the Cloudragon platform deployment repository. Never copy production credentials, database contents, private signing keys, existing APKs, or unrelated service sources into it.
- Authentication is deliberately local to this installation. Do not replace it with an anonymous bypass or trust client workspace headers. A future OIDC adapter must authenticate on the server and preserve ownership checks.
- Keep server credentials out of browser bundles and responses. Keep fixed provider endpoints, Origin/CSRF/Host checks, bounded input/output, and secret-free errors. Do not add arbitrary HTTP proxy endpoints or tool execution to AI calls.
- Preserve raw transcripts, revision conflict checks, contiguous chunk completion, durable local recovery, and explicit discard intent. AI correction must not replace original text. In-flight jobs must not resurrect deleted meetings or overwrite newer edits.
- Run `npm test`, `npm run build`, `npm run check:secrets`, and browser tests for affected flows. Keep the lockfile, setup instructions and validation limitations accurate. Do not claim a synthetic test is a live provider/device test.
- Share source changes through this repository. Changing or deploying the original production platform, Storage, Money, DNS, TLS or system services is outside the scope of a standalone release.
