import fp from "fastify-plugin"
import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg"
import type { FastifyInstance } from "fastify"
import { config } from "../config";

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

async function PrismaPlugin(app: FastifyInstance) {
    const adapter = new PrismaPg({connectionString: config.DATABASE_URL, connectionTimeoutMillis: 5000});

    const prisma = new PrismaClient({adapter});

    app.log.info("Database connected");

    // Attach to app instance -- accessible as app.prisma in all routes
    app.decorate("prisma", prisma);

    // Disconnect cleanly when server shuts down
    app.addHook("onClose", async () => {
        await prisma.$disconnect();
        app.log.info("Database disconnected");
    });
}

// make it register to fastify plugin system, so it can be used as app.register(PrismaPlugin)
export default fp(PrismaPlugin, { name: "prisma" });