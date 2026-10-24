/**
 * The OpenAPI 3.1 document for the member API (spec 095).
 *
 * THIS IS THE SPECIFICATION, and it is code rather than a checked-in YAML file for one reason:
 * a hand-maintained document drifts from the server, and the moment it does it is worse than
 * nothing — an agent generated from a stale spec fails at a member's request instead of at review.
 * Here the paths come from `contract.js`'s `ROUTES` (the same array `routes.js` mounts), the scopes
 * and error codes come from the same constants the handlers enforce, and the buildable-action enum
 * comes from `@fairwins/intent-types` itself. `test/memberApi.test.js` asserts the documented set
 * and the mounted set are equal, so the drift is a test failure rather than a support ticket.
 *
 * Interpolating config also lets the document describe THIS gateway: which chains it serves, which
 * of them have a wager indexer, which chain membership is read on, and whether the assistant is
 * configured. A generic document would force every client to discover those by trial.
 */
import { X402_ERROR_CODES, X402_GATEWAY_ERROR_CODES, X402_VERSION, buildRequirement, caip2 } from '../x402/requirements.js'
import { ALL_SCOPES, ERROR_CODES, ROUTES, SCOPE_DESCRIPTIONS, TOKEN_PREFIX } from './contract.js'
import { buildableActions, REFUSED_ACTIONS } from './intents.js'
import { MAX_BLOCKS_PER_MESSAGE, MAX_MESSAGES, MAX_MESSAGE_CHARS, MAX_REQUEST_CONTENT_CHARS, MAX_TOOL_RESULT_CHARS } from './assistant.js'
import { SURFACE_MAX_CHARS } from '@fairwins/assistant-contract/prompt'
import { ALLOWED_CONTENT_BLOCK_TYPES, TOOL_DEFS, TOOL_NAMES, toolsForMessages } from '@fairwins/assistant-contract/tools'

/** A `$ref` to one of the error responses defined once in `components.responses`. */
const errRef = (name) => ({ $ref: `#/components/responses/${name}` })

/**
 * Every code that can appear in a HOUSE error body here, including spec 096's.
 *
 * The x402 codes are merged for the SUMMARY lookup only — whether they appear in the published
 * `enum` is decided per-gateway below, so a deployment with the paid rail off serves a document
 * byte-identical to a pre-096 one.
 */
const ALL_ERROR_CODES = { ...ERROR_CODES, ...X402_GATEWAY_ERROR_CODES }

/** One `components.responses` entry: the shared error body plus the codes that can appear in it. */
function errorResponse(description, codes) {
  return {
    description,
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/ErrorBody' },
        examples: Object.fromEntries(
          codes.map((code) => [
            code,
            { summary: ALL_ERROR_CODES[code].summary, value: { error: { code, reason: ALL_ERROR_CODES[code].summary } } },
          ])
        ),
      },
    },
  }
}

/**
 * Build the document.
 *
 * @param {object} config full gateway config
 * @param {{assistantConfigured?: boolean}} [opts]
 */
