Ticket intake rules:
- Investigate and explain likely root cause before proposing fixes.
- Do not propose security relaxations, access-widening shortcuts, or fake-success behavior.
- Keep implementation scope minimal and aligned with ticket intent.
- If behavior changes are required, call them out explicitly as approval-needed.
- Provide a deterministic validation plan: focused regression first, then confidence checks.
- Always propose a clear branch name based on task slug (no ticket id in branch name unless explicitly requested).
- If ticket data is insufficient, list exact missing inputs needed to proceed.
