# Obsidian 1.13.4 client protocol delta

Obsidian 1.13.4 is the current candidate above the preserved 1.12.7
compatibility floor. Its reviewed baseline retains the same Sync operations,
outbound message shapes, sharing routes, and owned/shared-vault model.

The material control-plane addition is `POST /user/pow-challenge`. Static
inspection places it in the upstream account-signup flow; normal sign-in does
not depend on it. Blackglass Server deliberately returns its stable
administrator-managed-account error because self-service signup remains out of
scope. The route is recognized so the stock client receives JSON and correct
CORS behavior instead of an accidental 404.

The baseline also records additional occurrences of existing account helpers.
Those count changes are release-specific evidence and do not alter the server
contract. Promotion from candidate to qualified requires the complete packaged
client E2E gate, not only static baseline checks.
