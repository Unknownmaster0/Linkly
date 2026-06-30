import type { FastifyInstance } from "fastify";

// Docs only (see plugins/swagger.ts). /health is the one endpoint that does NOT
// use the { success, message, data } envelope — it returns a flat probe shape.
const healthSchema = {
  tags: ['Health'],
  summary: 'Liveness / readiness probe',
  description:
    'Returns a flat `{ status, db, timestamp }` shape (no success envelope) so ' +
    'monitoring probes can read it directly. 503 if dependencies are down.',
  response: {
    200: {
      description: 'Healthy',
      type: 'object',
      properties: {
        status: { type: 'string', example: 'ok' },
        db: { type: 'string', example: 'ok' },
        timestamp: { type: 'string', format: 'date-time' },
      },
    },
    503: {
      description: 'Degraded — a dependency is disconnected',
      type: 'object',
      properties: {
        error: { type: 'string', example: 'Service temporarily unavailable' },
      },
    },
  },
};

export async function healthCheckRoutes(app: FastifyInstance) {
    // GET /health — liveness + DB connectivity probe.
    //
    // Layer 3 rule: zero try-catch for DB logic. A connectivity failure
    // (Prisma P1001/P1017) is an *exceptional* failure — it bubbles to the
    // global error handler in app.ts, which maps it to a 503 carrying the
    // ERROR_CONTRACT envelope `{ error }`. We never catch it or hand-build an
    // error response here.
    app.get("/", { schema: healthSchema }, async (_request, reply) => {
        await app.prisma.$queryRaw`SELECT 1`;
        return reply.status(200).send({
            status: "ok",
            timestamp: new Date().toISOString(),
            db: "ok",
        });
    });
}