export function buildOpenApiDocument(config, { assistantConfigured = false } = {}) {
  const memberApi = config.memberApi
  const indexedChainIds = config.enabledChainIds.filter((id) => Boolean(memberApi.subgraphUrls[id]))
  const actions = buildableActions()

  // Spec 096. EVERY x402 addition below is behind this flag, so a gateway with the paid rail off
  // publishes exactly the document it published before spec 096 existed — the specification must
  // describe THIS gateway, and advertising a 402 that can never happen is a lie an agent would
  // write retry code against.
  const x402Enabled = Boolean(config.x402?.enabled)
  const x402Chain = x402Enabled ? config.chains[config.x402.chainId] : null
  const pricedRoutes = x402Enabled ? ROUTES.filter((r) => r.opClass && buildRequirement(config, { opClass: r.opClass })) : []
  const errorCodeNames = x402Enabled
    ? [...Object.keys(ERROR_CODES), ...Object.keys(X402_GATEWAY_ERROR_CODES)]
    : Object.keys(ERROR_CODES)

  const doc = {
    openapi: '3.1.0',
    info: {
      title: 'FairWins Member API',
      version: '1.0.0',
      summary: 'Custody-free, member-signed programmatic access to a FairWins member’s own data and safe platform operations.',
      description: [
        '## What this API is',
        '',
        'A FairWins member can grant an agent or a script scoped, read-and-quote access to **their own**',
        'account. It is custody-free by construction: there is no endpoint here that moves value, and',
        'there is no credential here that could. The strongest thing a key can do is ask the gateway to',
        '**build unsigned EIP-712 typed data**, which the member then signs themselves.',
        '',
        '## How authentication works',
        '',
        'A key is a **member-signed capability token**, not a server-issued secret. The member signs an',
        '`ApiKeyGrant` (EIP-712, domain `FairWins Member API` v1, no chainId and no verifyingContract —',
        'the grant is chain-agnostic) in the FairWins app, and the token is:',
        '',
        '```',
        `${TOKEN_PREFIX}.<base64url(grantJSON)>.<base64url(signatureBytes)>`,
        '```',
        '',
        'sent as `Authorization: Bearer <token>`. `grantJSON` is',
        '`{ v: 1, account, keyId, scopes, issuedAt, expiresAt, label }`. `label` is display-only and is',
        '**not** part of the signed struct; `scopes` is signed as a single string — the scope list sorted',
        'ascending and joined with single spaces.',
        '',
        'The gateway stores **nothing** to issue a token. That is deliberate: this service holds no',
        'per-member state, so a server-side key table would be a durability claim it could not honour.',
        'The consequence is stated honestly everywhere it matters — see revocation below.',
        '',
        '## Three-state reads',
        '',
        'Every read that can fail resolves to one of `read` / `not-configured` / `unreadable`, and a value',
        'exists **only** in state `read`. A failed read is never serialised as `0`, `[]` or `false`: an',
        'unreachable indexer is not an empty wager list, and an unreadable membership is not the absence',
        'of one. A response missing part of what was asked for says so and **names** what is missing.',
        '',
        '## Errors',
        '',
        'Every error body is `{ "error": { "code", "reason" } }`. `429` carries `Retry-After`. Two codes',
        'are worth reading before you write retry logic:',
        '',
        '- `503 auth_unverifiable` — your signature could **not be checked**, because verifying a smart',
        '  account’s signature needs a chain read and the chain was unreachable. This is not a rejection.',
        '  Retry it; do not discard the key.',
        '- `503 membership_unreadable` — same shape one level up. Retry.',
        '',
        '## What this gateway serves',
        '',
        `- Enabled chains: ${config.enabledChainIds.join(', ') || 'none'}`,
        `- Chains with a wager indexer: ${indexedChainIds.join(', ') || 'none configured'}`,
        `- Membership reference chain: ${memberApi.referenceChainId}`,
        `- Maximum key lifetime: ${memberApi.maxTtlDays} days`,
        `- Assistant: ${assistantConfigured ? 'configured' : 'not configured (503 assistant_unconfigured)'}; tool rounds per turn: ${memberApi.assistant.maxRounds} (see \`x-fairwins-tools\`)`,
      ].join('\n'),
      license: { name: 'Proprietary', identifier: 'LicenseRef-FairWins' },
    },
    servers: [
      {
        url: '/',
        description:
          'This gateway, at whatever origin you reached it on. Browser clients must be on the gateway’s ' +
          'CORS allow-list; server-to-server clients reaching the public edge additionally need the ' +
          'platform’s edge header, which is injected in transit and is not a member credential.',
      },
    ],
    tags: [
      { name: 'discovery', description: 'Describes the API itself. No credential required.' },
      { name: 'identity', description: 'The token, the key, and the membership behind them.' },
      { name: 'reads', description: 'The member’s own data. Three-state, never fabricated.' },
      { name: 'build', description: 'Unsigned typed data for a platform action. Signing stays with the member.' },
      { name: 'assistant', description: 'Conversational help. Answers questions; never acts.' },
      ...(x402Enabled
        ? [
            {
              name: 'x402',
              description: [
                'Pay-per-request access, for an agent that holds no member key.',
                '',
                'A **priced** operation called without a usable member token answers `402` with a',
                'machine-readable offer. You pay by signing an EIP-3009 `TransferWithAuthorization` on',
                `${x402Chain?.tokenDomain?.name ?? 'the platform token'} (${x402Chain?.paymentToken}) to the`,
                'platform treasury and retrying with an `X-PAYMENT` header; the gateway verifies the',
                'authorization, settles it through its existing submission engine, and then serves the',
                'request **as the payer**.',
                '',
                'Four things are worth knowing before you build against this:',
                '',
                '1. **A working member token is never charged.** The bearer path is checked first; if your',
                '   token authenticates, no payment is asked for and none is possible. Paying substitutes',
                '   for MEMBERSHIP on one operation — it is not an alternative way to use a key you have.',
                '2. **Verification strictly precedes settlement.** A payment that fails any check is never',
                '   submitted, so a refused request costs you nothing. If settlement itself cannot happen',
                '   you get `503 settlement_unavailable` and *nothing is served and nothing is charged*.',
                '3. **`success` means broadcast, not finality.** `X-PAYMENT-RESPONSE` reports the settlement',
                '   the engine accepted, and says `settlement: "broadcast"` for exactly that reason.',
                '4. **The payer is screened.** Sanctions screening runs against `authorization.from`,',
                '   fail-closed, before anything settles — a `403 sanctioned_signer` is not re-quotable.',
                '',
                'Signatures must be **EOA (ECDSA)**. A smart-account (ERC-1271) signature would pass a',
                'server-side check and then revert at the token, so it is refused up front.',
              ].join('\n'),
            },
          ]
        : []),
    ],
    security: [{ memberToken: [] }],
    components: {
      securitySchemes: {
        memberToken: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: TOKEN_PREFIX,
          description: [
            'A member-signed capability token. Minted in the FairWins app (Settings → API access) by',
            'signing an `ApiKeyGrant`; the gateway verifies the signature on every request and keeps no',
            'copy of the key.',
            '',
            'Scopes are carried inside the signed grant, not negotiated per request:',
            '',
            ...ALL_SCOPES.map((s) => `- \`${s}\` — ${SCOPE_DESCRIPTIONS[s]}`),
            '',
            'Signature verification tries ECDSA recovery first and falls back to ERC-1271 on the',
            'membership reference chain, because a smart account (a passkey member) has no public key and',
            'only the account itself can say whether it stands behind the bytes.',
          ].join('\n'),
        },
      },
      schemas: {
        ErrorBody: {
          type: 'object',
          required: ['error'],
          additionalProperties: false,
          properties: {
            error: {
              type: 'object',
              required: ['code', 'reason'],
              additionalProperties: false,
              properties: {
                code: { type: 'string', enum: errorCodeNames, description: 'Machine-readable. Branch on this, never on the prose.' },
                reason: { type: 'string', description: 'A specific, actionable sentence. Safe to show a member.' },
              },
            },
          },
          example: { error: { code: 'insufficient_scope', reason: 'this key does not carry the "read:wagers" scope; mint a key that includes it' } },
        },
        Address: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$', examples: ['0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'] },
        Bytes32: { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' },
        Scope: { type: 'string', enum: ALL_SCOPES },
        UnixSeconds: { type: 'integer', minimum: 0, description: 'Unix timestamp in SECONDS (not milliseconds).' },
        MembershipRead: {
          type: 'object',
          required: ['state', 'chainId', 'role'],
          description:
            'Three states, and only one carries values. `not-configured` means this deployment records no ' +
            'membership contract on the reference chain, so the question cannot be asked here at all; ' +
            '`unreadable` means it was asked and the chain did not answer. NEITHER is a statement that the ' +
            'member has no membership, and neither may be rendered as tier 0.',
          properties: {
            state: { type: 'string', enum: ['read', 'not-configured', 'unreadable'] },
            chainId: { type: 'integer', description: 'The membership reference chain this was read on. Membership has one home per cohort.' },
            role: { type: 'string', const: 'WAGER_PARTICIPANT', description: 'The role that was read, named so a caller never has to reverse a keccak hash.' },
            tier: { type: 'integer', minimum: 0, maximum: 4, description: 'Present only when state is `read`. 0 means no active tier.' },
            tierName: { type: ['string', 'null'], enum: ['Bronze', 'Silver', 'Gold', 'Platinum', null], description: 'Present only when state is `read`. Null at tier 0 — the absence of a tier is not a tier.' },
            active: { type: 'boolean', description: 'Present only when state is `read`.' },
            expiresAt: { $ref: '#/components/schemas/UnixSeconds' },
            reason: { type: 'string', description: 'Present when state is `not-configured` or `unreadable`. Why no value is here.' },
          },
          examples: [
            { state: 'read', chainId: 137, role: 'WAGER_PARTICIPANT', tier: 3, tierName: 'Gold', active: true, expiresAt: 1800000000 },
            { state: 'unreadable', chainId: 137, role: 'WAGER_PARTICIPANT', reason: 'the membership contract could not be read; try again' },
          ],
        },
        RevocationState: {
          type: 'object',
          required: ['revoked', 'durable'],
          properties: {
            revoked: { type: 'boolean' },
            durable: {
              type: 'boolean',
              const: false,
              description:
                'Always false, and said out loud rather than implied. Revocations are held in this gateway ' +
                'process and do not survive a restart. What DOES bound a leaked key is the grant’s own ' +
                '`expiresAt`, which the member chose and this gateway caps.',
            },
          },
        },
        MeResponse: {
          type: 'object',
          required: ['account', 'keyId', 'scopes', 'issuedAt', 'expiresAt', 'membership', 'revocation'],
          properties: {
            account: { $ref: '#/components/schemas/Address' },
            keyId: { $ref: '#/components/schemas/Bytes32' },
            label: { type: ['string', 'null'], description: 'Display-only, taken from the token and NOT covered by the signature. Never trust it as authority.' },
            scopes: { type: 'array', items: { $ref: '#/components/schemas/Scope' } },
            issuedAt: { $ref: '#/components/schemas/UnixSeconds' },
            expiresAt: { $ref: '#/components/schemas/UnixSeconds' },
            membership: { $ref: '#/components/schemas/MembershipRead' },
            revocation: { $ref: '#/components/schemas/RevocationState' },
          },
        },
        RevokeRequest: {
          type: 'object',
          required: ['revocation', 'signature'],
          additionalProperties: false,
          properties: {
            revocation: {
              type: 'object',
              required: ['account', 'keyId', 'revokedAt'],
              additionalProperties: false,
              description: 'The `ApiKeyRevocation` struct, exactly as signed.',
              properties: {
                account: { $ref: '#/components/schemas/Address' },
                keyId: { $ref: '#/components/schemas/Bytes32' },
                revokedAt: { $ref: '#/components/schemas/UnixSeconds' },
              },
            },
            signature: { type: 'string', pattern: '^0x[0-9a-fA-F]+$', description: 'EIP-712 signature over `ApiKeyRevocation` under the `FairWins Member API` v1 domain.' },
          },
        },
        RevokeResponse: {
          type: 'object',
          required: ['revoked', 'durable', 'reason'],
          properties: {
            revoked: { type: 'boolean', const: true },
            durable: { type: 'boolean', const: false },
            reason: { type: 'string', description: 'Plain-language statement of exactly how long this revocation lasts.' },
          },
        },
        KeyStatusResponse: {
          type: 'object',
          required: ['account', 'keyId', 'revoked', 'durable'],
          properties: {
            account: { $ref: '#/components/schemas/Address' },
            keyId: { $ref: '#/components/schemas/Bytes32' },
            revoked: { type: 'boolean' },
            durable: { type: 'boolean', const: false },
          },
        },
        Wager: {
          type: 'object',
          required: ['id', 'chainId'],
          description: 'One wager as the chain’s indexer reported it. Unknown values are null — never 0 and never an empty string.',
          properties: {
            id: { type: 'string', description: 'On-chain wager id.' },
            chainId: { type: 'integer' },
            status: { type: ['string', 'null'], enum: ['open', 'active', 'draw_proposed', 'resolved', 'drawn', 'refunded', 'cancelled', 'declined', null] },
            resolutionType: { type: ['integer', 'null'] },
            creator: { type: ['string', 'null'] },
            opponent: { type: ['string', 'null'], description: 'Null while an open challenge has not been accepted.' },
            token: { type: ['string', 'null'] },
            creatorStake: { type: ['string', 'null'], description: 'Token base units as a DECIMAL STRING — these exceed the exact-integer range of a JSON number.' },
            opponentStake: { type: ['string', 'null'], description: 'Token base units as a decimal string.' },
            winner: { type: ['string', 'null'] },
            createdAt: { type: ['integer', 'null'], description: 'Unix seconds.' },
            resolvedAt: { type: ['integer', 'null'], description: 'Unix seconds; null while unresolved.' },
            metadataUri: { type: ['string', 'null'] },
            metadataHash: { type: ['string', 'null'] },
          },
        },
        ChainWagerResult: {
          type: 'object',
          required: ['chainId', 'state'],
          description:
            'THE THREE STATES ARE THE CONTRACT. `not-configured` means this gateway has no indexer for ' +
            'the chain — the question was never asked. `unreadable` means it was asked and failed. ' +
            'Neither is an empty result, and `wagers` is absent in both.',
          properties: {
            chainId: { type: 'integer' },
            state: { type: 'string', enum: ['read', 'not-configured', 'unreadable'] },
            wagers: { type: 'array', items: { $ref: '#/components/schemas/Wager' }, description: 'Present only when state is `read`.' },
            reason: { type: 'string', description: 'Present when state is `not-configured` or `unreadable`.' },
          },
        },
        WagersResponse: {
          type: 'object',
          required: ['account', 'chains', 'partial', 'asOf'],
          properties: {
            account: { $ref: '#/components/schemas/Address' },
            asOf: { type: 'string', format: 'date-time', description: 'When this gateway assembled the answer.' },
            chains: {
              type: 'object',
              additionalProperties: { $ref: '#/components/schemas/ChainWagerResult' },
              description: 'Keyed by chain id as a string.',
            },
            partial: {
              type: ['array', 'null'],
              items: { type: 'string' },
              description:
                'Chain ids that did NOT resolve to `read`, or null when every requested chain answered. ' +
                'If you aggregate across chains, a non-null value here means your total is incomplete — say so.',
            },
          },
        },
        FeeRate: {
          type: 'object',
          required: ['bps', 'capBps', 'source'],
          description:
            'ZERO IS A REAL RATE here — it means the service charges no fee at all and no fee line is ' +
            'shown. That is why an unreadable rate is `bps: null` with `source: "unreadable"` and never 0: ' +
            'the two would be indistinguishable in every UI that renders them.',
          properties: {
            bps: { type: ['integer', 'null'], description: 'Basis points, or null when the configured router could not be read.' },
            capBps: { type: 'integer', description: 'The hard ceiling this service can never exceed, from the same constant the reader clamps against.' },
            source: {
              type: 'string',
              enum: ['chain', 'env-fallback', 'unreadable'],
              description:
                '`chain` — the live FeeRouter value. `env-fallback` — no router is configured on this gateway, ' +
                'so its own default is served. `unreadable` — a router IS configured and could not be read.',
            },
          },
        },
        FeesResponse: {
          type: 'object',
          required: ['feeRouter', 'services', 'asOf'],
          description:
            'A view of the platform’s single fee source of truth (the on-chain FeeRouter), not a second ' +
            'one. Only services this gateway’s own reader can answer for appear; one it cannot read is ' +
            'ABSENT rather than guessed.',
          properties: {
            feeRouter: {
              type: 'object',
              required: ['address', 'chainId'],
              properties: {
                address: { type: ['string', 'null'], description: 'Null when no FeeRouter is configured — the gateway then serves its env fallbacks.' },
                chainId: { type: 'integer' },
              },
            },
            services: {
              type: 'object',
              additionalProperties: { $ref: '#/components/schemas/FeeRate' },
              description: 'Keyed by fee service id, e.g. `polymarket.taker`, `perps.hyperliquid.builder`.',
            },
            asOf: { type: 'string', format: 'date-time' },
          },
        },
        TypedData: {
          type: 'object',
          required: ['domain', 'types', 'primaryType', 'message'],
          description: 'An EIP-712 payload, ready to pass to `signTypedData`. Nothing here has been signed.',
          properties: {
            domain: { type: 'object', description: 'For an intent: name, version, chainId and the verifyingContract that will check the signature.' },
            types: { type: 'object', description: 'A single flat struct definition, keyed by primary type.' },
            primaryType: { type: 'string' },
            message: {
              type: 'object',
              description:
                'The struct’s fields. The actor field is already filled in with YOUR account and cannot be ' +
                'overridden. `nonce`, `validAfter` and `validBefore` are left for you: the nonce doubles as ' +
                'the relay’s uniqueness marker, and the validity window is your own consent to a deadline.',
            },
          },
        },
        BuildIntentRequest: {
          type: 'object',
          required: ['action', 'chainId'],
          additionalProperties: false,
          properties: {
            action: { type: 'string', enum: actions, description: 'The platform action to build typed data for.' },
            chainId: { type: 'integer', enum: config.enabledChainIds },
            params: {
              type: 'object',
              description:
                'The action’s own fields. The actor field is IGNORED if you send it — it is always forced ' +
                'to the token’s account, because this platform has no "on behalf of" model.',
            },
          },
        },
        BuildIntentResponse: {
          type: 'object',
          required: ['action', 'chainId', 'typedData', 'target', 'submitVia'],
          properties: {
            action: { type: 'string' },
            chainId: { type: 'integer' },
            authOnly: { type: 'boolean', description: 'True for actions carrying no action struct (pool joins) — the EIP-3009 authorization IS the intent.' },
            typedData: { $ref: '#/components/schemas/TypedData' },
            target: { $ref: '#/components/schemas/Address' },
            actorField: { type: 'string', description: 'Which message field holds the actor. It equals your account; a submitted intent whose recovered signer differs is rejected.' },
            intentClass: { type: 'string', enum: ['payment', 'signer-attributed'] },
            note: { type: 'string', description: 'Present when the action needs something beyond signing this one struct.' },
            submitVia: {
              type: 'object',
              required: ['relay', 'selfSubmit'],
              properties: {
                relay: { type: 'string', description: 'Where to POST the signed intent for gasless relay: the existing public /v1/intents.' },
                selfSubmit: { type: 'string', description: 'The always-available alternative. Relaying is optional; no action depends on this gateway being up.' },
              },
            },
          },
        },
        AssistantTextBlock: {
          type: 'object',
          required: ['type', 'text'],
          additionalProperties: false,
          properties: {
            type: { type: 'string', const: 'text' },
            text: { type: 'string', minLength: 1, maxLength: MAX_MESSAGE_CHARS },
          },
        },
        AssistantToolUseBlock: {
          type: 'object',
          required: ['type', 'id', 'name', 'input'],
          additionalProperties: false,
          description:
            'The model asking for a tool — copied back VERBATIM from a previous response’s `content`. Only an ' +
            'assistant message may carry one, and `name` must be a tool this gateway offers (see `x-fairwins-tools`).',
          properties: {
            type: { type: 'string', const: 'tool_use' },
            id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' },
            name: { type: 'string', enum: [...TOOL_NAMES] },
            input: { type: 'object', description: `The arguments the model chose. At most ${MAX_MESSAGE_CHARS} characters serialised.` },
          },
        },
        AssistantToolResultBlock: {
          type: 'object',
          required: ['type', 'tool_use_id', 'content'],
          additionalProperties: false,
          description:
            'Your answer to a tool_use, executed by YOU (the member API with your token, a public gateway read, ' +
            'or locally). Only a user message may carry one; it must answer a tool_use from the IMMEDIATELY ' +
            'preceding assistant message, and every tool_use there must be answered exactly once. A failed read ' +
            'is `is_error: true` with text that says the answer is UNKNOWN — never an empty result.',
          properties: {
            type: { type: 'string', const: 'tool_result' },
            tool_use_id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' },
            content: { type: 'string', maxLength: MAX_TOOL_RESULT_CHARS, description: `Truncate client-side above ${MAX_TOOL_RESULT_CHARS} characters and say so in the text.` },
            is_error: { type: 'boolean', default: false },
          },
        },
        AssistantChatRequest: {
          type: 'object',
          required: ['messages'],
          additionalProperties: false,
          description:
            'One ROUND of a client-side tool loop (spec 104). The gateway attaches the tool table itself — a ' +
            'request carrying `tools`, `system`, `tool_choice` or `model` is refused with 400 bad_request. ' +
            `At most ${MAX_REQUEST_CONTENT_CHARS} characters of content across the whole request.`,
          properties: {
            messages: {
              type: 'array',
              minItems: 1,
              maxItems: MAX_MESSAGES,
              items: {
                type: 'object',
                required: ['role', 'content'],
                additionalProperties: false,
                properties: {
                  role: { type: 'string', enum: ['user', 'assistant'] },
                  content: {
                    oneOf: [
                      { type: 'string', minLength: 1, maxLength: MAX_MESSAGE_CHARS },
                      {
                        type: 'array',
                        minItems: 1,
                        maxItems: MAX_BLOCKS_PER_MESSAGE,
                        items: {
                          oneOf: [
                            { $ref: '#/components/schemas/AssistantTextBlock' },
                            { $ref: '#/components/schemas/AssistantToolUseBlock' },
                            { $ref: '#/components/schemas/AssistantToolResultBlock' },
                          ],
                        },
                        description: `Content blocks. Allowed types: ${ALLOWED_CONTENT_BLOCK_TYPES.join(', ')}; anything else is refused.`,
                      },
                    ],
                  },
                },
              },
              description:
                'The conversation so far. The first AND last message must be from the user. Summarise older turns ' +
                'client-side rather than growing this array.',
            },
            surface: {
              type: 'string',
              maxLength: SURFACE_MAX_CHARS,
              description:
                'Optional: which screen the member is on. Appended by the gateway as a trailing text block on the ' +
                'last user message — never placed in the system prompt, which stays byte-identical across turns.',
            },
          },
        },
        AssistantChatResponse: {
          type: 'object',
          required: ['reply', 'content', 'stopReason', 'model', 'usage'],
          properties: {
            reply: {
              type: 'string',
              description:
                'The concatenated text of this round. AI-generated — verify before acting on it. EMPTY when ' +
                '`stopReason` is `tool_use`: the model asked for a tool instead of answering, and the answer is in ' +
                '`content`. The assistant never signs or submits anything.',
            },
            content: {
              type: 'array',
              items: { oneOf: [{ $ref: '#/components/schemas/AssistantTextBlock' }, { $ref: '#/components/schemas/AssistantToolUseBlock' }] },
              description:
                'The model’s content blocks, text and tool_use only. To continue the loop, append an assistant ' +
                'message with exactly this array, then a user message whose tool_result blocks answer every tool_use.',
            },
            stopReason: {
              type: ['string', 'null'],
              description: '`end_turn` (render `reply`), `tool_use` (execute `content`’s tool_use blocks and send another round), `max_tokens`, or another provider value.',
            },
            model: { type: 'string' },
            usage: {
              type: 'object',
              properties: {
                inputTokens: { type: ['integer', 'null'] },
                outputTokens: { type: ['integer', 'null'] },
              },
              description: 'Counts only, for THIS round. Message content is never logged or stored by this gateway.',
            },
          },
        },
        ...(x402Enabled
          ? {
              PaymentRequirement: {
                type: 'object',
                required: ['scheme', 'network', 'amount', 'asset', 'payTo', 'maxTimeoutSeconds', 'extra'],
                description: 'One way this gateway will accept payment for the operation you asked for.',
                properties: {
                  scheme: { type: 'string', const: 'exact', description: 'Pay exactly `amount`. This gateway offers no other scheme.' },
                  network: { type: 'string', description: 'CAIP-2, e.g. `eip155:137`.', examples: [caip2(config.x402.chainId)] },
                  amount: { type: 'string', description: 'Token BASE UNITS as a decimal string — 10000 is $0.01 of a 6-decimal USDC.' },
                  asset: { $ref: '#/components/schemas/Address' },
                  payTo: { $ref: '#/components/schemas/Address' },
                  maxTimeoutSeconds: { type: 'integer', description: 'How long this offer is worth acting on.' },
                  extra: {
                    type: 'object',
                    required: ['assetTransferMethod', 'name', 'version'],
                    description:
                      'What you need to build the signature. `name`/`version` are the TOKEN’s own EIP-712 ' +
                      'domain fields — sign under `{ name, version, chainId, verifyingContract: asset }`.',
                    properties: {
                      assetTransferMethod: { type: 'string', const: 'eip3009' },
                      name: { type: 'string' },
                      version: { type: 'string' },
                    },
                  },
                },
              },
              PaymentRequired: {
                type: 'object',
                required: ['x402Version', 'error', 'resource', 'accepts'],
                description: 'The x402 v2 PaymentRequired body. This is the PROTOCOL’s shape, not the gateway’s error body.',
                properties: {
                  x402Version: { type: 'integer', const: X402_VERSION },
                  error: {
                    type: 'string',
                    enum: [...Object.keys(X402_ERROR_CODES), 'invalid_token', 'invalid_signature', 'token_expired', 'token_ttl_exceeded', 'token_revoked', 'membership_required'],
                    description:
                      'Why you are seeing this. `payment_required` means nothing was presented; a ' +
                      '`payment_*` code names the one thing wrong with what you did present; an auth code ' +
                      '(e.g. `token_expired`) means your TOKEN did not admit the request and payment is ' +
                      'offered instead — the diagnostic is kept rather than replaced.',
                  },
                  errorReason: { type: 'string', description: 'The same fact as a sentence. Show this; branch on `error`.' },
                  resource: {
                    type: 'object',
                    required: ['url', 'description', 'mimeType'],
                    properties: {
                      url: { type: 'string' },
                      description: { type: 'string' },
                      mimeType: { type: 'string' },
                    },
                  },
                  accepts: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/PaymentRequirement' },
                    description: 'Always an array. Empty only if the operation stopped being offered between your two requests.',
                  },
                },
              },
              PaymentPayload: {
                type: 'object',
                required: ['x402Version', 'accepted', 'payload'],
                description:
                  'What you base64-encode into the `X-PAYMENT` header. `accepted` is the `accepts[]` entry ' +
                  'you chose; the gateway checks your choice against its OWN offer, so editing it cannot ' +
                  'produce a cheaper price.',
                properties: {
                  x402Version: { type: 'integer', const: X402_VERSION },
                  accepted: { $ref: '#/components/schemas/PaymentRequirement' },
                  payload: {
                    type: 'object',
                    required: ['signature', 'authorization'],
                    properties: {
                      signature: { type: 'string', pattern: '^0x[0-9a-fA-F]{130}$', description: '65-byte EOA signature over `TransferWithAuthorization`.' },
                      authorization: {
                        type: 'object',
                        required: ['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce'],
                        properties: {
                          from: { $ref: '#/components/schemas/Address' },
                          to: { $ref: '#/components/schemas/Address' },
                          value: { type: 'string', description: 'Base units, decimal string. Must be >= the offer’s amount.' },
                          validAfter: { type: 'string', description: 'Unix seconds, decimal string. Must already have passed.' },
                          validBefore: { type: 'string', description: `Unix seconds. Must be at least ${config.x402.settleBufferSeconds}s in the future, or settlement could not complete.` },
                          nonce: { $ref: '#/components/schemas/Bytes32' },
                        },
                      },
                    },
                  },
                },
              },
              SettlementResponse: {
                type: 'object',
                required: ['success', 'transaction', 'network', 'payer', 'amount', 'settlement'],
                description: 'base64-decoded `X-PAYMENT-RESPONSE`. Present only on a request a payment paid for.',
                properties: {
                  success: { type: 'boolean', const: true },
                  transaction: { type: ['string', 'null'], description: 'Transaction hash, or null if the engine has not assigned one yet.' },
                  transactionId: { type: 'string', description: 'The engine’s own id for the submission.' },
                  network: { type: 'string' },
                  payer: { $ref: '#/components/schemas/Address' },
                  amount: { type: 'string' },
                  settlement: {
                    type: 'string',
                    const: 'broadcast',
                    description:
                      'Said out loud: the engine ACCEPTED this settlement, which is not the same as a chain ' +
                      'having mined it. Do not read `success: true` as finality.',
                  },
                },
              },
            }
          : {}),
      },
      responses: {
        ...(x402Enabled
          ? {
              PaymentRequired: {
                description:
                  'This operation is priced and you presented no usable member token. The body describes ' +
                  'what would be accepted; sign one entry of `accepts` and retry with `X-PAYMENT`. Nothing ' +
                  'has been charged.',
                content: { 'application/json': { schema: { $ref: '#/components/schemas/PaymentRequired' } } },
              },
            }
          : {}),
        Unauthorized: errorResponse(
          'The token is missing, malformed, expired, over the lifetime cap, revoked, or not signed by the account it ' +
            'names. Note `invalid_signature` is a KNOWN negative — the account was asked and declined; when it could ' +
            'not be asked the answer is 503 auth_unverifiable instead.',
          ['invalid_token', 'invalid_signature', 'token_expired', 'token_ttl_exceeded', 'token_revoked']
        ),
        Forbidden: errorResponse(
          'The token is valid but this request is not permitted.',
          ['insufficient_scope', 'membership_required', 'sanctioned_signer', 'origin_denied']
        ),
        BadRequest: errorResponse(
          'The request body or query is malformed, or the action cannot be built on this deployment. ' +
            '`unsupported_action` always states WHY — a deliberately refused action, an unknown one, or a contract ' +
            'this gateway does not have pinned on the named chain.',
          ['bad_request', 'unsupported_action']
        ),
        TooManyRequests: {
          description: 'Per-account or global quota exceeded. `Retry-After` names the wait in seconds.',
          headers: { 'Retry-After': { schema: { type: 'integer' }, description: 'Seconds to wait before retrying.' } },
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorBody' }, example: { error: { code: 'quota_exceeded', reason: 'signer member API quota exceeded; retry shortly' } } } },
        },
        AssistantTooManyRequests: {
          ...errorResponse(
            'Two different ceilings, and an agent should branch on which one it hit. `quota_exceeded` counts ' +
              'REQUESTS — the assistant has its own, tighter request class than the module\'s reads. ' +
              '`assistant_budget_exhausted` counts TOKENS, which is what is actually billed; it means the model ' +
              'budget for this account or for this gateway is spent for the window. Neither ever arrives as a ' +
              'truncated answer: an exhausted budget refuses the turn outright rather than shortening it.',
            ['quota_exceeded', 'assistant_budget_exhausted']
          ),
          headers: { 'Retry-After': { schema: { type: 'integer' }, description: 'Seconds to wait before retrying.' } },
        },
        Unavailable: errorResponse(
          'Temporarily unavailable — RETRY. None of these is a rejection: `auth_unverifiable` and ' +
            '`membership_unreadable` in particular mean a fact could not be established, not that it was ' +
            'established against you.',
          [
            'member_api_unconfigured',
            'member_api_killed',
            'killswitch_active',
            'auth_unverifiable',
            'membership_unreadable',
            'screening_unavailable',
            'upstream_unavailable',
            ...(x402Enabled ? ['settlement_unavailable'] : []),
          ]
        ),
        AssistantUnavailable: errorResponse(
          'Everything the shared 503 covers, plus the two assistant-specific states: the assistant is ' +
            'switched off or has no model credential, or the model provider could not be reached. An ' +
            'unreachable assistant is reported as such — never as a blank or invented reply.',
          ['assistant_unconfigured', 'assistant_unavailable', 'member_api_unconfigured', 'member_api_killed', 'killswitch_active', 'auth_unverifiable', 'membership_unreadable', 'screening_unavailable']
        ),
      },
    },
    paths: {},
    // Spec 104. The assistant's tool table, in the Messages-API shape the gateway attaches, with
    // each tool's authorization class and scope — the SAME table `@fairwins/assistant-contract`
    // holds and the MCP server vendors, so a generic client can discover it here. `auth: 'grant'`
    // tools appear in a conversation only when the token carries `scope`; `none` tools are public
    // gateway reads; `local` tools run in the member's browser and this gateway never serves them.
    'x-fairwins-tools': toolsForMessages(TOOL_DEFS).map((t) => {
      const def = TOOL_DEFS.find((d) => d.name === t.name)
      return { ...t, auth: def.auth, scope: def.scope }
    }),
    'x-fairwins-assistant': {
      maxRounds: memberApi.assistant.maxRounds,
      maxMessages: MAX_MESSAGES,
      maxMessageChars: MAX_MESSAGE_CHARS,
      maxToolResultChars: MAX_TOOL_RESULT_CHARS,
      maxRequestContentChars: MAX_REQUEST_CONTENT_CHARS,
      maxBlocksPerMessage: MAX_BLOCKS_PER_MESSAGE,
    },
  }

  // ---- paths, derived from the SAME array routes.js mounts ------------------------------------
  const common = {
    401: errRef('Unauthorized'),
    403: errRef('Forbidden'),
    429: errRef('TooManyRequests'),
    503: errRef('Unavailable'),
  }
  const okJson = (description, schemaRef) => ({
    description,
    content: { 'application/json': { schema: { $ref: `#/components/schemas/${schemaRef}` } } },
  })

  /** Per-route response + parameter detail, keyed by the route id `contract.js` declares. */
  const DETAIL = {
    openapi: {
      tags: ['discovery'],
      security: [],
      responses: {
        200: { description: 'This document.', content: { 'application/json': { schema: { type: 'object' } } } },
        503: errRef('Unavailable'),
      },
    },
    me: { tags: ['identity'], responses: { 200: okJson('The token, and what stands behind it.', 'MeResponse'), ...common } },
    revoke: {
      tags: ['identity'],
      security: [],
      requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/RevokeRequest' } } } },
      responses: {
        200: okJson('The revocation was registered on this gateway — for as long as this process lives.', 'RevokeResponse'),
        400: errRef('BadRequest'),
        401: errRef('Unauthorized'),
        429: errRef('TooManyRequests'),
        503: errRef('Unavailable'),
      },
    },
    keyStatus: {
      tags: ['identity'],
      parameters: [
        { name: 'keyId', in: 'query', required: true, schema: { $ref: '#/components/schemas/Bytes32' }, description: 'The key to ask about. Must belong to the presented token’s account.' },
        { name: 'account', in: 'query', required: false, schema: { $ref: '#/components/schemas/Address' }, description: 'Optional and must equal the token’s own account if sent — this endpoint never answers about somebody else.' },
      ],
      responses: { 200: okJson('Whether that key is revoked here.', 'KeyStatusResponse'), 400: errRef('BadRequest'), ...common },
    },
    membership: { tags: ['reads'], responses: { 200: okJson('A three-state membership read on the reference chain.', 'MembershipRead'), ...common } },
    wagers: {
      tags: ['reads'],
      parameters: [
        {
          name: 'chainId',
          in: 'query',
          required: false,
          schema: { type: 'integer', enum: config.enabledChainIds },
          description: 'One chain. Omit to ask every enabled chain — each answers independently.',
        },
        { name: 'first', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 }, description: 'Page size per chain, newest first.' },
      ],
      responses: { 200: okJson('A per-chain envelope. Read `state` before reading `wagers`.', 'WagersResponse'), 400: errRef('BadRequest'), ...common },
    },
    fees: { tags: ['reads'], responses: { 200: okJson('Live platform fee rates and where each came from.', 'FeesResponse'), ...common } },
    buildIntent: {
      tags: ['build'],
      requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/BuildIntentRequest' } } } },
      responses: {
        200: okJson('Unsigned typed data, plus where to send it once you have signed it.', 'BuildIntentResponse'),
        400: errRef('BadRequest'),
        ...common,
      },
    },
    assistantChat: {
      tags: ['assistant'],
      requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/AssistantChatRequest' } } } },
      responses: {
        200: okJson('The assistant’s answer, with token counts. Content is never logged.', 'AssistantChatResponse'),
        400: errRef('BadRequest'),
        401: errRef('Unauthorized'),
        403: errRef('Forbidden'),
        429: errRef('AssistantTooManyRequests'),
        503: errRef('AssistantUnavailable'),
      },
    },
  }

  // ---- spec 096: the priced operations, and only those ----------------------------------------
  // An `X-PAYMENT` parameter, a 402 response and an `X-PAYMENT-RESPONSE` header are added to a route
  // ONLY when this gateway would actually price it. A route documented as 402-able on a deployment
  // that never answers 402 sends an agent down a branch that cannot execute.
  const pricedIds = new Set(pricedRoutes.map((r) => r.id))
  const paymentParameter = {
    name: 'X-PAYMENT',
    in: 'header',
    required: false,
    schema: { type: 'string' },
    description:
      'base64(JSON `PaymentPayload`). Send this to pay for the request after a 402. Omitted with a ' +
      'valid member token — a token that authenticates is never charged.',
  }
  const paymentResponseHeader = {
    'X-PAYMENT-RESPONSE': {
      schema: { type: 'string' },
      description:
        'base64(JSON `SettlementResponse`) — present only when a payment paid for this response. Reports ' +
        'the settlement the engine ACCEPTED (`settlement: "broadcast"`), not a mined transaction.',
    },
  }

  for (const route of ROUTES) {
    const detail = DETAIL[route.id]
    if (!detail) throw new Error(`[relay-gateway] member-API route "${route.id}" has no OpenAPI detail`)
    const priced = pricedIds.has(route.id)
    const priceAmount = priced ? buildRequirement(config, { opClass: route.opClass }).amount : null
    const operation = {
      operationId: route.operationId,
      summary: route.summary,
      description:
        route.description +
        (route.scope ? `\n\nRequires scope \`${route.scope}\`.` : '') +
        (priced
          ? `\n\nAlso available **without a member key** for \`${priceAmount}\` base units of ` +
            `\`${x402Chain.paymentToken}\` on \`${caip2(config.x402.chainId)}\` — see the \`x402\` tag. ` +
            'A working member token is never charged for this.'
          : ''),
      ...(route.scope ? { security: [{ memberToken: [route.scope] }], 'x-fairwins-scope': route.scope } : {}),
      ...detail,
      ...(priced
        ? {
            tags: [...detail.tags, 'x402'],
            'x-fairwins-x402-op-class': route.opClass,
            parameters: [...(detail.parameters ?? []), paymentParameter],
            responses: {
              ...detail.responses,
              // Merge into the 200 rather than replacing it: the header is additional information
              // about the SAME success, not a different one.
              200: { ...detail.responses[200], headers: { ...(detail.responses[200]?.headers ?? {}), ...paymentResponseHeader } },
              402: errRef('PaymentRequired'),
            },
          }
        : {}),
    }
    doc.paths[route.path] ??= {}
    doc.paths[route.path][route.method] = operation
  }

  // Actions that exist on the platform but are deliberately NOT buildable here. Documented rather
  // than hidden: an agent that cannot find `invalidateNonce` should learn WHY, not conclude the
  // platform has no cancel path.
  doc.info.description += [
    '',
    '',
    '## Actions this API will not build',
    '',
    ...Object.entries(REFUSED_ACTIONS).map(([action, reason]) => `- \`${action}\` — ${reason}`),
  ].join('\n')

  // Spec 096. Appended only when the paid rail is live on THIS gateway.
  if (x402Enabled) {
    doc.info.description += [
      '',
      '',
      '## Paying per request (x402)',
      '',
      'Some operations here can be bought one call at a time by an agent with **no member key**, using',
      `the x402 v${X402_VERSION} protocol. This does not replace a key — it replaces MEMBERSHIP, for one`,
      'operation. If your bearer token works, you are served on it and never charged.',
      '',
      `- Settled on \`${caip2(config.x402.chainId)}\` in \`${x402Chain.paymentToken}\` (${x402Chain.tokenDomain.name} v${x402Chain.tokenDomain.version})`,
      `- Paid to \`${config.x402.payTo}\``,
      ...pricedRoutes.map(
        (r) => `- \`${r.method.toUpperCase()} ${r.path}\` — ${buildRequirement(config, { opClass: r.opClass }).amount} base units (${r.opClass})`
      ),
      '',
      'Everything else on this API is **not** purchasable. Reading this document is free, and so is',
      'revoking a key — putting a price between a member and the withdrawal of a leaked credential',
      'would be the worst place on this API to put one.',
    ].join('\n')
  }

  return doc
}

/** Route ids the document describes — the drift test compares this with what routes.js mounts. */
export function documentedPaths(doc) {
  return Object.entries(doc.paths)
    .flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`))
    .sort()
}
