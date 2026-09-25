import "dotenv/config";
import express from "express";
import { createServer } from "http";
import path from "node:path";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "../routers";
import { registerGoogleAuthRoutes } from "../formdigital/googleAuth";
import { registerLocalDataRoutes } from "../formdigital/localAssetRoutes";
import { isLocalOnlyMode, localOnlyRequestAllowed } from "../formdigital/localOnly";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";

async function startServer() {
  const app = express();
  const server = createServer(app);
  const port = parseInt(process.env.PORT || "3000");
  if (isLocalOnlyMode()) {
    app.use((request, response, next) => {
      const headers: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(request.headers))
        headers[key] = Array.isArray(value) ? value[0] : value;
      if (!localOnlyRequestAllowed({
        remoteAddress: request.socket.remoteAddress,
        host: request.get("host"),
        port,
        method: request.method,
        headers,
      })) {
        response.status(403).end();
        return;
      }
      response.setHeader("Content-Security-Policy", [
        "default-src 'self'",
        "connect-src 'self'",
        "script-src 'self' 'wasm-unsafe-eval'",
        "worker-src 'self' blob:",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "frame-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join("; "));
      next();
    });
  }
  const pdfjsAssetsRoot = path.resolve(
    import.meta.dirname,
    "../../node_modules/pdfjs-dist"
  );
  app.use("/pdfjs/cmaps", express.static(path.join(pdfjsAssetsRoot, "cmaps")));
  app.use(
    "/pdfjs/standard-fonts",
    express.static(path.join(pdfjsAssetsRoot, "standard_fonts"))
  );
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  registerLocalDataRoutes(app);
  if (isLocalOnlyMode())
    app.use("/api/auth/google", (_request, response) => response.sendStatus(404));
  else registerGoogleAuthRoutes(app);
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const host = "127.0.0.1";
  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") console.error(`Port ${port} is already in use. Please close the other local service and try again.`);
    else console.error(error);
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}

startServer().catch(console.error);
