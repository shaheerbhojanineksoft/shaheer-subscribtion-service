/**
 * OpenAPI 3 specification for the subscription service.
 *
 * Served at GET /openapi.json and browsed at GET /docs (Swagger UI).
 */
export const openapi = {
  openapi: '3.0.3',
  info: {
    title: 'Traderverse Subscription & Entitlement Service API',
    version: '1.0.0',
    description:
      'Bun-based subscription service backed by Stripe (billing source of truth) and MongoDB ' +
      '(local subscription state).\n\n' +
      '### Core rules\n' +
      '- One MongoDB document per Stripe subscription; multiple subscriptions per email are allowed.\n' +
      '- Entitlement is resolved from **only the newest** subscription (strict rule, no fallback).\n' +
      '- Stripe webhooks are signature-verified and idempotent.\n' +
      '- Subscription documents carry `email` — **no `userId`** at this stage.',
  },
  servers: [
    { url: 'http://localhost:3000', description: 'Local development' },
  ],
  tags: [
    { name: 'Health', description: 'Liveness checks' },
    { name: 'Checkout', description: 'Create Stripe Checkout sessions' },
    { name: 'Entitlement', description: 'Resolve a customer\'s current authority' },
  ],
  paths: {
    '/health': {
      get: {
        tags: ['Health'],
        summary: 'Liveness probe',
        description: 'Returns `{ "status": "ok" }` when the service is up.',
        operationId: 'getHealth',
        responses: {
          200: {
            description: 'Service is healthy',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { status: { type: 'string', example: 'ok' } } },
              },
            },
          },
        },
      },
    },

    '/subscriptions/checkout': {
      post: {
        tags: ['Checkout'],
        summary: 'Create a Stripe Checkout session',
        description:
          'Validates the email and the plan enum (`basic` | `pro` | `enterprise`), resolves the ' +
          'configured Stripe price for the requested billing interval, then creates a Stripe ' +
          'Checkout session (`mode=subscription`, quantity 1). Returns the hosted Checkout URL to ' +
          'redirect the customer to.\n\n' +
          'Clients send a plan NAME — never Stripe price ids. Unknown plans/intervals are rejected (400).',
        operationId: 'createCheckoutSession',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CheckoutRequest' },
              example: {
                email: 'user@example.com',
                plan: 'pro',
                billingInterval: 'month',
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Checkout session created — redirect the customer to `url`',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CheckoutResponse' },
              },
            },
          },
          400: {
            description: 'Validation failed (invalid email or disallowed Price ID)',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
          500: {
            description: 'Unexpected server error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
        },
      },
    },

    '/subscriptions/entitlement': {
      get: {
        tags: ['Entitlement'],
        summary: 'Resolve effective entitlement for an email',
        description:
          'Returns the customer\'s current authority using the **strict newest-subscription rule**:\n' +
          '- Only the newest subscription is considered.\n' +
          '- If the newest is inactive/expired → `active: false` (never falls back to an older one).\n' +
          '- If active → returns the plan config with its permissions.',
        operationId: 'getEntitlement',
        parameters: [
          {
            name: 'email',
            in: 'query',
            required: true,
            description: 'Customer email (application-level user reference).',
            schema: { type: 'string', format: 'email', example: 'user@example.com' },
          },
        ],
        responses: {
          200: {
            description: 'Effective entitlement resolved',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/EntitlementResult' },
              },
            },
          },
          400: {
            description: 'Missing/invalid email query parameter',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
        },
      },
    },
  },

  components: {
    schemas: {
      CheckoutRequest: {
        type: 'object',
        required: ['email', 'plan'],
        properties: {
          email: {
            type: 'string',
            format: 'email',
            description: 'Customer email. Used as the subscription\'s application-level reference (no userId at this stage).',
            example: 'user@example.com',
          },
          plan: {
            type: 'string',
            enum: ['basic', 'pro', 'enterprise'],
            description: 'Plan name from the allowed enum. The backend resolves the Stripe Product/Price.',
            example: 'pro',
          },
          billingInterval: {
            type: 'string',
            enum: ['month', 'year'],
            default: 'month',
            description: 'Billing interval (optional, defaults to \"month\").',
            example: 'month',
          },
        },
      },

      CheckoutResponse: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Stripe Checkout Session id.', example: 'cs_test_...' },
          url: { type: 'string', format: 'uri', description: 'Hosted Checkout URL — redirect the customer here.', example: 'https://checkout.stripe.com/c/pay/cs_test_...' },
          email: { type: 'string', example: 'user@example.com' },
          plan: { type: 'string', enum: ['basic', 'pro', 'enterprise'], example: 'pro' },
          billingInterval: { type: 'string', enum: ['month', 'year'], example: 'month' },
          productId: { type: 'string', description: 'Stripe Product (plan) id — resolved by the backend.', example: 'prod_VDskx9YEWVcWlm' },
          priceId: { type: 'string', description: 'Stripe Price id — resolved by the backend.', example: 'price_1UDQylGuLSLkQ7qaRtHzfICm' },
        },
      },

      EntitlementResult: {
        type: 'object',
        properties: {
          email: { type: 'string', example: 'user@example.com' },
          active: { type: 'boolean', description: 'Whether the customer currently has authority.', example: true },
          reason: {
            type: 'string',
            enum: ['no_subscriptions', 'newest_inactive', 'unknown_plan', 'active'],
            description: 'Why the entitlement is active/inactive.',
          },
          plan: { type: 'string', nullable: true, enum: ['basic', 'pro', 'enterprise'], example: 'pro' },
          productId: { type: 'string', nullable: true },
          config: {
            type: 'object',
            nullable: true,
            description: 'Plan permissions (present only when active).',
            properties: {
              canCreatePost: { type: 'boolean', example: true },
              maxPosts: { type: 'integer', description: '-1 = unlimited.', example: 100 },
            },
          },
          subscriptionId: { type: 'string', nullable: true, description: 'stripeSubscriptionId of the newest subscription.' },
          subscription: {
            $ref: '#/components/schemas/Subscription',
            description: 'The newest subscription document (when one exists).',
          },
        },
      },

      Subscription: {
        type: 'object',
        description: 'MongoDB subscription document (application representation of Stripe state).',
        properties: {
          _id: { type: 'string', description: 'MongoDB document id.' },
          email: { type: 'string', description: 'Customer email (no userId at this stage).' },
          stripeCustomerId: { type: 'string' },
          stripeSubscriptionId: { type: 'string', description: 'Stripe subscription id (unique).' },
          productId: { type: 'string' },
          priceId: { type: 'string' },
          plan: { type: 'string', nullable: true, enum: ['basic', 'pro', 'enterprise'] },
          billingInterval: { type: 'string', nullable: true, example: 'month' },
          status: {
            type: 'string',
            enum: ['trialing', 'active', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused'],
          },
          currentPeriodStart: { type: 'string', format: 'date-time', nullable: true },
          currentPeriodEnd: { type: 'string', format: 'date-time', nullable: true },
          cancelAtPeriodEnd: { type: 'boolean' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },

      Error: {
        type: 'object',
        properties: {
          error: { type: 'string', description: 'Human-readable error message.', example: 'Invalid or disallowed Price ID' },
        },
      },
    },
  },
} as const;

export type OpenApiSpec = typeof openapi;
