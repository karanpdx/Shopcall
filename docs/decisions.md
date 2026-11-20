# Confirmed implementation scope

- Delivery target: working hackathon demo first.
- Storefront must genuinely be generated and published by Replit.
- No template deployment fallback.
- Shopcall must automatically create and publish the Replit app; operator-assisted publication is insufficient.
- One authenticated demo merchant; public self-service signup is outside initial scope.
- User reports Replit and ElevenLabs access ready. ElevenLabs onboarding and read-only agent-list SDK request passed on November 20, 2026; list returned zero agents. No agent or browser conversation has been verified. Replit backend OAuth/build/publication remains unverified.

# Integration gates

- Prove Replit OAuth, tool discovery, app creation, build readiness, publication, and anonymous URL verification.
- Codex-side Replit authentication can verify account access, but does not establish backend OAuth or automatic publication.
- Prove an ElevenLabs browser voice call and typed tool invocation.
- Store catalog outside generated frontend; subsequent camera-off call must update the same public URL without rebuilding.

# Reference

Requirements input: `/Users/kazuma/Downloads/storefront_call_agent_build_spec.md`.
Document defaults and suggested work division remain proposals unless accepted or selected during implementation.
